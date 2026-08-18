// The model's half of the risk analysis: it judges candidate paths this code proposed.
//
// The division of labour is the whole design. Code decides what MIGHT be a path - a capability
// present on a unit, a role passable somewhere in the same policy, a store the pipeline itself
// reads - and hands over a numbered list. The model answers six questions about each candidate and
// writes the sentence an approver reads. It never enumerates AWS, never invents a path, and never
// cites an action that is not in the grant it was given.
//
// What that buys, concretely: a hallucinated attack path cannot survive, because a path this code
// did not propose has no candidate id to attach to and is dropped, and a cited action that is not
// byte-identical to a member of the grant's action list is a fabrication the whole run is discarded
// for. The model's freedom is bounded to five fields - category, proposed grade, title, narrative,
// and its six answers - and every other field of a finding is computed here.
//
// Where it runs: on the dashboard host, through Amazon Bedrock, under the instance profile. The
// dashboard already reads the assessment; this sends a condensed form of it to a model and reads
// text back. It reaches no account, starts no task, and writes nothing. Every model is reached the
// same way - Bedrock's Converse API, authorised by bedrock:InvokeModel on bedrock-runtime, through
// the configured inference profile. See opt-stack-dashboard-host.yaml and converse.js.

import { createHash } from 'node:crypto';

import { OUTCOME, candidates as proposeCandidates } from './candidatePaths.js';
import { CAP } from './capabilities.js';
import { RULES } from './rules.js';

export class AnalysisError extends Error {}

/** Bumped when the shape of a stored analysis changes, so an old record is not read as a new one. */
export const ANALYSIS_VERSION = 1;

/**
 * How many candidates go in one request.
 *
 * Not one request per candidate: the frame, the deployment block and the digest are identical
 * across a run, so batching lets all of it be read from cache and paid for once. Not one request
 * for all of them either - the answer is the output, and sixty narratives in one response is where
 * a truncated answer starts costing verdicts. A failed batch loses its own candidates and no more.
 */
const BATCH = 10;

/**
 * The ceiling a model-proposed grade is held to, by where the path ends.
 *
 * The model proposes and this caps. Grade inflation is the failure mode a language model has by
 * default on security text - everything is critical - and a ceiling derived from the OUTCOME the
 * edge already established is a bound that does not depend on the model agreeing to it. Both
 * numbers are kept: proposedGrade is what it said, grade is what stands, and capped says so.
 */
const CEILING = {
  [OUTCOME.CREDENTIALS_OF]: 'CRITICAL',
  [OUTCOME.CODE_EXECUTION_AS]: 'CRITICAL',
  [OUTCOME.CONTROL_PLANE_WRITE]: 'CRITICAL',
  [OUTCOME.AUDIT_BLIND]: 'HIGH',
  [OUTCOME.DATA_EGRESS]: 'HIGH',
  [OUTCOME.NETWORK_EXPOSURE]: 'MEDIUM',
  [OUTCOME.AVAILABILITY_DENIAL]: 'MEDIUM',
};

const GRADE_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4 };

/** The answer shape. Nothing outside this may be authored by the model. */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate_id: { type: 'string' },
          // Q1. False means the candidate is not a path, and no finding is produced from it.
          real: { type: 'boolean' },
          // Q2. Whether an operator could cause it without meaning to.
          human_error: { type: 'boolean' },
          // Q3. Creating something new, or altering something that exists. They are different
          // incidents: one appears as an unfamiliar resource, the other as a familiar one behaving
          // differently, and only the second has a blast radius already attached to it.
          mechanism: { type: 'string',
                       enum: ['new_resource', 'existing_resource', 'both', 'neither'] },
          // Q4. What has to already be true. Empty means nothing does.
          preconditions: { type: 'array', items: { type: 'string' } },
          // Q5.
          final_impact: { type: 'string' },
          // Q6. False means the evidence given does not settle it, and the finding is recorded as
          // not assessable rather than as confirmed.
          evidence_sufficient: { type: 'boolean' },
          // The citation contract: every action this verdict rests on, by name, from the candidate.
          cited_actions: { type: 'array', items: { type: 'string' } },
          category: { type: 'string',
                      enum: ['ESCALATION', 'EXPOSURE', 'RECON', 'DESTRUCTIVE'] },
          proposed_grade: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          title: { type: 'string' },
          narrative: { type: 'string' },
        },
        required: ['candidate_id', 'real', 'human_error', 'mechanism', 'preconditions',
                   'final_impact', 'evidence_sufficient', 'cited_actions', 'category',
                   'proposed_grade', 'title', 'narrative'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

/**
 * The frame. Byte-frozen: nothing interpolated, nothing dated, nothing per-deployment.
 *
 * It is the first cache breakpoint, so a single changed byte here costs the cache on every
 * subsequent block. That is also why the rule catalogue below is rendered from RULES rather than
 * typed out - the rules file is hashed into the approval record, and a rule change SHOULD move this
 * prefix and be paid for once.
 */
function frame() {
  const outcomes = Object.values(OUTCOME).map((o) => `  - ${o}`).join('\n');
  const capabilities = Object.values(CAP).map((c) => `  - ${c}`).join('\n');
  const rules = RULES.map((r) => `  ${r.id} [${r.category}/${r.escalationGrade}] ${r.title}`)
    .join('\n');

  return `You are judging candidate attack paths in an AWS permission grant, for a human who has to
approve or refuse that grant. You are one half of the analysis. The other half is deterministic code
that has already read the assessment, worked out which capabilities each granted action carries, and
proposed every candidate path the evidence supports. Your job is to judge those candidates. It is
not to find new ones.

Answer six questions about each candidate:

  1. Is it a real, executable path? An action being granted is not the same as a path existing.
  2. Could an operator cause it by mistake, without intending an attack?
  3. Does it create a new resource, or alter one that already exists? They are different incidents.
  4. What has to already be true for it to work?
  5. What is the final impact?
  6. Is the evidence you were given sufficient to settle questions 1 to 5?

Rules you work under:

CITATION. Every action you name must be copied byte for byte from the candidate you are judging -
same case, same service prefix, no abbreviation, no reconstruction from memory. You may not name an
action that does not appear in the candidate's steps or in its also_granted list. An action you
believe should be there but cannot find is a reason to answer question 6 with false, never a reason
to write the name yourself. A single fabricated action name invalidates the entire analysis.

NO NEW PATHS. If you see something the candidates do not cover, say so in the narrative of the
closest candidate. Do not answer about a candidate id you were not given; it will be discarded.

NO NAMES. Judge and describe using resource TYPES, counts, and the control-plane labels you are
given. Never build an argument on a resource name, an ARN, or a tag: the same table is called
something else in the next account, and an inference from a name inverts silently there. Sample
ARNs are given to you as evidence that resources exist and to be counted - not as a description of
what they are for. Do not put an ARN or a resource name in a narrative.

NO GRADE FROM A NAME, AND NO IMPACT FROM AN UNKNOWN. The asset half of the grade is computed from
this deployment's configuration, not by you. Do not describe the scale of damage to a resource whose
purpose you were not told.

RESERVATIONS ARE FACTS. Each candidate may carry reservations - the assessment could not prove the
actions are on the same resource, the resource list was truncated, an action's resource type was
guessed. A reservation is not a hedge to be talked past. If a reservation undermines the path,
question 1 or question 6 is false.

WHAT YOU AUTHOR. Exactly five things: the category, the proposed grade, the title, the narrative,
and your six answers. Status, restrictability, target lists, the asset grade and the final grade are
computed from your answers and from the assessment; do not try to state them.

Outcome vocabulary, where a path ENDS:
${outcomes}

Capability vocabulary, what an action CAN do:
${capabilities}

The deterministic rules have already fired separately and their findings are shown to the approver
alongside yours. They are listed here so you do not repeat them as if they were your discovery, and
so you can say when a candidate is the same path one of them names:
${rules}

Write the narrative in Korean. Two to four sentences. State the path, the precondition that matters
most, and the impact. No preamble, no restatement of the question, no recommendation about whether
to approve - that is the reader's decision and they have information you do not.`;
}

const FRAME = frame();
/** The prompt version, hashed from the frame's bytes. Recorded on every approval. */
export const PROMPT_VERSION = `v${ANALYSIS_VERSION}-${createHash('sha256').update(FRAME).digest('hex').slice(0, 12)}`;

/** What this deployment's own machinery is, and what the analysis could not have seen. */
function deployment(digest) {
  const cp = digest.control_plane ?? {};
  return `This deployment's own resources are identified by configuration, never by name. Where a
candidate carries a control_plane entry, the label states what that resource does in the governance
pipeline, and the basis states how it was recognised: 'configured' means this deployment is
configured with that exact name, 'declared' means an operator named the ARN outright, and 'prefix'
means only that the name is in a namespace this pipeline issues - which is weaker evidence and may
not carry an argument on its own.

A write to the governance machinery is not the same kind of finding as a write to a workload: it
changes what gets approved rather than what an application does. Say so when it applies.

Declared EC2 instances: ${cp.declared_instances ?? 0}. ${cp.note ?? ''}

The assessment enumerated one account. A pipeline component deployed in another account cannot
appear in any candidate, and its absence is not evidence that it is out of reach.`;
}

/** The digest, as the model receives it. Serialised once per run and shared by every batch. */
function assessment(digest) {
  return `<assessment_digest>\n${JSON.stringify(digest)}\n</assessment_digest>`;
}

function batchBlock(batch) {
  return `<candidates>\n${JSON.stringify(batch, null, 1)}\n</candidates>\n\n`
    + `Judge these ${batch.length} candidates. Answer for every one, including the ones you find `
    + 'are not paths - a rejected candidate is an answer the approver needs.';
}

/**
 * The request for one batch.
 *
 * Cache breakpoints, in render order (tools, then system, then messages):
 *   1. the frame            - identical for every assessment in every deployment
 *   2. the deployment block - identical for every assessment in THIS deployment
 *   3. the digest           - identical for every batch of THIS assessment
 * The batch itself carries no marker: it differs every request, and marking it would write a cache
 * entry per batch that nothing ever reads.
 */
export function request(digest, batch, { model, maxTokens = 16000 }) {
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: VERDICT_SCHEMA },
    },
    system: [
      { type: 'text', text: FRAME, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: deployment(digest), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: assessment(digest), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: batchBlock(batch) },
      ],
    }],
  };
}

/** Split into batches, deterministically, in candidate order. */
export function batches(list, size = BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Every action name a grant makes citable: the ones the digest carries BY NAME. */
function citableOf(digest) {
  const byPolicy = new Map();
  for (const grant of digest.grants ?? []) {
    byPolicy.set(grant.p, {
      actions: new Set([...(grant.risk_actions ?? []), ...(grant.non_restrictable ?? [])]),
      completeServices: new Set(grant.complete_services ?? []),
      name: grant.name,
      nonRestrictable: new Set(grant.non_restrictable ?? []),
      isBaseline: grant.is_baseline === true,
    });
  }
  return byPolicy;
}

/** Resource names that may not appear in a narrative: the tail of every ARN the digest sampled. */
function forbiddenNames(digest) {
  const out = new Set();
  for (const grant of digest.grants ?? []) {
    for (const unit of grant.units ?? []) {
      for (const arn of [...(unit.sample ?? []), ...(unit.cp ?? []).map((c) => c.arn)]) {
        out.add(arn);
        const tail = String(arn).split(/[:/]/).pop();
        // Short tails are not names worth checking - a two-character segment matches prose.
        if (tail && tail.length >= 6) out.add(tail);
      }
    }
  }
  return out;
}

/**
 * Check every verdict against the evidence it was given.
 *
 * Three outcomes, and the difference between them matters:
 *   accepted   - the verdict cites only actions the grant carries, and names a candidate that exists
 *   dropped    - something is wrong with this verdict alone. It is discarded, with the reason, and
 *                the count is reported. Never repaired: a repaired verdict is one nobody wrote.
 *   fabricated - an action name that belongs to no granted service at all. The model invented an
 *                AWS action, which says the whole answer was produced from memory rather than from
 *                the evidence, so the RUN is discarded rather than this verdict.
 */
export function validate(verdicts, { candidates, digest }) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const citable = citableOf(digest);
  const forbidden = forbiddenNames(digest);
  const accepted = [];
  const dropped = [];
  const fabricated = [];

  for (const verdict of verdicts ?? []) {
    const candidate = byId.get(verdict.candidate_id);
    if (!candidate) {
      dropped.push({ id: verdict.candidate_id ?? '(none)',
                     why: 'names a candidate that was not proposed' });
      continue;
    }
    const grant = citable.get(candidate.policy_id);
    if (!grant) {
      dropped.push({ id: verdict.candidate_id, why: 'names a policy that is not in the assessment' });
      continue;
    }

    // The candidate's own actions first: this is the tightest set, and a verdict resting on
    // something outside it is reasoning the evidence does not support.
    const offered = new Set([
      ...(candidate.steps ?? []).flatMap((s) => s.actions),
      ...(candidate.also_granted ?? []).flatMap((s) => s.actions),
    ]);

    let bad = null;
    for (const action of verdict.cited_actions ?? []) {
      if (offered.has(action)) continue;
      if (grant.actions.has(action)) {
        // Granted, but not part of THIS candidate. A weaker objection: the model reached across the
        // grant rather than making something up.
        bad = bad ?? { why: `cites ${action}, which the grant holds but this candidate does not` };
        continue;
      }
      const service = String(action).split(':')[0];
      if (grant.completeServices.has(service)) {
        // The service is granted whole, so the action is genuinely permitted - but the digest folded
        // its name away, which means nothing here can confirm the name is a real AWS action. Not a
        // fabrication, and not usable as a citation either.
        bad = bad ?? { why: `cites ${action}, which is inside a wholly granted service but was not `
                            + 'carried by name, so the name cannot be confirmed' };
        continue;
      }
      fabricated.push({ id: verdict.candidate_id, action });
      bad = bad ?? { why: `cites ${action}, which is not granted anywhere in this assessment` };
    }
    if ((verdict.cited_actions ?? []).length === 0) {
      bad = bad ?? { why: 'cites no action at all' };
    }
    if (bad) {
      dropped.push({ id: verdict.candidate_id, ...bad });
      continue;
    }

    const leaked = [...forbidden].find((name) => String(verdict.narrative ?? '').includes(name));
    if (leaked) {
      dropped.push({ id: verdict.candidate_id,
                     why: `the narrative names a resource (${leaked}), which a judgement may not `
                          + 'rest on and a narrative may not contain' });
      continue;
    }

    accepted.push({ verdict, candidate, grant });
  }

  return { accepted, dropped, fabricated };
}

/** The status a verdict earns. The model answers; this decides. */
function statusOf(verdict, candidate, digest) {
  const blockedBy = [];
  if (!verdict.evidence_sufficient) {
    blockedBy.push('the model reports the evidence does not settle this path');
  }
  for (const reservation of candidate.reservations ?? []) blockedBy.push(reservation);
  if ((digest.coverage?.actions_unbounded ?? []).length) {
    blockedBy.push('the assessment reports actions it could not bound, so no action list is complete');
  }
  if (!verdict.evidence_sufficient) return { status: 'NOT_ASSESSABLE', blockedBy };
  if (blockedBy.length) return { status: 'UNVERIFIED', blockedBy };
  return { status: 'CONFIRMED', blockedBy };
}

/** A finding from an accepted verdict. Everything not authored by the model is computed here. */
function findingOf({ verdict, candidate, grant }, digest) {
  const ceiling = CEILING[candidate.outcome] ?? 'MEDIUM';
  const proposed = verdict.proposed_grade;
  const grade = GRADE_ORDER[proposed] < GRADE_ORDER[ceiling] ? ceiling : proposed;
  const { status, blockedBy } = statusOf(verdict, candidate, digest);

  // The asset axis, from configuration only - the same rule findings.js follows. A prefix hit is a
  // match against a name and may not move it.
  const evidence = (candidate.control_plane ?? [])
    .filter((hit) => hit.basis === 'configured' || hit.basis === 'declared');

  return {
    id: candidate.id,
    source: 'model',
    edge: candidate.edge,
    outcome: candidate.outcome,
    category: verdict.category,
    title: verdict.title,
    narrative: verdict.narrative,
    escalationGrade: grade,
    proposedGrade: proposed,
    capped: grade !== proposed,
    assetImpactGrade: evidence.length ? 'CRITICAL' : 'UNDETERMINED',
    assetEvidence: evidence,
    status,
    blockedBy,
    policyName: grant.name,
    policyId: candidate.policy_id,
    isBaseline: grant.isBaseline,
    // The six answers, kept as answers rather than folded into prose. An approver reading a card
    // wants question 3 by itself.
    humanError: verdict.human_error,
    mechanism: verdict.mechanism,
    preconditions: verdict.preconditions ?? [],
    finalImpact: verdict.final_impact,
    evidenceSufficient: verdict.evidence_sufficient,
    triggerActions: verdict.cited_actions,
    restrictable: !verdict.cited_actions.some((a) => grant.nonRestrictable.has(a)),
    targets: candidate.target
      ? [{ type: candidate.target.type, count: candidate.target.count,
           scope: candidate.target.scope, sample: candidate.target.sample ?? [],
           sampleComplete: candidate.target.sample_complete !== false,
           controlPlane: candidate.control_plane ?? [] }]
      : [],
    // A targetless candidate reaches nothing that exists, so completeness of an enumeration is not
    // a question about it - and null says unknown, which is the honest answer either way (T-6).
    truncated: candidate.target ? candidate.target.truncated ?? null : null,
    relatedTo: [],
  };
}

/**
 * Ask the model about every candidate, and keep what survives validation.
 *
 * client is anything with messages.create/messages.stream - the Bedrock client in production, a
 * stub in the tests. Nothing here reaches the network directly, which is what makes the validation
 * above testable at all.
 */
export async function analyse({ digest, client, model, candidates = null, maxTokens = 16000,
                                batchSize = BATCH, onProgress = null }) {
  if (!digest) throw new AnalysisError('no digest to analyse');
  if (!client) throw new AnalysisError('no model client configured');
  if (!model) throw new AnalysisError('no model id configured');

  const list = candidates ?? proposeCandidates(digest);
  const groups = batches(list, batchSize);

  const verdicts = [];
  const failures = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const [index, batch] of groups.entries()) {
    const body = request(digest, batch, { model, maxTokens });
    try {
      const message = client.messages.stream
        ? await client.messages.stream(body).finalMessage()
        : await client.messages.create(body);
      const text = (message.content ?? []).find((block) => block.type === 'text')?.text;
      if (!text) throw new AnalysisError('the answer carried no text block');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        // Constrained decoding should make this impossible. If it happens the batch is lost and
        // said to be lost - a repaired parse is a verdict nobody wrote.
        throw new AnalysisError(`the answer was not the JSON the schema required: ${error.message}`);
      }
      verdicts.push(...(parsed.verdicts ?? []));
      const u = message.usage ?? {};
      usage.input += u.input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    } catch (error) {
      failures.push({ batch: index + 1, candidates: batch.map((c) => c.id),
                      why: error.message ?? String(error) });
    }
    if (onProgress) onProgress({ batch: index + 1, of: groups.length });
  }

  const { accepted, dropped, fabricated } = validate(verdicts, { candidates: list, digest });

  // The one failure that discards everything. A fabricated action name is not a mistake about this
  // path - it says the answer was written from memory rather than from the evidence, and there is
  // no way to tell which of the other verdicts were written the same way.
  if (fabricated.length) {
    return {
      analysis_version: ANALYSIS_VERSION,
      prompt_version: PROMPT_VERSION,
      model_id: model,
      impact_sha256: digest.meta?.source_impact_sha256 ?? null,
      rules_sha256: digest.meta?.rules_sha256 ?? null,
      discarded: {
        why: 'an answer cited AWS actions that are granted nowhere in this assessment, so the run '
          + 'was produced from memory rather than from the evidence and none of it can be trusted',
        fabricated,
      },
      findings: [],
      rejected: [],
      dropped,
      failures,
      candidates: list.length,
      usage,
    };
  }

  const findings = [];
  const rejected = [];
  for (const entry of accepted) {
    if (entry.verdict.real === false) {
      // Kept, deliberately. "The code proposed this and the model says it is not a path, for this
      // reason" is a result, and an approver who cannot see it cannot tell a clean grant from an
      // analysis that never ran.
      rejected.push({
        id: entry.candidate.id,
        edge: entry.candidate.edge,
        outcome: entry.candidate.outcome,
        policyId: entry.candidate.policy_id,
        policyName: entry.grant.name,
        title: entry.verdict.title,
        why: entry.verdict.narrative,
        citedActions: entry.verdict.cited_actions,
      });
      continue;
    }
    findings.push(findingOf(entry, digest));
  }

  findings.sort((a, b) =>
    (GRADE_ORDER[a.escalationGrade] ?? 9) - (GRADE_ORDER[b.escalationGrade] ?? 9)
    || a.id.localeCompare(b.id, undefined, { numeric: true }));

  return {
    analysis_version: ANALYSIS_VERSION,
    prompt_version: PROMPT_VERSION,
    model_id: model,
    impact_sha256: digest.meta?.source_impact_sha256 ?? null,
    rules_sha256: digest.meta?.rules_sha256 ?? null,
    findings,
    rejected,
    // Not a footnote. A run that answered four candidates out of sixty is a different answer from a
    // run that answered sixty, and the page says which one it was looking at.
    dropped,
    failures,
    candidates: list.length,
    answered: accepted.length,
    usage,
    findings_sha256: sha256Of(findings),
  };
}

/** The digest of what the approver was shown, for the approval record. */
export function sha256Of(findings) {
  return createHash('sha256').update(JSON.stringify(findings)).digest('hex');
}

/**
 * Whether a model id names an Anthropic model.
 *
 * The id carries the provider, with an optional routing prefix in front of it:
 *
 *     anthropic.claude-sonnet-5        the bare model
 *     us.anthropic.claude-sonnet-5     a regional inference profile
 *     global.amazon.nova-pro-v1:0      not Anthropic
 *
 * So the test is on the provider segment rather than on "contains anthropic" - a customer profile
 * called anthropic-eval pointing at Nova would otherwise be told it supports Anthropic-only
 * parameters, and the failure would be a 400 about a field rather than anything naming the model.
 */
export function isAnthropicModel(model) {
  const parts = String(model ?? '').split('.');
  return parts[0] === 'anthropic' || (parts.length > 1 && parts[1] === 'anthropic');
}

/**
 * The Bedrock client, imported lazily. One path, for every model.
 *
 * It was two: @anthropic-ai/bedrock-sdk for Anthropic models and Converse for the rest. That
 * shipped and every batch came back
 *
 *     400 Malformed input request: #: extraneous key [output_config] is not permitted
 *
 * because the request this analysis builds is a first-party Anthropic Messages request, and
 * InvokeModel on bedrock-runtime validates a narrower body than that. A wire probe had shown the
 * SDK PASSING output_config through untouched, which is a different claim from Bedrock accepting
 * it, and the difference is the whole of that failure.
 *
 * Converse takes a schema as a tool and is the same shape for every model, so there is now nothing
 * per-provider except which optional fields ride along - and those are dropped on a 400 rather than
 * assumed. One request shape also means one thing to be wrong about, which is the point: the
 * validation that makes a model's answer usable must not have a branch for who answered.
 *
 * Lazily because the analysis is optional: a deployment that has not enabled it should not fail to
 * start over a package it never calls, and the tests must exercise every line above without one.
 */
export async function bedrockClient({ region, model, onDegrade = null }) {
  const { bedrockConverse } = await import('./converse.js');
  // No keys. The instance profile is the credential, and the SDK resolves it through the default
  // AWS provider chain - the same chain the S3 client on this host already uses.
  return bedrockConverse({ region, onDegrade });
}

// The model's half, and every way an answer is refused.
//
// No network. The client is a stub, which is the point: what makes a language model usable in an
// approval path is not the answer it gives but the set of answers this code will not accept, and
// that set has to be testable without Bedrock.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidates } from './candidatePaths.js';
import {
  ANALYSIS_VERSION, PROMPT_VERSION, analyse, batches, request, validate,
} from './riskAnalysis.js';

const ACCOUNT = '718100330247';
const MODEL = 'us.anthropic.claude-sonnet-4-6';

function unit(type, actions, riskActions, over = {}) {
  const total = over.n ?? 3;
  return {
    t: type,
    n: total,
    scope: '*',
    colocation: 'sound',
    attribution: 'resource_type',
    sensitive: 0,
    truncated: false,
    omitted: null,
    // Names long enough to be names. The leak check below ignores tails under six characters
    // because a two-character segment matches ordinary prose, so a fixture using 'r0' would test
    // the threshold rather than the rule.
    sample: Array.from({ length: Math.min(total, 8) },
                       (_, i) => `arn:aws:${type.split(':')[0]}:us-east-1:${ACCOUNT}:${type.split(':')[1]}/report-writer-${i}`),
    sample_complete: total <= 8,
    cp: [],
    acts: actions.map((a) => riskActions.indexOf(a)).filter((i) => i >= 0),
    folded: 0,
    reads: 0,
    ...over,
  };
}

function digestOf(riskActions, units, over = {}) {
  return {
    digest_version: 1,
    meta: { account_id: ACCOUNT, source_impact_sha256: 'i'.repeat(64), rules_sha256: 'r'.repeat(64) },
    protected_actions: [],
    passrole_grants: [],
    control_plane: { declared_instances: 0, note: 'only resources in the assessed account appear' },
    grants: [{
      p: 'P1',
      name: 'arn:aws:iam::aws:policy/Test',
      source: 'aws_managed',
      is_baseline: false,
      restrictable: true,
      unreadable: null,
      as_written: riskActions,
      complete_services: over.complete_services ?? [],
      risk_actions: riskActions,
      non_restrictable: over.non_restrictable ?? [],
      units,
    }],
    coverage: { complete: true, policies_unreadable: [], actions_unbounded: [], actions_unresolved: [] },
    ...over,
  };
}

/** A stub client. Returns the same verdict list for every batch, or throws when told to. */
function stub(reply, { failOn = [], text = null } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(body) {
        calls.push(body);
        if (failOn.includes(calls.length)) throw new Error('the model was unreachable');
        const batchIds = [...JSON.stringify(body.messages[0].content[1].text)
          .matchAll(/C\d+/g)].map((m) => m[0]);
        const verdicts = typeof reply === 'function' ? reply(batchIds) : reply;
        return {
          content: [{ type: 'thinking', thinking: 'considered' },
                    { type: 'text', text: text ?? JSON.stringify({ verdicts }) }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900,
                   cache_creation_input_tokens: 0 },
        };
      },
    },
  };
}

const CONTAINMENT = {
  deny_actions: ['lambda:UpdateFunctionCode'],
  breaks: '이 함수들에 대한 코드 배포가 막힌다.',
  blocked_elsewhere: false,
};

/**
 * The containment block for a verdict that cites something other than the default actions.
 *
 * Kept as a helper rather than written out at each site because deny_actions has to be a subset of
 * that same verdict's cited_actions - a verdict that proposes denying an action it never cited is
 * rejected, and a fixture that drifts from that rule fails as an empty findings list rather than as
 * the thing it was testing.
 */
const contain = (actions) => ({ ...CONTAINMENT, deny_actions: actions });

const VERDICT = {
  real: true,
  containment: CONTAINMENT,
  human_error: false,
  mechanism: 'existing_resource',
  preconditions: [],
  final_impact: '역할의 자격 증명으로 코드가 실행된다.',
  evidence_sufficient: true,
  category: 'ESCALATION',
  proposed_grade: 'CRITICAL',
  title: '실행 코드 교체를 통한 역할 승계',
  narrative: '함수의 코드를 교체한 뒤 호출하면 이미 부여된 역할로 코드가 실행된다.',
};

// A grant that produces the run-existing candidate: MODIFY_CODE and INVOKE on one unit.
const ACTIONS = ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'];
const SIMPLE = digestOf(ACTIONS, [unit('lambda:function', ACTIONS, ACTIONS)]);

// ---- the prompt -------------------------------------------------------------------------------

test('the request carries three cache breakpoints, and the batch carries none', () => {
  // Render order is tools, then system, then messages. The frame is identical everywhere, the
  // deployment block is identical for this deployment, the digest is identical for this assessment,
  // and the batch differs every request - so marking the batch would write a cache entry per batch
  // that nothing ever reads.
  const list = candidates(SIMPLE);
  const body = request(SIMPLE, list, { model: MODEL });
  assert.equal(body.system.length, 2);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral' });
  const content = body.messages[0].content;
  assert.equal(content.length, 2);
  assert.deepEqual(content[0].cache_control, { type: 'ephemeral' });
  assert.equal(content[1].cache_control, undefined);
  // Bedrock has no automatic caching, so these explicit breakpoints are the only caching there is.
  assert.equal(body.model, MODEL);
  assert.equal(body.output_config.format.type, 'json_schema');
  // No thinking asked for, deliberately. The schema travels as a forced tool call and Bedrock
  // refuses that beside enabled thinking - "Thinking may not be enabled when tool_choice forces
  // tool use" came back on every batch of a deployed run. Of the two the schema is what makes an
  // answer checkable, so it is the one that stays.
  assert.equal('thinking' in body, false, 'the request asks for thinking it cannot have');
});

test('the frame is byte-identical across assessments and deployments', () => {
  // The first breakpoint. One interpolated byte here - a timestamp, an account id - and the cache
  // misses on every block after it, which is all of them.
  const other = digestOf(['ec2:TerminateInstances'],
                         [unit('ec2:instance', ['ec2:TerminateInstances'], ['ec2:TerminateInstances'])],
                         { meta: { account_id: '999999999999' } });
  const a = request(SIMPLE, candidates(SIMPLE), { model: MODEL });
  const b = request(other, candidates(other), { model: 'anthropic.claude-sonnet-4-6' });
  assert.equal(a.system[0].text, b.system[0].text);
  assert.ok(PROMPT_VERSION.startsWith(`v${ANALYSIS_VERSION}-`));
  assert.equal(PROMPT_VERSION.length, `v${ANALYSIS_VERSION}-`.length + 12);
});

test('the frame states the citation contract and forbids new paths and names', () => {
  const { text } = request(SIMPLE, candidates(SIMPLE), { model: MODEL }).system[0];
  for (const clause of ['CITATION', 'NO NEW PATHS', 'NO NAMES', 'RESERVATIONS ARE FACTS',
                        'WHAT YOU AUTHOR']) {
    assert.ok(text.includes(clause), `the frame lost the ${clause} clause`);
  }
  // The rule catalogue is listed so the model does not present a rule's finding as its own.
  assert.ok(text.includes('E-1'));
  assert.ok(text.includes('D-5'));
});

test('batching is deterministic and covers every candidate exactly once', () => {
  const list = Array.from({ length: 25 }, (_, i) => ({ id: `C${i + 1}` }));
  const groups = batches(list, 10);
  assert.deepEqual(groups.map((g) => g.length), [10, 10, 5]);
  assert.deepEqual(groups.flat().map((c) => c.id), list.map((c) => c.id));
});

// ---- validation: what an answer may rest on ---------------------------------------------------

test('a verdict citing the candidate own actions is accepted', () => {
  const list = candidates(SIMPLE);
  const target = list.find((c) => c.edge === 'run-existing');
  assert.ok(target, 'the fixture no longer produces the run-existing candidate');
  const { accepted, dropped, fabricated } = validate(
    [{ ...VERDICT, candidate_id: target.id, cited_actions: ACTIONS }],
    { candidates: list, digest: SIMPLE },
  );
  assert.equal(accepted.length, 1);
  assert.deepEqual(dropped, []);
  assert.deepEqual(fabricated, []);
});

test('an action the grant holds but this candidate does not is dropped, not called a fabrication', () => {
  // The model reached across the grant instead of answering about the candidate. Wrong, and a
  // different kind of wrong from inventing an action - so it costs this verdict and nothing else.
  const actions = [...ACTIONS, 'ec2:TerminateInstances'];
  const d = digestOf(actions, [unit('lambda:function', ACTIONS, actions),
                               unit('ec2:instance', ['ec2:TerminateInstances'], actions)]);
  const list = candidates(d);
  const target = list.find((c) => c.edge === 'run-existing');
  const { accepted, dropped, fabricated } = validate(
    [{ ...VERDICT, candidate_id: target.id,
       cited_actions: [...ACTIONS, 'ec2:TerminateInstances'] }],
    { candidates: list, digest: d },
  );
  assert.equal(accepted.length, 0);
  assert.equal(fabricated.length, 0);
  assert.ok(dropped[0].why.includes('the grant holds but this candidate does not'));
});

test('an action inside a wholly granted service that was folded away cannot be cited', () => {
  // The action IS granted - lambda:* covers it - but the digest folded the name, so nothing here
  // can confirm the name is a real AWS action. Not a fabrication, and not usable as evidence.
  const d = digestOf(ACTIONS, [unit('lambda:function', ACTIONS, ACTIONS)],
                     { complete_services: ['lambda'] });
  const list = candidates(d);
  const target = list.find((c) => c.edge === 'run-existing');
  const { accepted, dropped, fabricated } = validate(
    [{ ...VERDICT, candidate_id: target.id,
       cited_actions: [...ACTIONS, 'lambda:PutFunctionConcurrency'] }],
    { candidates: list, digest: d },
  );
  assert.equal(accepted.length, 0);
  assert.equal(fabricated.length, 0);
  assert.ok(dropped[0].why.includes('was not carried by name'));
});

test('an action granted nowhere is a fabrication and the whole run is discarded', async () => {
  // The failure that cannot be contained to one verdict. An invented AWS action name says the
  // answer came from memory rather than from the evidence, and there is no way to tell which of the
  // other verdicts came from the same place.
  const list = candidates(SIMPLE);
  const target = list.find((c) => c.edge === 'run-existing');
  const client = stub((ids) => ids.map((id) => ({
    ...VERDICT,
    candidate_id: id,
    cited_actions: id === target.id ? ['lambda:AssumeExecutionRole'] : ACTIONS,
  })));
  const result = await analyse({ digest: SIMPLE, client, model: MODEL });
  assert.equal(result.findings.length, 0);
  assert.ok(result.discarded);
  assert.deepEqual(result.discarded.fabricated,
                   [{ id: target.id, action: 'lambda:AssumeExecutionRole' }]);
});

test('a verdict about a candidate nobody proposed is dropped', () => {
  // The model cannot add a path. Without a candidate id there is nothing to attach it to, and
  // inventing the attachment is what a repair would be.
  const list = candidates(SIMPLE);
  const { accepted, dropped } = validate(
    [{ ...VERDICT, candidate_id: 'C999', cited_actions: ACTIONS }],
    { candidates: list, digest: SIMPLE },
  );
  assert.equal(accepted.length, 0);
  assert.ok(dropped[0].why.includes('was not proposed'));
});

test('a verdict citing nothing is dropped', () => {
  const list = candidates(SIMPLE);
  const { dropped } = validate(
    [{ ...VERDICT, candidate_id: list[0].id, cited_actions: [] }],
    { candidates: list, digest: SIMPLE },
  );
  assert.ok(dropped[0].why.includes('cites no action'));
});

test('a narrative naming a resource is dropped (T-4)', () => {
  // The sample ARNs are evidence that resources exist. They are not a description of what those
  // resources are for, and an argument built on one inverts in the next account.
  const list = candidates(SIMPLE);
  const target = list.find((c) => c.edge === 'run-existing');
  const arn = target.target.sample[0];
  for (const narrative of [`${arn} 의 코드를 교체할 수 있다.`,
                           `${arn.split('/').pop()} 함수의 코드를 교체할 수 있다.`]) {
    const { accepted, dropped } = validate(
      [{ ...VERDICT, candidate_id: target.id, cited_actions: ACTIONS, narrative }],
      { candidates: list, digest: SIMPLE },
    );
    assert.equal(accepted.length, 0, narrative);
    assert.ok(dropped[0].why.includes('names a resource'));
  }
});

// ---- what the answers become ------------------------------------------------------------------

test('a rejected candidate is kept as a rejection, not dropped in silence', async () => {
  // "The code proposed this and the model says it is not a path, because X" is a result. An
  // approver who cannot see it cannot tell a clean grant from an analysis that never ran.
  const client = stub((ids) => ids.map((id) => ({
    ...VERDICT, candidate_id: id, cited_actions: ACTIONS, real: false,
    narrative: '해당 자원 유형에는 실행 역할이 부착되지 않으므로 경로가 성립하지 않는다.',
  })));
  const result = await analyse({ digest: SIMPLE, client, model: MODEL });
  assert.equal(result.findings.length, 0);
  assert.equal(result.rejected.length, candidates(SIMPLE).length);
  assert.ok(result.rejected[0].why.length > 0);
});

test('insufficient evidence is NOT_ASSESSABLE, never confirmed', async () => {
  const client = stub((ids) => ids.map((id) => ({
    ...VERDICT, candidate_id: id, cited_actions: ACTIONS, evidence_sufficient: false,
  })));
  const result = await analyse({ digest: SIMPLE, client, model: MODEL });
  for (const finding of result.findings) {
    assert.equal(finding.status, 'NOT_ASSESSABLE');
    assert.ok(finding.blockedBy.some((r) => r.includes('does not settle')));
  }
});

test('a reservation on the candidate keeps the finding out of CONFIRMED', async () => {
  // A reservation is a fact about the evidence, not a hedge the model may talk past.
  const unsound = unit('lambda:function', ACTIONS, ACTIONS, { scope: 'listed', colocation: 'union' });
  const d = digestOf(ACTIONS, [unsound]);
  const client = stub((ids) => ids.map((id) => ({ ...VERDICT, candidate_id: id, cited_actions: ACTIONS })));
  const result = await analyse({ digest: d, client, model: MODEL });
  assert.ok(result.findings.length > 0);
  for (const finding of result.findings) {
    assert.equal(finding.status, 'UNVERIFIED');
    assert.ok(finding.blockedBy.some((r) => r.includes('different resources')));
  }

  const sound = await analyse({ digest: SIMPLE, client, model: MODEL });
  assert.ok(sound.findings.some((f) => f.status === 'CONFIRMED'));
});

test('a proposed grade above the outcome ceiling is capped, and both numbers are kept', async () => {
  // Grade inflation is a language model's default on security text. The ceiling comes from the
  // outcome the edge already established, so it does not depend on the model agreeing to it.
  const actions = ['ec2:TerminateInstances'];
  const d = digestOf(actions, [unit('ec2:instance', actions, actions)]);
  const client = stub((ids) => ids.map((id) => ({
    ...VERDICT, candidate_id: id, cited_actions: actions, containment: contain(actions),
    category: 'DESTRUCTIVE', proposed_grade: 'CRITICAL',
  })));
  const result = await analyse({ digest: d, client, model: MODEL });
  const [found] = result.findings;
  assert.equal(found.outcome, 'availability_denial');
  assert.equal(found.escalationGrade, 'MEDIUM');
  assert.equal(found.proposedGrade, 'CRITICAL');
  assert.equal(found.capped, true);
});

test('the asset grade moves on configuration and not on a name', async () => {
  const actions = ['dynamodb:PutItem'];
  const table = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/opt-approval-store`;
  const make = (basis) => digestOf(actions, [unit('dynamodb:table', actions, actions, {
    cp: [{ arn: table, role: 'approval_store', basis }],
  })]);
  const client = stub((ids) => ids.map((id) => ({
    ...VERDICT, candidate_id: id, cited_actions: actions, containment: contain(actions),
    category: 'ESCALATION',
  })));

  const configured = await analyse({ digest: make('configured'), client, model: MODEL });
  const byName = await analyse({ digest: make('prefix'), client, model: MODEL });
  assert.ok(configured.findings.some((f) => f.assetImpactGrade === 'CRITICAL'));
  assert.ok(byName.findings.every((f) => f.assetImpactGrade === 'UNDETERMINED'));
});

test('a finding resting on a declaration-path action is not restrictable', async () => {
  const actions = ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'];
  const d = digestOf(actions, [unit('lambda:function', actions, actions)],
                     { non_restrictable: ['lambda:InvokeFunction'] });
  const client = stub((ids) => ids.map((id) => ({ ...VERDICT, candidate_id: id, cited_actions: actions })));
  const result = await analyse({ digest: d, client, model: MODEL });
  assert.ok(result.findings.every((f) => f.restrictable === false));
});

// ---- the run itself ---------------------------------------------------------------------------

test('one failed batch costs its own candidates and no others', async () => {
  const list = Array.from({ length: 3 }, (_, i) => ({
    id: `C${i + 1}`, edge: 'run-existing', outcome: 'code_execution_as', policy: 'p', policy_id: 'P1',
    target: null, control_plane: [], steps: [{ capability: 'modify_code', actions: ACTIONS }],
    also_granted: [], reservations: [],
  }));
  const client = stub((ids) => ids.map((id) => ({ ...VERDICT, candidate_id: id, cited_actions: ACTIONS })),
                      { failOn: [2] });
  const result = await analyse({ digest: SIMPLE, client, model: MODEL, candidates: list, batchSize: 1 });
  assert.equal(client.calls.length, 3);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(result.failures.map((f) => f.candidates), [['C2']]);
});

test('an answer that is not the JSON the schema required loses its batch and says so', async () => {
  const client = stub([], { text: 'I would rather explain in prose.' });
  const result = await analyse({ digest: SIMPLE, client, model: MODEL });
  assert.equal(result.findings.length, 0);
  assert.equal(result.failures.length, 1);
  assert.ok(result.failures[0].why.includes('not the JSON'));
});

test('the run records what it was asked about, what it cost, and what it can be traced to', async () => {
  const client = stub((ids) => ids.map((id) => ({ ...VERDICT, candidate_id: id, cited_actions: ACTIONS })));
  const result = await analyse({ digest: SIMPLE, client, model: MODEL });
  assert.equal(result.model_id, MODEL);
  assert.equal(result.prompt_version, PROMPT_VERSION);
  assert.equal(result.impact_sha256, 'i'.repeat(64));
  assert.equal(result.rules_sha256, 'r'.repeat(64));
  assert.equal(result.candidates, candidates(SIMPLE).length);
  assert.equal(result.usage.cacheRead, 900 * client.calls.length);
  assert.equal(result.findings_sha256.length, 64);

  // The same answer twice is the same digest; a different answer is a different one. It is what
  // binds an approval to the analysis the approver actually read.
  const again = await analyse({ digest: SIMPLE, client, model: MODEL });
  assert.equal(again.findings_sha256, result.findings_sha256);
  const other = await analyse({
    digest: SIMPLE, model: MODEL,
    client: stub((ids) => ids.map((id) => ({
      ...VERDICT, candidate_id: id, cited_actions: ACTIONS, title: '다른 제목' }))),
  });
  assert.notEqual(other.findings_sha256, result.findings_sha256);
});

test('the analysis refuses to run without a client, a model or a digest', async () => {
  await assert.rejects(() => analyse({ digest: SIMPLE, model: MODEL }), /no model client/);
  await assert.rejects(() => analyse({ digest: SIMPLE, client: stub([]) }), /no model id/);
  await assert.rejects(() => analyse({ client: stub([]), model: MODEL }), /no digest/);
});


// ---- what the wall clock is made of -------------------------------------------------------------
//
// Six policies, twenty-two candidates, roughly two minutes when the batches went out one after
// another. The time is OUTPUT: a verdict is a Korean narrative, a containment block and seven
// answers, so ten of them in one response is five thousand tokens generated in series. Smaller
// batches sent together turns a sum into a maximum.

/** A client that records how many calls are in flight at once, and holds each for one tick. */
function concurrentStub(verdictsFor, { hold = () => 1 } = {}) {
  const state = { inFlight: 0, peak: 0, calls: 0, order: [] };
  state.messages = {
    async create(body) {
      state.calls += 1;
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      const ids = [...JSON.stringify(body.messages[0].content[1].text).matchAll(/C\d+/g)]
        .map((m) => m[0]);
      await new Promise((resolve) => { setTimeout(resolve, hold(ids)); });
      state.inFlight -= 1;
      state.order.push(ids[0]);
      return {
        content: [{ type: 'text', text: JSON.stringify({ verdicts: verdictsFor(ids) }) }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0,
                 cache_creation_input_tokens: 0 },
      };
    },
  };
  return state;
}

const manyCandidates = (n) => Array.from({ length: n }, (_, i) => ({
  id: `C${i + 1}`, edge: 'run-existing', outcome: 'code_execution_as', policy: 'p', policy_id: 'P1',
  target: null, control_plane: [], steps: [{ capability: 'modify_code', actions: ACTIONS }],
  also_granted: [], reservations: [],
}));

const verdictsFor = (ids) => ids.map((id) => ({ ...VERDICT, candidate_id: id,
                                                cited_actions: ACTIONS }));

test('batches go out together rather than one after another', async () => {
  // The whole fix. Twenty-two candidates at four per batch is six requests; if they queue the run
  // takes the sum of them, and if they overlap it takes the slowest.
  const client = concurrentStub(verdictsFor);
  const result = await analyse({
    digest: SIMPLE, client, model: MODEL, candidates: manyCandidates(22),
    batchSize: 4, concurrency: 6,
  });
  assert.equal(client.calls, 6, 'twenty-two candidates at four per batch is six requests');
  assert.equal(client.peak, 6, `only ${client.peak} request(s) were ever in flight at once`);
  assert.equal(result.findings.length, 22);
  assert.equal(result.timing.concurrency, 6);
});

test('the concurrency is a ceiling, not a target', async () => {
  // An account's token budget is shared, and six at once is already enough to be throttled. A
  // deployment that lowers this must actually get fewer.
  const client = concurrentStub(verdictsFor);
  await analyse({ digest: SIMPLE, client, model: MODEL, candidates: manyCandidates(22),
                  batchSize: 4, concurrency: 2 });
  assert.equal(client.peak, 2);
});

test('failures are numbered by batch and not by what finished first', async () => {
  // The failure list and the log line are read by a person comparing two runs. Batch 3 has to mean
  // the same thing every time, whatever order the answers came back in.
  const client = concurrentStub(verdictsFor, { hold: (ids) => (ids[0] === 'C1' ? 12 : 1) });
  const result = await analyse({ digest: SIMPLE, client, model: MODEL,
                                 candidates: manyCandidates(8), batchSize: 4, concurrency: 4 });
  assert.equal(client.order[0], 'C5', 'the fixture did not actually finish out of order');
  assert.equal(result.findings.length, 8);
});

test('the deadline stops starting batches and names the candidates nobody asked about', async () => {
  // A bound rather than a hope. Without one a slow day turns a one-minute screen into a five-minute
  // one and nothing says so; with one the reader gets what arrived plus a line naming what did not.
  const client = concurrentStub(verdictsFor, { hold: () => 30 });
  const result = await analyse({
    digest: SIMPLE, client, model: MODEL, candidates: manyCandidates(40),
    batchSize: 4, concurrency: 2, deadlineMs: 40,
  });
  assert.ok(client.calls < 10, `every batch was sent anyway (${client.calls} of 10)`);
  const unasked = result.failures.filter((f) => /not asked/.test(f.why));
  assert.ok(unasked.length > 0, 'batches were skipped without being reported');
  // Named, not counted. An absent candidate reads exactly like one the model found nothing in.
  assert.ok(unasked[0].candidates.length > 0);
  assert.deepEqual(result.failures.map((f) => f.batch),
                   [...result.failures.map((f) => f.batch)].sort((a, b) => a - b));
});

test('a batch already in flight when the deadline passes is still read', async () => {
  // It was paid for. Cancelling it would spend the tokens and throw the answer away, which is the
  // thing the 504 did before the run was detached from its request.
  const client = concurrentStub(verdictsFor, { hold: () => 25 });
  const result = await analyse({
    digest: SIMPLE, client, model: MODEL, candidates: manyCandidates(8),
    batchSize: 4, concurrency: 4, deadlineMs: 1,
  });
  // Both batches start before the first deadline check, so both answers arrive.
  assert.equal(result.findings.length, 8);
  assert.equal(result.failures.length, 0);
});

test('a deadline of zero turns the bound off', async () => {
  const client = concurrentStub(verdictsFor, { hold: () => 5 });
  const result = await analyse({ digest: SIMPLE, client, model: MODEL,
                                 candidates: manyCandidates(12), batchSize: 4, concurrency: 1,
                                 deadlineMs: 0 });
  assert.equal(client.calls, 3);
  assert.equal(result.failures.length, 0);
});

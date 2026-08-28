// impact.json -> the risk digest: what a model is asked to find attack paths in.
//
// An enterprise assessment is expected past a megabyte. Measured on a real one: 202,871 bytes
// canonical, of which the action reference is 51.6% and the expanded picker lists are most of the
// rest - and once resource enumeration works, affected[] becomes the largest block at 53%. None of
// the three is evidence of anything. The reference and the picker lists exist to draw checkboxes,
// and the resource lists are mostly the same ARN written once per policy.
//
// The rule this file follows: REDUCE VOLUME, NEVER REDUCE EVIDENCE. Every reduction below is
// paired with the reason it cannot destroy a path, and the ones that could are not made.
//
// What that rules out, specifically
// ---------------------------------
//   as_written is not enough        'ec2:*' is complete information to a human and matches nothing
//                                   to a rule engine doing exact-string membership. The expansion
//                                   has to be carried, or every path that comes out of a wildcard
//                                   - instance takeover, route opening, the PassRole chain -
//                                   silently is not there
//   the picker lists are not the    both actions_offerable and the action reference are built
//   expansion                       minus the declaration path, so using either as the expansion
//                                   deletes exactly the actions that CANNOT be restricted, which
//                                   are the reconnaissance leg of the escalation. The producer now
//                                   carries actions_non_restrictable per policy for this reason
//   capability is not blast radius  a create action reaches nothing that exists yet, so it appears
//                                   in no group, ever. A digest built from the enumerated groups
//                                   alone cannot see lambda:CreateFunction on an account with no
//                                   functions - and that is half of the PassRole path. So what a
//                                   policy CAN do and what exists to be hit are carried separately
//   co-location is not a union      one unit's actions must stay that unit's. Stop on one instance
//                                   and Modify on another is not a takeover, and flattening them
//                                   would report one
//   reads are not all harmless      collapsing Read/List to a count is the single biggest saving
//                                   and it is wrong for a specific, listed set: console output,
//                                   password data, stream records, and every read a rule names
//
// Where the volume actually goes, and the one structural fix
// ----------------------------------------------------------
// The producer appends every reaching action to every group of a service, so
// ec2:ModifyInstanceAttribute is written into the instance group, the volume group and the
// security-group group alike. That per-unit duplication - not per-service - is the cost. Each
// grant therefore holds its risk actions ONCE, as an ordered array, and each unit refers to them
// by integer index. Nothing is lost and the same measurement drops from tens of kilobytes to a
// few.

import { parseArn } from './arn.js';
import { CURATED, capabilitiesOf, derivedCapabilities, referenceIndex } from './capabilities.js';

export const DIGEST_VERSION = 1;

/**
 * Read and List actions that are themselves the attack, or its precondition.
 *
 * A table, with the drift risk that implies, and it stays a table because the access level cannot
 * answer this question: AWS classifies ec2:GetConsoleOutput as Read and it returns whatever the
 * boot log printed, which on a misconfigured host is a credential. Every entry here is an action
 * whose ANSWER is the sensitive thing, not one whose call is.
 *
 * Actions named by a rule are added on top of this at load time, so a rule that fires on a read
 * never has its evidence collapsed - that union is the invariant, and this table is only the part
 * of it no rule has claimed yet.
 */
export const SENSITIVE_READS = new Set([
  // Boot output, boot INPUT, and disk copies. DescribeInstanceAttribute and
  // DescribeLaunchTemplateVersions return userData, which is where bootstrap credentials live -
  // and AWS classifies both as List, which is the clearest case for why the access level cannot
  // answer this question.
  'ec2:GetConsoleOutput', 'ec2:GetConsoleScreenshot', 'ec2:GetPasswordData',
  'ec2:DescribeInstanceAttribute', 'ec2:DescribeLaunchTemplateVersions',
  // The contents of a secret, a parameter, or a key's plaintext.
  'secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters',
  'ssm:GetParametersByPath', 'kms:Decrypt', 'states:RevealSecrets',
  // Bulk contents, and the stream that keeps giving them. A table read is not "a read" in the
  // sense the access level means: it IS the exfiltration, not a step toward one.
  'dynamodb:GetRecords', 'dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem',
  'dynamodb:BatchGetItem', 'dynamodb:PartiQLSelect', 'dynamodb:ExportTableToPointInTime',
  's3:GetObject', 's3:GetObjectVersion', 'sqs:ReceiveMessage',
  'logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:StartQuery', 'logs:GetQueryResults',
  // Code and configuration of running things. GetFunction returns a pre-signed URL to the code,
  // and the registry token is a credential behind a Get.
  'lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'ecs:DescribeTaskDefinition',
  'ecr:GetAuthorizationToken', 'ecr:GetDownloadUrlForLayer',
  // Who may assume what, and with what. The reconnaissance that makes an escalation aimable.
  'iam:GetRole', 'iam:GetRolePolicy', 'iam:GetPolicyVersion', 'iam:ListAttachedRolePolicies',
  'iam:ListRoles', 'iam:ListRolePolicies', 'iam:SimulatePrincipalPolicy',
  // The pipeline's own evidence.
  'cloudformation:GetTemplate',
]);

/** Access levels that are not, by themselves, a change to anything. */
const PASSIVE = new Set(['Read', 'List']);

/** How many ARNs a unit carries when it holds more than the sample cap. */
const SAMPLE_CAP = 8;

function levelsOf(assessment) {
  // service -> action name -> level, from the reference the producer built for THIS plan. Absent
  // for a service the budget dropped (coverage.action_lists_omitted names those), and an absent
  // level means unknown - which is kept, never assumed passive.
  const out = new Map();
  const services = assessment?.action_reference?.services ?? {};
  for (const [service, block] of Object.entries(services)) {
    const inner = new Map();
    for (const [name, entry] of Object.entries(block ?? {})) {
      if (Array.isArray(entry) && typeof entry[0] === 'string') inner.set(name, entry[0]);
    }
    out.set(service, inner);
  }
  return out;
}

/**
 * Whether an action must be carried by name.
 *
 * The invariant, stated once: an action is carried verbatim when a rule names it, when its access
 * level is anything but Read or List, when it is a sensitive read, or when the level is UNKNOWN.
 * The last clause is the one that is easy to leave out and the one that matters when AWS ships an
 * action the table has not seen - an unknown action cannot be shown to be harmless, and dropping
 * it is the only direction of error this pipeline refuses everywhere else.
 */
/**
 * The access level the reference gives this action, or undefined when nothing says.
 *
 * Undefined and 'Read' are different answers and the callers treat them differently: isRiskAction
 * carries an unknown action verbatim rather than calling it passive, and the tag list below leaves
 * it out rather than calling it a tag write. Both directions are the closed one for their caller.
 */
function levelOf(action, levels) {
  const cut = action.indexOf(':');
  return levels.get(action.slice(0, cut))?.get(action.slice(cut + 1));
}

export function isRiskAction(action, { levels, ruleActions }) {
  if (ruleActions.has(action)) return true;
  if (SENSITIVE_READS.has(action)) return true;
  const [service, name] = [action.slice(0, action.indexOf(':')), action.slice(action.indexOf(':') + 1)];
  const level = levels.get(service)?.get(name);
  if (level === undefined) return true;
  return !PASSIVE.has(level);
}

/** Services this policy grants whole, from the as-written patterns. */
function completeServices(asWritten) {
  const out = [];
  for (const pattern of asWritten ?? []) {
    const [service, name] = String(pattern).split(':');
    if (name === '*' && service && !service.includes('*') && !out.includes(service)) {
      out.push(service);
    }
  }
  return out.sort();
}

/**
 * The ARNs a unit shows, and whether that is all of them.
 *
 * Sampling is where an attack path is most easily lost: the path that matters is often ONE
 * instance out of twenty, or two route tables and a gateway. So the rules are ordered by what
 * cannot be given up - the pipeline's own resources are never sampled out, a small unit is carried
 * whole and says so, and only then does the cap apply.
 */
function sampleOf(resources, controlPlane, { excludeGoverned = false } = {}) {
  const all = resources.map((r) => r.arn).filter(Boolean);
  const hits = [];
  for (const arn of all) {
    const hit = controlPlane.classify(arn);
    // basis travels with the hit. A prefix match is a match against a name and may not move a
    // grade (T-4); findings.js grades on 'configured' and 'declared' only, and it can only make
    // that distinction if the digest carried it.
    if (hit) hits.push({ arn, role: hit.role, basis: hit.basis });
  }

  // The organisation denies everyone outside the pipeline on its own namespace, so where that is
  // attached these ARNs are named by the grant and reachable by nobody. Set aside rather than
  // dropped: the count travels on the unit and the card prints it, because a list that quietly
  // shrank from 118 to 29 is a different claim with no way to tell it was made.
  //
  // The whole hit set goes, not just the prefix matches. A configured name and a declared ARN are
  // stronger evidence of the same fact - that this is the deployment's own machinery - and it would
  // be strange to set aside opt-SolutionInspector by its name and keep opt-approval-store, which
  // this deployment can say outright it owns.
  const governed = excludeGoverned ? new Set(hits.map((h) => h.arn)) : new Set();
  const arns = governed.size ? all.filter((a) => !governed.has(a)) : all;
  const kept = governed.size ? hits.filter((h) => !governed.has(h.arn)) : hits;
  const aside = { governed: governed.size, governed_roles: [...new Set(hits.map((h) => h.role))].sort() };

  if (arns.length <= SAMPLE_CAP) {
    return { sample: arns, sample_complete: true, cp: kept, ...aside };
  }
  // The producer already sorts sensitive first, then by ARN, so taking the head keeps the ones an
  // approver was meant to see. Control-plane hits are unioned back in whatever their position.
  const head = arns.slice(0, SAMPLE_CAP);
  for (const { arn } of kept) if (!head.includes(arn)) head.push(arn);
  return { sample: head, sample_complete: false, cp: kept, ...aside };
}

/**
 * Whether a unit's action list can be read as "all of these, on each of these".
 *
 * It can when the policy's Resource was unscoped: every resource of the type is then reached by
 * every action in the list. It cannot when the statement named ARNs, because the producer unions
 * the actions of every statement into one group keyed by resource type - so a policy granting Stop
 * on one instance and Modify on another produces a single unit listing both, and a rule that needs
 * them on the SAME resource would fire on a co-location that does not exist.
 *
 * Recorded rather than resolved. The producer no longer has the per-statement attribution to give,
 * so the honest answer is to mark the unit and let the status resolver refuse to call anything
 * CONFIRMED on it.
 */
function colocation(group) {
  if (group.scope === '*') return 'sound';
  return 'union';
}

/**
 * The digest.
 *
 * assessment is impact.json as stored. Everything else is injected so this stays a pure function:
 * controlPlane is server/controlPlane.js, ruleActions is every action named by any rule predicate,
 * and the two digests identify what produced the answer.
 */
export function condense(assessment, {
  controlPlane, ruleActions = new Set(), rulesSha256 = null, impactSha256 = null,
  excludeGoverned = false,
} = {}) {
  const levels = levelsOf(assessment);
  // Everything the reference establishes about an action, not just its level. levelsOf stays
  // because tag_writes and isRiskAction read the level alone and neither needs the rest.
  const reference = referenceIndex(assessment);
  const dropped = [];

  const grants = [];
  for (const policy of assessment.policies ?? []) {
    // The baseline is summarised by the producer and carries no groups. It is kept as a line so an
    // approver can see it was classified as baseline, and it contributes no actions.
    const asWritten = policy.actions_granted ?? [];
    const offerable = policy.actions_offerable ?? [];
    const nonRestrictable = policy.actions_non_restrictable ?? [];
    // Absent on a baseline or unreadable policy, and absent on an assessment written before the
    // querier produced it. Empty then, which reads as "nothing is known to be unscoped" - the
    // conservative direction, since every use of it below only ever RAISES confidence.
    const unscoped = new Set(policy.actions_unscoped ?? []);

    // Capability, independent of what exists. This is the half that a groups-only digest loses:
    // a create action reaches nothing in an empty account and appears in no unit.
    const complete = completeServices(asWritten);
    const all = [...new Set([...offerable, ...nonRestrictable])]
      .filter((a) => a.includes(':') && isRiskAction(a, { levels, ruleActions }))
      .sort();

    // A service granted WHOLE is folded, and folding it carries more information than the list it
    // replaces. 'ec2:*' in complete_services says every ec2 action is granted, which is a stronger
    // statement than 659 names - the names are what the wildcard expands to, and enumerating them
    // invites the reader to treat the list as the boundary. What is still carried by name for such
    // a service is the part a reader cannot re-derive: the actions a rule names, which a rule
    // engine matches by exact string, and the reads that are themselves the attack.
    //
    // Measured: this is the difference between a 93 KB digest and a 40 KB one, and every byte of
    // it is the same wildcard written out.
    const folded = new Map();
    const risk = all.filter((action) => {
      const service = action.slice(0, action.indexOf(':'));
      if (!complete.includes(service)) return true;
      // Three things survive the fold, and the third is the one that is easy to leave out.
      // A rule names it - the engine matches exact strings.
      if (ruleActions.has(action)) return true;
      // It is a read that is itself the attack.
      if (SENSITIVE_READS.has(action)) return true;
      // The capability table knows it. Without this clause the fold silently deletes every action
      // that carries a path nobody has written a rule for yet - measured: item writes on the
      // approval store and the state lock, and the whole boot-rewrite takeover, all of which are
      // in a service granted with a wildcard and none of which any shipped rule names. The unit's
      // action set is what a same-resource chain is proposed from, so an action missing here is a
      // chain that cannot be proposed at all.
      if (CURATED[action]) return true;
      // The reference classifies it. Same reason as the clause above and the one that made it
      // necessary: a wholly-granted service is where the interesting actions hide, and an action
      // dropped here is one no rule and no candidate can ever mention. Measured on the shipped
      // table this keeps 40 more ec2 names, 37 s3, 31 iam - among them
      // ec2:ReplaceRouteTableAssociation, which is the whole reason this clause exists.
      if (derivedCapabilities(reference.get(action)).length) return true;
      folded.set(service, (folded.get(service) ?? 0) + 1);
      return false;
    });
    for (const [service, count] of folded) {
      dropped.push({
        what: `${policy.identifier} ${service} action names`,
        count,
        why: `${service}:* is granted whole and complete_services says so, which is wider than the `
          + 'names it expands to. Rule-named actions and sensitive reads are still carried by name',
        recoverable: true,
      });
    }
    const index = new Map(risk.map((a, i) => [a, i]));

    const units = [];
    // Resource TYPES that exist under this grant and hold nothing an outside principal can reach,
    // because every resource of the type is this deployment's own. Kept apart from units so the
    // fact survives without producing a target row that reaches nothing.
    const governedOnly = [];
    for (const group of policy.affected ?? []) {
      const acts = [];
      let reads = 0;
      let foldedHere = 0;
      const service = group.service;
      for (const action of group.actions ?? []) {
        const at = index.get(action);
        if (at !== undefined) { acts.push(at); continue; }
        // Not in the grant's list: either a passive action, or one folded into a complete service.
        // The two are counted apart because they mean opposite things - one is "nothing here to
        // look at", the other is "everything here, described by the wildcard above".
        if (complete.includes(service) && isRiskAction(action, { levels, ruleActions })) {
          foldedHere += 1;
        } else {
          reads += 1;
        }
      }
      const { sample, sample_complete, cp, governed, governed_roles } =
        sampleOf(group.resources ?? [], controlPlane, { excludeGoverned });
      // Nothing left to reach. The unit is not emitted - a target row reading "0개" is noise - but
      // the count is kept on the grant, so "this policy names 118 roles and every one of them is
      // ours" stays a sentence somebody can read rather than an absence.
      if (governed > 0 && governed >= (group.total ?? (group.resources ?? []).length)) {
        governedOnly.push({ t: group.resource_type, n: governed, roles: governed_roles });
        continue;
      }
      units.push({
        // Every unit is emitted, including one whose actions are all passive. The COUNT is the
        // finding for reconnaissance: "108 roles, 44 policies, 15 stacks, and you cannot stop the
        // reading" is an answer, and a unit dropped for having no risk action takes it away.
        //
        // resource_type is already service-qualified - Resource Explorer reports 'ec2:instance',
        // which is the same token the console link table and the page are keyed by. Prefixing the
        // service again produced 'ec2:ec2:instance' and broke every join.
        t: group.resource_type,
        // Net of what was set aside. The producer's own total is the gross figure and the ARNs it
        // could not list are already missing from it, so subtracting what was seen and set aside is
        // the best number available - never larger than the truth, which is the direction to err.
        n: Math.max(0, (group.total ?? (group.resources ?? []).length) - governed),
        // How many of this type are this deployment's own, and what they do. Zero unless the switch
        // is on, so an untouched deployment carries the same bytes it did.
        governed,
        governed_roles: governed ? governed_roles : [],
        scope: group.scope ?? '*',
        colocation: colocation(group),
        // 'service' means at least one action was admitted only because the table did not know it,
        // so every resource of the service was attached to it - deliberate over-reporting by the
        // producer, and a rule firing on such a unit may be firing on fabricated co-location.
        attribution: group.attribution ?? 'resource_type',
        sensitive: group.sensitive_hits ?? 0,
        // T-6: unknown is null, never false. A false here silently upgrades a finding's status.
        truncated: typeof group.truncated === 'boolean' ? group.truncated : null,
        // Not derivable. The producer never records how many resources were dropped, and the
        // service does not count matches past its ceiling, so the number does not exist upstream.
        omitted: null,
        sample,
        sample_complete,
        cp,
        acts: acts.sort((a, b) => a - b),
        // Risk actions this unit holds that the complete-service fold covers. A number, not a
        // silence: "this unit has 41 more mutating actions and the service is granted whole" is
        // the honest form, and a zero here on a complete service would read as a narrow grant.
        folded: foldedHere,
        reads,
      });
    }

    grants.push({
      p: `P${grants.length + 1}`,
      name: policy.identifier,
      source: policy.source,
      version: policy.default_version_id ?? null,
      is_baseline: policy.is_baseline === true,
      restrictable: policy.restrictable !== false,
      // Why the body could not be read, bounded. It is what makes an unknown ceiling honest, and
      // it is whatever the SDK raised - which can be a multi-kilobyte trace.
      unreadable: typeof policy.unreadable === 'string' ? policy.unreadable.slice(0, 300) : null,
      as_written: asWritten,
      // Services granted whole. Every action of these is granted, whether or not it is named in
      // risk_actions - so an analysis may reason about any action of such a service, and a
      // validator checking that a cited action exists must accept one on this basis.
      complete_services: complete,
      risk_actions: risk,
      // The actions AWS itself calls Tagging, carried by NAME because the capability layer cannot
      // work them out. Its verb fallback reads the first word, and the first word of a tag write is
      // usually not "Tag": ec2:CreateTags reads as create, s3:PutBucketTagging as modify-config,
      // ec2:DeleteTags as delete, rds:AddTagsToResource as nothing at all. That miss is the whole
      // of why a tag-tamper path was invisible, and the answer is not a longer verb list - it is
      // the access level the reference already publishes and this file already reads to decide what
      // is passive. Empty when the assessment carries no reference to read levels from.
      tag_writes: risk.filter((a) => levelOf(a, levels) === 'Tagging'),
      // Granted on an unscoped Resource, so they reach every resource of their type - including the
      // ones that do not exist yet. Carried because it is the only fact that can distinguish a
      // grant over the whole account from a grant over two named ARNs when the account holds
      // nothing to enumerate, and the action axis needs exactly that distinction: several actions
      // all granted on '*' really are available on one resource together, and several actions each
      // granted on its own ARN may not be.
      //
      // Filtered to the risk list for the same reason every other action field is - the digest is
      // what an approval is bound to, and a full expansion of ec2:* here would be the wildcard
      // written out again.
      unscoped_actions: risk.filter((a) => unscoped.has(a)),
      non_restrictable: nonRestrictable,
      units,
      // Emitted only when something was set aside, so an untouched deployment's digest is
      // byte-identical to what it was.
      ...(governedOnly.length ? { governed_only: governedOnly } : {}),
    });
  }

  const passroleGrants = (assessment.passrole_grants ?? []).map((g) => ({
    name: g.identifier,
    services: g.services ?? [],
    // The ceiling. Absent on an assessment written before the producer carried it, and absent is
    // not '*' - it is unknown, which is a different answer.
    resources: g.resources ?? null,
    unconditioned: g.unconditioned === true,
  }));

  // Across every grant, the mutating actions the capability layer could not place. Computed over
  // the grants rather than over the assessment so it counts what actually reached the graph, and
  // deduplicated because the same action is granted by several policies constantly.
  const unclassified = [...new Set(
    grants.flatMap((g) => g.risk_actions ?? [])
      .filter((a) => capabilitiesOf(a, reference).source === 'unmapped'),
  )].sort();

  const coverage = assessment.coverage ?? {};
  const enumerated = coverage.services_enumerated ?? {};
  const interesting = {};
  let clean = 0;
  for (const [service, outcome] of Object.entries(enumerated)) {
    if (outcome?.error || outcome?.truncated || (outcome?.seen ?? 0) !== (outcome?.kept ?? 0)) {
      interesting[service] = outcome;
    } else {
      clean += 1;
    }
  }

  const digest = {
    digest_version: DIGEST_VERSION,
    meta: {
      schema: assessment.schema ?? null,
      request_id: assessment.request_id ?? null,
      account_id: assessment.account_id ?? null,
      resource: assessment.resource ?? null,
      kind: assessment.kind ?? null,
      permission_set_name: assessment.permission_set_name ?? null,
      mirror_role_name: assessment.mirror_role_name ?? null,
      planned_at: assessment.planned_at ?? null,
      inventory_as_of: assessment.inventory_as_of ?? null,
      has_changes: assessment.has_changes !== false,
      changes_sha256: assessment.changes_sha256 ?? null,
      // What produced this answer, so a finding can be traced to the exact inputs. The impact
      // digest is the canonical compact one the applier checks - never a hash of the stored bytes.
      source_impact_sha256: impactSha256,
      rules_sha256: rulesSha256,
      reference_version: coverage.reference_version ?? null,
    },

    // The classification inputs, carried so the classification is auditable rather than asserted.
    baseline: assessment.baseline ?? null,
    protected_actions: assessment.protected_actions ?? [],

    // What is ALREADY denied. Context only: a new decision REPLACES these statements, so nothing
    // here may suppress a finding - a path blocked by the current restriction reopens the moment
    // the replacement lands, and hiding it would hide exactly that.
    current_restriction: {
      statements: assessment.current_admin_deny ?? [],
      sha256: assessment.inline_sha256 ?? null,
      note: 'replaced on approval - never treat as a control that survives this decision',
    },

    // Domain 1's whole attack surface: the mirror role is the thing that gets passed, so whoever
    // its trust admits runs with these permissions. Null for the other domains.
    trust: assessment.trust ?? null,
    passrole_requests: assessment.passrole_requests ?? [],
    passrole_grants: passroleGrants,

    control_plane: {
      declared_instances: controlPlane.declaredInstances(),
      // Said explicitly rather than left as an empty list. The enumeration is scoped to the
      // assessed account, so in a deployment where the pipeline lives elsewhere its own resources
      // can never appear here - and an empty list would read as "nothing of ours is reachable"
      // when it means "we could not have seen it either way".
      note: 'only resources enumerated in the assessed account can appear; a pipeline deployed in '
        + 'another account is not visible here and its absence is not evidence',
    },

    grants,

    coverage: {
      complete: coverage.complete === true,
      services_failed: coverage.services_failed ?? [],
      truncated_groups: coverage.truncated_groups ?? [],
      policies_unreadable: coverage.policies_unreadable ?? [],
      // The widest grant there is, reported as the least. Non-empty means every unit undercounts
      // and no result can be trusted - it dominates, and it is never dropped for budget.
      actions_unbounded: coverage.actions_unbounded ?? [],
      // Why any unit is marked attribution='service'.
      actions_unresolved: coverage.actions_unresolved ?? [],
      // Resource types the index reported and the reference could not resolve, with how many were
      // dropped. Verbatim and never folded into a count: each key names a type whose resources are
      // MISSING from every unit below, so an analysis reading this digest is reasoning over an
      // enumeration it can now see the hole in.
      types_unknown: coverage.types_unknown ?? {},
      // Safe to collapse ONLY because risk_actions is built from the grant rather than from the
      // units: an account-level action reaches nothing in any index and appears in no unit, and
      // one of them (iam:ListRoles) is named by a rule.
      actions_account_level: (coverage.actions_account_level ?? []).length,
      // Mutating actions nothing could classify: not in the curated table, not classified by the
      // reference, and no recognised verb. They reach NO attack-path edge, so no candidate names
      // them and the model is never asked about them - and until this counted them, that was
      // indistinguishable on screen from there being nothing to ask.
      //
      // A count and a sample rather than the whole list: it is the same shape as
      // actions_account_level above, and the number is what says how much of the grant the graph
      // could not see. "We could not classify 31 mutating actions" is a fact an approver has to be
      // given; which 31 is a follow-up, and the sample starts it.
      actions_unclassified: unclassified.length,
      actions_unclassified_sample: unclassified.slice(0, 12),
      reference: coverage.reference ?? null,
      services_enumerated: interesting,
      services_enumerated_clean: clean,
    },

    budget: { dropped },
  };

  return digest;
}

/** Bytes the digest costs as it will be sent. */
export function digestBytes(digest) {
  return Buffer.byteLength(JSON.stringify(digest), 'utf8');
}

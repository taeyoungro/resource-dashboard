// The rule engine: digest in, Finding[] out.
//
// This is the deterministic half of the risk analysis. It fires the rules in finding-rules.json
// against the condensed assessment and produces findings that no model was involved in - the
// narrative of every finding here is the rule's own sentence, byte for byte. The model's job comes
// later (riskAnalysis.js) and it judges candidate paths; it never authors a finding this file
// produced, and it cannot raise a grade.
//
// Two departures from the reference implementation in the design's finding.types.ts, both because
// the input is a condensed assessment rather than a per-resource one:
//
//   1. policyActionUnion reads the GRANT's action list, not the union of its units' actions. The
//      two differ, and the difference is the whole of E-1: lambda:CreateFunction reaches nothing
//      that exists, so it appears in no unit at all. Evaluating the union of units would mean a
//      policy could grant PassRole and CreateFunction and fire nothing, in exactly the account
//      where the escalation is easiest - an empty one.
//
//   2. A resourceActionSet unit is a resource-TYPE group, and the producer unions the actions of
//      every statement into one such group. So a policy granting Stop on instance A and Modify on
//      instance B produces one unit listing both, and E-3's allOf would fire on a co-location that
//      does not exist. The digest marks this (colocation: 'union', attribution: 'service') and this
//      file refuses to call such a finding CONFIRMED. The design's own note on E-3 asks for exactly
//      that: an allOf must be evaluated on one resource's action set, and where the input cannot
//      prove it was, the finding is UNVERIFIED with the reason attached.
//
// T-4 is structural here, not a convention: a resource name, a tag or a stack name never reaches a
// grade or a narrative because neither is computed from the input at all. Grades come from the rule
// and from control-plane classification, which is a match against configured values; narratives are
// copied. The tests assert it by renaming every resource in an input and diffing the findings.
//
// Two axes, and every rule is asked both questions
// ------------------------------------------------
// A grant carries two different risks and they were being reported as one:
//
//   영향 자원 위험   what this grant reaches in the account AS IT IS. Needs the inventory, names
//                    ARNs, and is empty when the account is
//   Action 자체 위험  what this grant LETS SOMEBODY DO. Needs nothing but the action list, names no
//                    resource, and is as true on day one as it is on day four hundred
//
// Only the first existed. Every rule but E-1 and R-1 is evaluated over units, a unit is a group of
// resources that were FOUND, and an account with nothing in it has no units - so ten of thirteen
// rules could not fire at all, and the risk readout for a new account was three rules and a blank
// page. That is the account a preventive control is written for, and it was the one the analysis
// had least to say about.
//
// So each rule is evaluated on both axes and the findings carry which one they came from. The two
// are not merged and not deduplicated: on an account that HAS instances, E-3 appears in both, once
// naming the two instances it reaches today and once saying the grant replaces the execution
// context of whatever comes to exist. Those are different sentences and an approver needs both -
// the first is what a restriction can be validated against, the second is what survives the next
// deployment. Each carries a badge pointing at its twin so the pair does not read as two findings.
//
// What the action axis may NOT do is inherit the resource axis's claims. It attaches no ARNs, and
// where a rule needs several actions to land on ONE resource it says so unless the grant is
// unscoped - see resolveStatus. An action axis that quietly asserted co-location would be the same
// class of error as the union-of-statements one the unit scope exists to prevent, arriving through
// the other door.

import { RULES, SECTION_ORDER, SORT } from './rules.js';
import { ROLES } from './controlPlane.js';
import { capabilitiesOf } from './capabilities.js';

/** The two questions. A finding answers exactly one of them and says which. */
export const AXIS = { RESOURCE: 'resource', ACTION: 'action' };

/**
 * Scopes that already read the POLICY rather than the inventory.
 *
 * A rule evaluated on one of these was never asking about resources, so it needs no translation to
 * be asked on the action axis - it asks the same question there, over the same list.
 */
const POLICY_SCOPES = new Set(['policyActionUnion', 'policyNonRestrictable']);

const GRADE_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4 };
const STATUS_ORDER = { CONFIRMED: 0, UNVERIFIED: 1, NOT_ASSESSABLE: 2 };

/**
 * What a control-plane role is worth as an asset, when the pipeline's own configuration is what
 * identified it.
 *
 * This is the asset axis the design left open (§3), resolved the cheap way: the deployment already
 * knows the names of its own machinery because an operator configured them, and an operator can
 * declare anything else. Nothing is inferred - a resource absent from both is UNDETERMINED and
 * stays there. Tag-based classification is not a candidate; it violates T-4.
 *
 * The governance store, the lock, the two state buckets, the marker bucket, the queue and the
 * pipeline's own roles are CRITICAL because a write to any of them changes what gets approved,
 * which is a class above changing what a workload does.
 */
const ASSET_GRADE_BY_ROLE = {
  [ROLES.APPROVAL_STORE]: 'CRITICAL',
  [ROLES.STATE_LOCK]: 'CRITICAL',
  [ROLES.TERRAFORM_STATE]: 'CRITICAL',
  [ROLES.INLINE_STATE]: 'CRITICAL',
  [ROLES.MARKER_STORE]: 'CRITICAL',
  [ROLES.EVENT_QUEUE]: 'CRITICAL',
  [ROLES.PIPELINE_ROLE]: 'CRITICAL',
  [ROLES.TASK_CLUSTER]: 'HIGH',
  [ROLES.GOVERNED_ARTIFACT]: 'HIGH',
  [ROLES.OPERATOR_DECLARED]: 'HIGH',
};

/**
 * Bases that may move a grade.
 *
 * 'configured' is a match against a value in this deployment's environment; 'declared' is an
 * operator naming an ARN outright. 'prefix' is neither - opt-* / mirror-* / cmp-* are namespaces
 * this pipeline issues, which makes the match useful to a reader and still a statement about a
 * NAME. T-4 forbids a name moving a grade, so a prefix hit is carried for display and excluded
 * here.
 */
const GRADING_BASES = new Set(['configured', 'declared']);

/**
 * Collect the actions that satisfied a predicate, or null if it is not satisfied.
 *
 * `byCapability` maps a capability to the available actions carrying it. A capability term fires on
 * what an action DOES rather than on what it is called, and it returns EVERY action that satisfied
 * it rather than the first - the card shows trigger actions in full, and an approver writing a
 * restriction needs all of them.
 */
function match(predicate, available, byCapability) {
  if ('action' in predicate) {
    return available.has(predicate.action)
      ? { actions: [predicate.action], atomic: true }
      : null;
  }
  if ('capability' in predicate) {
    const hit = byCapability?.get(predicate.capability);
    // Every action carrying the capability satisfies the term BY ITSELF, so the term is atomic
    // however many of them there are.
    return hit && hit.length ? { actions: [...hit], atomic: true } : null;
  }
  if ('anyOf' in predicate) {
    // Every branch that hit, not the first.
    //
    // It used to return the first and that was a defect on the decision path, not a cosmetic one.
    // AmazonEC2FullAccess grants all five of X-3's actions; the card reported ec2:GetConsoleOutput
    // alone, the 차단 dialog offered that alone, an approver denied it, and the card went green
    // while ec2:CreateImage - a full copy of the disk - stayed granted. Seven of thirteen rules had
    // the same hole: E-3 hid the instance-profile swap behind lambda:UpdateFunctionCode, X-2 hid
    // AttachInternetGateway behind CreateRoute.
    const actions = [];
    let atomic = false;
    for (const sub of predicate.anyOf) {
      const hit = match(sub, available, byCapability);
      if (!hit) continue;
      actions.push(...hit.actions);
      // The branches are ALTERNATIVES. One branch that needs no co-location is enough to establish
      // the finding without it, whatever the others need.
      atomic = atomic || hit.atomic;
    }
    return actions.length ? { actions, atomic } : null;
  }
  const acc = [];
  let only = null;
  for (const sub of predicate.allOf) {
    const hit = match(sub, available, byCapability);
    if (!hit) return null;
    acc.push(...hit.actions);
    only = hit;
  }
  // allOf needs its branches TOGETHER, so several actions here really do have to meet on one
  // resource. A single-branch allOf is just that branch, and a conjunction that resolved to one
  // action needs nothing to meet.
  return { actions: acc, atomic: predicate.allOf.length === 1 ? only.atomic : acc.length < 2 };
}

/** capability -> the actions in this scope that carry it. */
function capabilityIndex(actions, reference) {
  const out = new Map();
  for (const action of actions) {
    for (const cap of capabilitiesOf(action, reference).caps) {
      if (!out.has(cap)) out.set(cap, []);
      out.get(cap).push(action);
    }
  }
  return out;
}

/** The action names a unit holds, by name. Indices point into the grant's risk_actions. */
export function unitActions(grant, unit) {
  const names = grant.risk_actions ?? [];
  return (unit.acts ?? []).map((i) => names[i]).filter((a) => typeof a === 'string');
}

/**
 * The units a rule is evaluated over, and what each unit can prove.
 *
 * Every unit carries `sound`: whether the input can show the actions in it are co-located on one
 * resource. A single-action hit does not need co-location, but it does need the actions to have
 * been attributed to these resources at all - which attribution='service' says they were not.
 */
function scopeUnits(rule, grant, axis) {
  // The action axis reads the grant's own list and attaches nothing.
  //
  // This replaced a per-rule `whenNoUnits` fallback that did the same swap for one rule (E-2) and
  // only when the grant enumerated nothing. Two reasons it is an axis now rather than a fallback:
  // it applies to every rule instead of the one whose author remembered to ask for it, and it is
  // not conditional on the account being empty - the capability is worth stating on a full account
  // too, which is the whole point of the second area.
  if (axis === AXIS.ACTION) {
    const scope = POLICY_SCOPES.has(rule.evaluatedOn) ? rule.evaluatedOn : 'policyActionUnion';
    return scopeUnits({ ...rule, evaluatedOn: scope }, grant, AXIS.RESOURCE).map((unit) => ({
      ...unit,
      // No ARNs, ever. A capability statement that carried a resource list would be answering the
      // other question, and the list would be the one thing about it that goes stale.
      units: [],
      // Resolved per HIT, not here: a single-action hit needs no co-location and a three-action one
      // does. evaluateGrant sets it once it knows how many actions fired. See resolveStatus.
      colocated: true,
      attributed: true,
    }));
  }
  switch (rule.evaluatedOn) {
    case 'resourceActionSet':
      return (grant.units ?? []).map((unit) => ({
        actions: unitActions(grant, unit),
        units: [unit],
        // 'union' is the producer's own word for "these actions came from different statements".
        colocated: unit.colocation === 'sound',
        attributed: unit.attribution !== 'service',
      }));
    case 'policyActionUnion':
      // The grant's list, not the units'. See the header.
      return [{
        actions: [...(grant.risk_actions ?? []), ...(grant.non_restrictable ?? [])],
        units: grant.units ?? [],
        colocated: true,
        attributed: true,
      }];
    case 'policyNonRestrictable':
      return [{
        actions: grant.non_restrictable ?? [],
        units: [],
        colocated: true,
        attributed: true,
      }];
    default:
      // Unreachable: rules.js refuses to load a scope it does not know. Kept so a future scope
      // added to the file without a branch here fails loudly instead of silently finding nothing.
      throw new Error(`unknown evaluation scope ${rule.evaluatedOn}`);
  }
}

/** Whether the analysis can see the ceiling a rule's upperBound needs. */
function boundResolvable(requires, digest) {
  if (requires !== 'passableRoleSet') return null;
  const grants = digest.passrole_grants ?? [];
  if (grants.length === 0) {
    // iam:PassRole is in the action list but the producer recorded no grant for it. The set of
    // passable roles is then unknown, and it is the upper bound of the whole finding.
    return { known: false, why: 'no PassRole grant was recorded, so the passable role set is unknown' };
  }
  const unknown = grants.filter((g) => g.resources === null);
  if (unknown.length) {
    return { known: false,
             why: `the passable role set is unknown for ${unknown.map((g) => g.name).join(', ')}` };
  }
  const unbounded = grants.filter((g) => (g.resources ?? []).includes('*'));
  if (unbounded.length) {
    // Known, and known to be every role. That is the worst case and it is CONFIRMED, not unverified:
    // there is nothing left to verify.
    return { known: true, why: null,
             ceiling: `every role in the account (${unbounded.map((g) => g.name).join(', ')})` };
  }
  return { known: true, why: null,
           ceiling: grants.flatMap((g) => g.resources ?? []).join(', ') };
}

/** Reasons this finding is not CONFIRMED, and the status they imply. */
function resolveStatus(rule, grant, digest, unit, truncated, axis) {
  const blockedBy = [];
  let status = 'CONFIRMED';

  function down(to, reason) {
    blockedBy.push(reason);
    if (STATUS_ORDER[to] > STATUS_ORDER[status]) status = to;
  }

  // Co-location and attribution first: they say the finding may not exist at all, which outranks
  // not knowing how far it reaches.
  if (!unit.attributed) {
    down('UNVERIFIED', 'the producer could not resolve which resource type these actions apply to, '
      + 'so every resource of the service was attached and the target list may be wrong');
  }
  if (!unit.colocated) {
    down('UNVERIFIED', axis === AXIS.ACTION
      // The action axis's own version of the same doubt, and it has a different cause. Nothing was
      // unioned here - the list is the grant's. What is unproven is that the actions meet on one
      // resource, and the thing that would prove it is an unscoped Resource: actions granted on '*'
      // are all available on every resource of their type, including the ones not created yet.
      // Actions each granted on their own ARN may never meet.
      ? 'this needs several actions to apply to the same resource, and at least one of them was '
        + 'granted on named ARNs rather than on every resource of its type - so the grant may hold '
        + 'them on different resources and this combination may not exist'
      : 'the statement named resources, and the assessment unions the actions of '
        + 'every statement into one group per resource type - these actions may be held on '
        + 'different resources');
  }

  if (rule.upperBound) {
    // Truncation is a property of an enumeration, and the action axis performed none - it attaches
    // no resource list, so there is no list to be short. Reporting it here would be inventing a
    // doubt about a claim this finding never made.
    if (axis !== AXIS.ACTION && truncated === true) {
      down(rule.upperBound.onTruncatedResourceList, 'the resource list is truncated, so the reach '
        + 'of this finding cannot be bounded');
    }
    const unreadable = [
      ...(digest.coverage?.policies_unreadable ?? []),
      ...(grant.unreadable ? [grant.name] : []),
    ];
    if (unreadable.length) {
      down(rule.upperBound.onUnreadableConstraintPolicy,
           `a policy body could not be read: ${unreadable.join(', ')}`);
    }
    const bound = boundResolvable(rule.upperBound.requires, digest);
    if (bound === null) {
      down('NOT_ASSESSABLE',
           `this rule bounds itself on ${rule.upperBound.requires}, which this analysis cannot read`);
    } else if (!bound.known) {
      down('UNVERIFIED', bound.why);
    }
  }

  // The widest grant there is, reported as the least. Non-empty means an action list is incomplete,
  // so a finding that DID fire still stands - what it cannot claim is that it saw everything.
  if ((digest.coverage?.actions_unbounded ?? []).length) {
    down('UNVERIFIED', 'the assessment reports actions it could not bound, so no action list here '
      + 'is complete');
  }

  return { status, blockedBy };
}

/** The asset axis, from configuration only. */
function assetGrade(rule, units) {
  let best = null;
  const evidence = [];
  for (const unit of units) {
    for (const hit of unit.cp ?? []) {
      if (!GRADING_BASES.has(hit.basis)) continue;
      const grade = ASSET_GRADE_BY_ROLE[hit.role];
      if (!grade) continue;
      evidence.push({ arn: hit.arn, role: hit.role, basis: hit.basis });
      if (best === null || GRADE_ORDER[grade] < GRADE_ORDER[best]) best = grade;
    }
  }
  if (best === null) return { assetImpactGrade: rule.assetImpactGrade, assetEvidence: [] };
  return { assetImpactGrade: best, assetEvidence: evidence };
}

function truncationOf(units) {
  if (units.some((u) => u.truncated === true)) return true;
  if (units.some((u) => u.truncated === null || u.truncated === undefined)) return null;
  // NO units is not a complete enumeration, it is no enumeration - nothing here established that
  // the target list is whole, so saying false claims something nobody checked. T-6: unknown
  // completeness is null, never false. This is the shape a capability-only finding has - a
  // policyActionUnion rule on a grant with nothing enumerated, which is every rule finding on a
  // new account - and reporting those as "enumeration complete" is the one way the empty-account
  // recovery could have become a new lie.
  if (units.length === 0) return null;
  return false;
}

/**
 * Fire every rule against one grant.
 *
 * A rule whose evaluation throws is recorded as a NOT_ASSESSABLE finding for that rule alone and
 * the rest keep going (T-3). A rule engine that stops at the first exception reports fewer
 * findings than there are, and reports it as a clean result.
 */
export function evaluateGrant(grant, digest, rules = RULES, reference = null) {
  const out = [];
  const unscoped = new Set(grant.unscoped_actions ?? []);

  for (const rule of rules) {
   for (const axis of axesFor(rule)) {
    try {
      for (const scope of scopeUnits(rule, grant, axis)) {
        const available = new Set(scope.actions);
        const found = match(rule.predicate, available, capabilityIndex(scope.actions, reference));
        if (!found) continue;
        // Deduplicated because a capability term and a literal can name the same action, and a card
        // listing it twice reads as two reasons.
        const hits = [...new Set(found.actions)];

        // Co-location, decided per hit and only on the action axis. One action needs no
        // co-location at all; several need the grant to put them on the same resource, and the
        // only thing in the digest that establishes that without an inventory is an unscoped
        // Resource. E-3's anyOf reaches here both ways - a lone
        // ec2:ReplaceIamInstanceProfileAssociation is sound, the Stop/Modify/Start triple is not
        // unless all three are granted on '*'.
        // Co-location doubt applies only where the rule actually needs several actions to meet on
        // one resource. `atomic` says a single action satisfied it - E-3's
        // ec2:ReplaceIamInstanceProfileAssociation branch does, its Stop/Modify/Start branch does
        // not - and on either axis a finding that needs no co-location must not be downgraded for
        // lacking it.
        const unit = axis === AXIS.ACTION
          ? { ...scope, colocated: found.atomic || hits.every((a) => unscoped.has(a)) }
          : { ...scope, colocated: scope.colocated || found.atomic };

        const contributing = unit.units.filter((u) =>
          unitActions(grant, u).some((a) => hits.includes(a)));
        const targets = contributing.length ? contributing : unit.units;
        // A resource-axis finding that reaches nothing is not a resource finding. It says exactly
        // what the action-axis one says - the predicate fired over a list of actions - and the
        // action axis always fires where this did, because its list is a superset of any unit's.
        // Keeping it would print the same sentence twice under a heading promising ARNs.
        if (axis === AXIS.RESOURCE && targets.length === 0) continue;
        const truncated = truncationOf(targets);
        const { status, blockedBy } = resolveStatus(rule, grant, digest, unit, truncated, axis);

        out.push({
          id: rule.id,
          axis,
          category: rule.category,
          title: rule.title,
          escalationGrade: rule.escalationGrade,
          ...assetGrade(rule, targets),
          status,
          policyName: grant.name,
          policyId: grant.p,
          // The exact action names, as written. Never abbreviated, never replaced by a count.
          triggerActions: [...new Set(hits)],
          // A resource TYPE group and how many of it, plus the ARNs the digest sampled. The count is
          // the honest unit here - the digest carries at most eight ARNs of a group of nine hundred.
          targets: targets.map((u) => ({
            type: u.t,
            count: u.n,
            scope: u.scope,
            sample: u.sample ?? [],
            sampleComplete: u.sample_complete !== false,
            controlPlane: u.cp ?? [],
          })),
          restrictable: rule.forceRestrictable
            ?? !hits.some((a) => (grant.non_restrictable ?? []).includes(a)),
          blockedBy,
          relatedTo: rule.relatedTo ?? [],
          // Copied. Never composed, never interpolated - see T-4 and the header.
          narrative: rule.narrative,
          notes: rule.notes ?? null,
          truncated,
          omittedCount: null,
        });
      }
    } catch (error) {
      out.push({
        id: rule.id,
        axis,
        category: rule.category,
        title: rule.title,
        escalationGrade: rule.escalationGrade,
        assetImpactGrade: 'UNDETERMINED',
        assetEvidence: [],
        status: 'NOT_ASSESSABLE',
        policyName: grant.name,
        policyId: grant.p,
        triggerActions: [],
        targets: [],
        restrictable: rule.forceRestrictable ?? true,
        blockedBy: [`the rule could not be evaluated: ${error.message}`],
        relatedTo: rule.relatedTo ?? [],
        narrative: rule.narrative,
        notes: rule.notes ?? null,
        truncated: null,
        omittedCount: null,
      });
    }
   }
  }

  return out;
}

/**
 * Which axes a rule can answer for.
 *
 * policyNonRestrictable is the one that answers only one. It reads the actions a restriction may
 * never take away and attaches no units at all - R-1's card has said "대상 없음 — 부여된 능력입니다"
 * since it existed, which is the action axis in words. Filing it under the resource area was
 * describing a capability as a reach.
 */
function axesFor(rule) {
  if (rule.evaluatedOn === 'policyNonRestrictable') return [AXIS.ACTION];
  return [AXIS.RESOURCE, AXIS.ACTION];
}

/**
 * Every finding in a digest, sorted.
 *
 * The baseline grant is evaluated like any other. It is the widest policy in the account and the
 * one nobody looks at, and "this was already true before the request" is a fact for the reader to
 * weigh - not a reason to hide it. It is marked, and the caller can group it.
 */
export function findings(digest, rules = RULES, reference = null) {
  const out = [];
  for (const grant of digest.grants ?? []) {
    for (const finding of evaluateGrant(grant, digest, rules, reference)) {
      out.push({ ...finding, isBaseline: grant.is_baseline === true });
    }
  }
  return sortFindings(withTwins(out));
}

/**
 * Mark the findings that appear on both axes.
 *
 * The pair is one rule firing on one policy, seen twice - once as what it reaches now and once as
 * what it lets somebody do. Both areas show it deliberately, and without the mark the two areas
 * would read as two independent findings: the counts would double and an approver comparing them
 * would be trying to reconcile a difference that is only the question, not the answer.
 */
function withTwins(list) {
  const key = (f) => `${f.id} ${f.policyId}`;
  const byAxis = new Map();
  // Which rules actually fired on each policy, for relatedTo below.
  const firedOn = new Map();
  for (const finding of list) {
    byAxis.set(`${finding.axis} ${key(finding)}`, true);
    if (!firedOn.has(finding.policyId)) firedOn.set(finding.policyId, new Set());
    firedOn.get(finding.policyId).add(finding.id);
  }
  return list.map((finding) => ({
    ...finding,
    alsoOnOtherAxis: byAxis.has(
      `${finding.axis === AXIS.ACTION ? AXIS.RESOURCE : AXIS.ACTION} ${key(finding)}`),
    // The related rules that are ACTUALLY here, not the ones the rule file hoped for.
    //
    // The card said "E-1 과 같은 정책에서 함께 성립합니다" whenever relatedTo was non-empty, which
    // is a claim about this account and was printed without checking it - R-1 says it on every
    // policy carrying the four IAM reads, including ones where E-1 never fired. R-1's own note
    // asks for the conditional ("동일 정책에서 E-1이 발화한 경우"); nothing was applying it.
    relatedFired: (finding.relatedTo ?? []).filter(
      (id) => firedOn.get(finding.policyId)?.has(id)),
  }));
}

/** escalationGrade desc, then status, then id. assetImpactGrade is never a key (T-7). */
export function sortFindings(list) {
  const statusOrder = new Map((SORT.statusOrder ?? Object.keys(STATUS_ORDER))
    .map((s, i) => [s, i]));
  return [...list].sort((a, b) =>
    (GRADE_ORDER[a.escalationGrade] ?? 9) - (GRADE_ORDER[b.escalationGrade] ?? 9)
    || (statusOrder.get(a.status) ?? 9) - (statusOrder.get(b.status) ?? 9)
    || a.id.localeCompare(b.id)
    || String(a.policyId).localeCompare(String(b.policyId)));
}

/** Findings grouped for display, in the section order the rules file states. */
export function sections(list) {
  const order = SECTION_ORDER.length ? SECTION_ORDER : ['ESCALATION', 'EXPOSURE', 'RECON', 'DESTRUCTIVE'];
  return order
    .map((category) => ({ category, findings: list.filter((f) => f.category === category) }))
    .filter((section) => section.findings.length > 0);
}

/** Counts an approver reads before any card. */
export function summary(list) {
  const by = (key) => list.reduce((acc, f) => {
    acc[f[key]] = (acc[f[key]] ?? 0) + 1;
    return acc;
  }, {});
  return {
    total: list.length,
    byGrade: by('escalationGrade'),
    byStatus: by('status'),
    byCategory: by('category'),
    notRestrictable: list.filter((f) => !f.restrictable).length,
    enumerationIncomplete: list.filter((f) => f.truncated !== false).length,
  };
}

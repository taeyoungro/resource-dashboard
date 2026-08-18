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

import { RULES, SECTION_ORDER, SORT } from './rules.js';
import { ROLES } from './controlPlane.js';

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

/** Collect the actions that satisfied a predicate, or null if it is not satisfied. */
function match(predicate, available) {
  if ('action' in predicate) {
    return available.has(predicate.action) ? [predicate.action] : null;
  }
  if ('anyOf' in predicate) {
    for (const sub of predicate.anyOf) {
      const hit = match(sub, available);
      if (hit) return hit;
    }
    return null;
  }
  const acc = [];
  for (const sub of predicate.allOf) {
    const hit = match(sub, available);
    if (!hit) return null;
    acc.push(...hit);
  }
  return acc;
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
function scopeUnits(rule, grant) {
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
function resolveStatus(rule, grant, digest, unit, truncated) {
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
    down('UNVERIFIED', 'the statement named resources, and the assessment unions the actions of '
      + 'every statement into one group per resource type - these actions may be held on '
      + 'different resources');
  }

  if (rule.upperBound) {
    if (truncated === true) {
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
  return false;
}

/**
 * Fire every rule against one grant.
 *
 * A rule whose evaluation throws is recorded as a NOT_ASSESSABLE finding for that rule alone and
 * the rest keep going (T-3). A rule engine that stops at the first exception reports fewer
 * findings than there are, and reports it as a clean result.
 */
export function evaluateGrant(grant, digest, rules = RULES) {
  const out = [];

  for (const rule of rules) {
    try {
      for (const unit of scopeUnits(rule, grant)) {
        const available = new Set(unit.actions);
        const hits = match(rule.predicate, available);
        if (!hits) continue;

        const contributing = unit.units.filter((u) =>
          unitActions(grant, u).some((a) => hits.includes(a)));
        const targets = contributing.length ? contributing : unit.units;
        const truncated = truncationOf(targets);
        const { status, blockedBy } = resolveStatus(rule, grant, digest, unit, truncated);

        out.push({
          id: rule.id,
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

  return out;
}

/**
 * Every finding in a digest, sorted.
 *
 * The baseline grant is evaluated like any other. It is the widest policy in the account and the
 * one nobody looks at, and "this was already true before the request" is a fact for the reader to
 * weigh - not a reason to hide it. It is marked, and the caller can group it.
 */
export function findings(digest, rules = RULES) {
  const out = [];
  for (const grant of digest.grants ?? []) {
    for (const finding of evaluateGrant(grant, digest, rules)) {
      out.push({ ...finding, isBaseline: grant.is_baseline === true });
    }
  }
  return sortFindings(out);
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

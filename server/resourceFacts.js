// What the page can say about ONE resource in the relationship picture, when a reader clicks it.
//
// Three questions meet here, and each of them is already answered somewhere else in this page:
//
//   무엇을 할 수 있나   The impact assessment. The group this resource sits in carries the actions
//                       that reach its TYPE, and the assessment's action reference carries each
//                       action's AWS access level.
//   정책 기반 분석      The rule findings. Each finding names its targets by type, with a sample of
//                       ARNs and a flag saying whether the sample is the whole group.
//   AI 분석             The model findings, in the same Finding shape, marked source: 'model'.
//
// THE JOIN IS THE WHOLE PROBLEM, and it is the reason this is a module with tests rather than a
// filter written inline in the panel. A finding names a TYPE and a SAMPLE, not "this resource":
//
//   named      the resource's ARN is in a target's sample. The finding reaches THIS resource, and
//              the panel may say so flatly.
//   typed      a target has this resource's type, the ARN is not in the sample, and the sample is
//              NOT complete. The finding may or may not reach this one - nobody can tell from the
//              assessment, and the panel says exactly that.
//   elsewhere  a target has this type, the sample IS complete, and this ARN is not in it. The
//              finding does NOT reach this resource. Counted, never listed as if it did.
//
// Folding `typed` into `named` would put a red grade on a resource nothing said was reachable;
// dropping it would hide a finding that probably does reach it. Both are lies a count can prevent,
// so the panel carries three numbers and this module decides which is which.
//
//     node --test server/resourceFacts.test.js

/** CRITICAL first. The order the findings list is sorted in, and the order a summary counts in. */
export const GRADE_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4 };
/** Most dangerous first: what an approver looks for before anything else. */
export const LEVEL_ORDER = {
  'Permissions management': 0, Write: 1, Tagging: 2, Read: 3, List: 4,
};
export const LEVEL_LABEL = {
  'Permissions management': '권한 관리',
  Write: '쓰기',
  Tagging: '태그',
  Read: '읽기',
  List: '목록',
};
// The grade, status and category NAMES are not here. src/grades.ts holds one copy for the whole
// page, and its own comment says why: two screens that call the same grade by two words are two
// screens an approver cannot compare. This module returns the raw vocabulary and the panel labels
// it from there.

/** How this resource is related to a finding, and what the panel says about it. */
export const REACH_LABEL = {
  named: '이 자원을 지목했다',
  typed: '이 유형에 걸렸다 — 목록이 잘려 이 자원인지는 알 수 없다',
};

const idOf = (arn) => String(arn ?? '').split('/').pop().split(':').pop();

/**
 * One action, with the level AWS gives it.
 *
 * The level comes from the assessment's own action reference and never from a table of this
 * dashboard's own: that table was a second copy of data AWS owns and had drifted from it. An
 * action the reference does not carry gets a null level, which the panel prints as 「등급 없음」
 * rather than guessing - an assessment written before the reference existed has none of them.
 */
function actionRows(group, reference) {
  const service = String(group?.service ?? '');
  const table = reference?.services?.[service] ?? {};
  return [...new Set(group?.actions ?? [])].map((name) => {
    const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    const entry = table[bare];
    return {
      name,
      level: Array.isArray(entry) ? entry[0] : null,
      /** True when the action BRINGS THIS TYPE INTO BEING rather than acting on one that exists. */
      makes: Array.isArray(entry) ? entry[2] === true : false,
    };
  }).sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9)
    || a.name.localeCompare(b.name));
}

/**
 * How one finding reaches one resource: 'named', 'typed', 'elsewhere', or null for not at all.
 *
 * A finding with no targets at all reaches nothing here. That is not a gap - an action-axis
 * finding is about what the policy lets somebody DO, and the panel's own action list is where
 * that shows up.
 */
export function reachOf(finding, arn, resourceType) {
  let best = null;
  for (const target of finding?.targets ?? []) {
    if (target?.type !== resourceType) continue;
    const sample = target.sample ?? [];
    if (sample.includes(arn)) return { reach: 'named', target };
    // sampleComplete is a claim about the GROUP: true means the sample is all of it. Absent is not
    // a claim, so it is read as incomplete - the honest reading of an older assessment.
    if (target.sampleComplete === true) {
      if (!best) best = { reach: 'elsewhere', target };
      continue;
    }
    best = { reach: 'typed', target };
  }
  return best;
}

/** The card the panel draws for one finding, with the actions that reach THIS type. */
function findingCard(finding, hit) {
  return {
    id: finding.id,
    title: finding.title,
    category: finding.category,
    grade: finding.escalationGrade,
    status: finding.status,
    /** 'model' for the AI half, 'rule' for the rule half. The panel draws them in two sections. */
    source: finding.source === 'model' ? 'model' : 'rule',
    policyName: finding.policyName ?? '',
    policyId: finding.policyId ?? '',
    restrictable: finding.restrictable !== false,
    reach: hit.reach,
    reachLabel: REACH_LABEL[hit.reach] ?? '',
    /** The trigger actions that reach this resource's type - not every action of the finding. */
    actions: [...(hit.target?.actions ?? finding.triggerActions ?? [])].sort(),
    requiredActions: [...(finding.requiredActions ?? [])].sort(),
  };
}

const bySeverity = (a, b) => (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9)
  || a.id.localeCompare(b.id);

/**
 * Everything the panel shows for one resource.
 *
 * `policy` is the policy the picture was drawn for; `findings` is every finding the page holds,
 * from both halves and from every scope, deduplicated by id by the caller. Returns null when the
 * arn is in no group of this policy - which is the state for a container border, and the panel
 * then draws nothing.
 */
export function resourceFacts(policy, reference, findings, arn) {
  let group = null;
  let row = null;
  for (const candidate of policy?.affected ?? []) {
    const found = (candidate?.resources ?? []).find((r) => r?.arn === arn);
    if (found) { group = candidate; row = found; break; }
  }
  if (!group) return null;

  const named = [];
  const typed = [];
  let elsewhere = 0;
  const seen = new Set();
  for (const finding of findings ?? []) {
    if (!finding?.id || seen.has(finding.id)) continue;
    const hit = reachOf(finding, arn, group.resource_type);
    if (!hit) continue;
    seen.add(finding.id);
    if (hit.reach === 'elsewhere') { elsewhere += 1; continue; }
    (hit.reach === 'named' ? named : typed).push(findingCard(finding, hit));
  }
  named.sort(bySeverity);
  typed.sort(bySeverity);

  const actions = actionRows(group, reference);
  const levels = [];
  for (const action of actions) {
    const key = action.level ?? '';
    const at = levels.find((l) => l.level === key);
    if (at) at.count += 1;
    else levels.push({ level: key, label: LEVEL_LABEL[key] ?? '등급 없음', count: 1 });
  }
  levels.sort((a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9));

  const cards = [...named, ...typed];
  const worst = cards.reduce(
    (best, c) => ((GRADE_ORDER[c.grade] ?? 9) < (GRADE_ORDER[best] ?? 9) ? c.grade : best), 'NONE',
  );
  return {
    arn,
    id: idOf(arn),
    resourceType: group.resource_type,
    service: group.service,
    name: row?.tags?.Name ?? row?.alias ?? '',
    region: row?.region ?? '',
    tags: row?.tags ?? {},
    sensitive: !!row?.sensitive,
    /** '*' means the statement named no resource: the count is today's and it will cover what is
     *  made next. The panel says so - it changes what a restriction can do. */
    scope: group.scope ?? null,
    /** 'service' means the reference could not decide which actions reach this type, so the list
     *  below is every action of the service. Marked, never silently widened. */
    attribution: group.attribution ?? null,
    truncated: !!group.truncated,
    groupTotal: Number(group.total) || 0,
    actions,
    levels,
    findings: { named, typed, elsewhere },
    /** The worst grade among the findings that reach this resource, for the plate's own mark. */
    worstGrade: cards.length > 0 ? worst : null,
    /** A route table's routes, as the querier read them: where each one sends traffic and where
     *  to. Empty for every other type, and empty on a route table read before the querier
     *  recorded them - the panel tells the two apart by the resource type. */
    routes: Array.isArray(row?.routes)
      ? row.routes.map((r) => ({
        destination: `${r?.destination ?? ''}`,
        target: `${r?.target ?? ''}`,
        state: `${r?.state ?? ''}`,
      })).filter((r) => r.destination && r.target)
      : [],
  };
}

/**
 * Which resources carry a finding at all, as arn -> the worst grade reaching it.
 *
 * The picture reads this to mark a plate before anything is clicked: an approver should not have
 * to click thirty plates to find the one a rule fired on. Only `named` counts - a mark on every
 * resource of a type whose sample was cut would be a mark that means nothing.
 */
export function gradesByResource(policy, findings) {
  const out = new Map();
  const arns = new Set();
  for (const group of policy?.affected ?? []) {
    for (const r of group?.resources ?? []) if (r?.arn) arns.add(r.arn);
  }
  for (const finding of findings ?? []) {
    for (const target of finding?.targets ?? []) {
      for (const arn of target?.sample ?? []) {
        if (!arns.has(arn)) continue;
        const grade = finding.escalationGrade;
        const at = out.get(arn);
        if (!at || (GRADE_ORDER[grade] ?? 9) < (GRADE_ORDER[at] ?? 9)) out.set(arn, grade);
      }
    }
  }
  return out;
}

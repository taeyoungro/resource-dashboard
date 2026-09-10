// The judgement rules, loaded from finding-rules.json rather than written here.
//
// Why a data file at all: the rules are the part of this analysis a security reviewer reads and
// argues with, and a reviewer cannot argue with a predicate spread across three JavaScript
// functions. Keeping them as data also makes them hashable - every finding this dashboard shows
// carries the sha256 of the exact bytes that produced it, so "why did this fire" is answerable
// against a specific version of the file and not against whatever the code happened to be.
//
// Why it refuses to start (IMPLEMENTATION.md T-2): a missing or malformed rule file that fell back
// to an empty rule set would produce a page reading "0 findings", which is the same page a clean
// grant produces. There is no way for an approver to tell those apart, so the process does not
// offer them the choice - it does not come up.
//
// The validation below is not a schema library. It is the specific set of mistakes that would let
// a rule silently never fire: an action name with a wildcard in it (the engine matches exact
// strings, so 'ec2:*' matches nothing), an evaluation scope that does not exist, a relatedTo
// pointing at a rule id that was renamed, a sort key the design forbids.
//
// Three kinds of relation, and the card draws only one of them
// -----------------------------------------------------------
// The file used to have one field, relatedTo, doing two jobs. X-5 and X-6 compose - a disk copy is
// what there is to share - and D-5 and D-6 are alternatives, same target and different residue. One
// undirected field could say neither, so the flow picture had nothing to draw an order from.
//
//   enables         direction ESTABLISHED, and established by the rule's own notes rather than by
//                   whoever added the edge. This is the only field the flow picture reads
//   contrastsWith   same target, different residue. Explicitly NOT a sequence
//   relatedTo       related, direction not established. X-8 and X-9 sit here: reading a layer and
//                   sharing one belong together, and neither note says which comes first
//
// The wire keeps relatedTo as the union of all three so the card's "together on this policy" badge
// is unchanged, and it gains the reverse direction it never had - X-6 now lists V-2, which enables
// it. Symmetry is not required of the file for that reason: the union supplies it.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAP } from './capabilities.js';
// The same ruler the picture measures plate text with. Importing it rather than restating the
// arithmetic is the point: a bound derived twice is a bound that will disagree with itself.
import { textUnits } from './topology.js';

export class RuleError extends Error {}

const GRADES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];
const ASSET_GRADES = [...GRADES, 'UNDETERMINED'];
const STATUSES = ['CONFIRMED', 'UNVERIFIED', 'NOT_ASSESSABLE'];
// EVASION and COST joined the four the design shipped with. Evasion is turning a control or a
// record off - it reaches nothing itself and is why something else succeeds - and cost is a
// bill rather than a breach, kept apart so it never sits in a section an approver reads for
// compromise.
const CATEGORIES = ['ESCALATION', 'EXPOSURE', 'EVASION', 'RECON', 'DESTRUCTIVE', 'COST'];
const SCOPES = ['policyActionUnion', 'resourceActionSet', 'policyNonRestrictable'];
/** The relation fields, and whether the flow picture reads them. */
const RELATIONS = ['enables', 'contrastsWith', 'relatedTo'];
/**
 * How wide a stepLabel may be, in the units topology.js measures plate text in.
 *
 * Measured rather than counted, with the SAME ruler the picture uses. A character count is the
 * wrong bound here - 'V-2' and '보호 해제' are both under it and differ by a factor of three in
 * width - and the failure it lets through is silent: nothing on screen says a word was clipped, so
 * a label that does not fit is worse than a rule file that refuses to load.
 *
 * The budget is findingPath.js's plate: LINK_W 88px less 8px of padding a side, at the 11.09px per
 * unit that topology.js's own width tests establish. That is 6.49 units, or about six Korean
 * glyphs.
 */
const STEP_LABEL_UNITS = (88 - 16) / (112 / 10.1);
/** The closed capability vocabulary a predicate may name. Anything else is a typo, not a category. */
const CAPABILITIES = new Set(Object.values(CAP));

/** Every action name a predicate mentions, in the order it mentions them. */
function predicateActions(predicate, where, out) {
  if (!predicate || typeof predicate !== 'object') {
    throw new RuleError(`${where}: predicate must be an object`);
  }
  if ('capability' in predicate) {
    // A term that fires on what an action DOES rather than on what it is called.
    //
    // The rules named 33 action names against 12,328 mutating actions, and a name is only there if
    // somebody wrote it down - which is why X-2 knew ec2:CreateRoute and not
    // ec2:ReplaceRouteTableAssociation, though the second reaches the same place without any of the
    // four actions X-2 names. A capability term covers the ones nobody has written down yet.
    //
    // It contributes NO name to RULE_ACTIONS, and that matters: RULE_ACTIONS is what survives the
    // digest's complete-service fold. The fold keeps anything the reference classifies for exactly
    // this reason - see riskDigest - so a capability term still has actions to match on inside a
    // wholly granted service.
    if (!CAPABILITIES.has(predicate.capability)) {
      throw new RuleError(`${where}: capability ${JSON.stringify(predicate.capability)} is not one `
        + `of ${[...CAPABILITIES].sort().join(', ')}`);
    }
    return out;
  }
  if ('action' in predicate) {
    const action = predicate.action;
    if (typeof action !== 'string' || !action.includes(':')) {
      throw new RuleError(`${where}: action must be "service:Action", got ${JSON.stringify(action)}`);
    }
    // The one that matters. finding-rules.json says it in its own description, and a wildcard here
    // would not throw at match time - it would quietly match nothing, forever.
    if (action.includes('*')) {
      throw new RuleError(`${where}: action ${action} contains a wildcard, and matching is by exact `
        + 'string. Name every action the rule fires on');
    }
    out.push(action);
    return out;
  }
  const branch = 'anyOf' in predicate ? 'anyOf' : 'allOf' in predicate ? 'allOf' : null;
  if (!branch) {
    throw new RuleError(`${where}: predicate needs one of action, capability, anyOf, allOf`);
  }
  const subs = predicate[branch];
  if (!Array.isArray(subs) || subs.length === 0) {
    throw new RuleError(`${where}: ${branch} must be a non-empty array`);
  }
  subs.forEach((sub, i) => predicateActions(sub, `${where}.${branch}[${i}]`, out));
  return out;
}

function checkRule(rule, index, seen) {
  const where = `rules[${index}]`;
  const id = rule?.id;
  if (typeof id !== 'string' || !id) throw new RuleError(`${where}: id is required`);
  if (seen.has(id)) throw new RuleError(`${where}: duplicate rule id ${id}`);
  seen.add(id);

  const at = `rule ${id}`;
  if (typeof rule.title !== 'string' || !rule.title) throw new RuleError(`${at}: title is required`);
  if (rule.stepLabel !== undefined) {
    if (typeof rule.stepLabel !== 'string' || !rule.stepLabel) {
      throw new RuleError(`${at}: stepLabel must be a non-empty string`);
    }
    const wide = textUnits(rule.stepLabel);
    if (wide > STEP_LABEL_UNITS) {
      throw new RuleError(`${at}: stepLabel ${JSON.stringify(rule.stepLabel)} measures `
        + `${wide.toFixed(2)} units and one plate of the flow picture holds `
        + `${STEP_LABEL_UNITS.toFixed(2)}`);
    }
  }
  if (typeof rule.narrative !== 'string' || !rule.narrative) {
    throw new RuleError(`${at}: narrative is required`);
  }
  if (!CATEGORIES.includes(rule.category)) {
    throw new RuleError(`${at}: category must be one of ${CATEGORIES.join(', ')}`);
  }
  if (!GRADES.includes(rule.escalationGrade)) {
    throw new RuleError(`${at}: escalationGrade must be one of ${GRADES.join(', ')}`);
  }
  if (!ASSET_GRADES.includes(rule.assetImpactGrade)) {
    throw new RuleError(`${at}: assetImpactGrade must be one of ${ASSET_GRADES.join(', ')}`);
  }
  if (!SCOPES.includes(rule.evaluatedOn)) {
    throw new RuleError(`${at}: evaluatedOn must be one of ${SCOPES.join(', ')}`);
  }
  if (rule.whenNoUnits !== undefined) {
    // Retired, and refused rather than ignored. It named the scope a resourceActionSet rule fell
    // back to when the grant enumerated nothing, so the capability it described was still reported
    // on an empty account. findings.js now evaluates EVERY rule on the action axis as well as the
    // resource one, unconditionally - so a rule carrying this would be asked its policy-scope
    // question twice and would print the finding twice on an account with nothing in it. Silently
    // ignoring the field would leave that duplicate for somebody to find on screen.
    throw new RuleError(`${at}: whenNoUnits is retired - every rule is evaluated on the action `
      + 'axis as well as the resource one, which is what this asked for and is no longer '
      + 'conditional on the account being empty. Remove the field');
  }
  if (rule.axes !== undefined) {
    // Which of the two questions this rule can answer. Omitted means both, which is the ordinary
    // case. A rule naming ['action'] says its subject is not a reach over resources at all - a
    // bill, or a setting - and the resource axis would otherwise attach whatever types its actions
    // happen to name and call them the finding's targets.
    if (!Array.isArray(rule.axes) || rule.axes.length === 0
        || rule.axes.some((a) => a !== 'action' && a !== 'resource')) {
      throw new RuleError(`${at}: axes must be a non-empty array of "action" and/or "resource"`);
    }
  }
  if (rule.forceRestrictable !== undefined && typeof rule.forceRestrictable !== 'boolean') {
    throw new RuleError(`${at}: forceRestrictable must be a boolean`);
  }
  if (rule.upperBound) {
    const bound = rule.upperBound;
    if (typeof bound.requires !== 'string' || !bound.requires) {
      throw new RuleError(`${at}: upperBound.requires is required`);
    }
    for (const key of ['onUnreadableConstraintPolicy', 'onTruncatedResourceList']) {
      if (!STATUSES.includes(bound[key])) {
        throw new RuleError(`${at}: upperBound.${key} must be one of ${STATUSES.join(', ')}`);
      }
    }
  }
  const actions = predicateActions(rule.predicate, `${at}.predicate`, []);
  return actions;
}

/** The first cycle in the enables graph, as the path that closes it, or null. */
function findCycle(rules) {
  const out = new Map(rules.map((r) => [r.id, r.enables ?? []]));
  const state = new Map();
  const path = [];
  const walk = (id) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'open');
    path.push(id);
    for (const next of out.get(id) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const rule of rules) {
    const found = walk(rule.id);
    if (found) return found;
  }
  return null;
}

/**
 * Validate a parsed rule document. Throws RuleError on anything that would make a rule unable to
 * fire, or a finding unable to be sorted as the design says.
 */
export function validate(doc) {
  if (!doc || typeof doc !== 'object') throw new RuleError('rule document must be an object');
  if (typeof doc.schemaVersion !== 'string') throw new RuleError('schemaVersion is required');
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    throw new RuleError('rules must be a non-empty array - an empty rule set reports every grant '
      + 'as clean, which is indistinguishable from a grant that is clean');
  }

  const seen = new Set();
  const actions = new Set();
  for (const [index, rule] of doc.rules.entries()) {
    for (const action of checkRule(rule, index, seen)) actions.add(action);
  }

  const stepLabels = new Map(doc.rules.map((r) => [r.id, r.stepLabel]));
  for (const rule of doc.rules) {
    for (const field of RELATIONS) {
      const targets = rule[field];
      if (targets === undefined) continue;
      if (!Array.isArray(targets) || targets.length === 0) {
        throw new RuleError(`rule ${rule.id}: ${field} must be a non-empty array`);
      }
      for (const target of targets) {
        if (!seen.has(target)) {
          throw new RuleError(`rule ${rule.id}: ${field} names ${target}, which is not a rule here`);
        }
        if (target === rule.id) throw new RuleError(`rule ${rule.id}: ${field} names itself`);
      }
    }
    // A pair cannot be both a sequence and an alternative. The two fields say opposite things about
    // the same two rules, and the picture would draw an order the contrast denies.
    for (const target of rule.enables ?? []) {
      if ((rule.contrastsWith ?? []).includes(target)) {
        throw new RuleError(`rule ${rule.id}: ${target} is in both enables and contrastsWith`);
      }
      // Both ends, because the picture draws both plates and a plate needs a word in it.
      for (const end of [rule.id, target]) {
        if (!stepLabels.get(end)) {
          throw new RuleError(`rule ${end}: an enables edge puts it in the flow picture, so it `
            + 'needs a stepLabel');
        }
      }
    }
    for (const related of rule.relatedTo ?? []) {
      if (!seen.has(related)) {
        throw new RuleError(`rule ${rule.id}: relatedTo names ${related}, which is not a rule here`);
      }
    }
    // A rule that stands down where a sharper one fired. Same check as relatedTo and for the same
    // reason - a renamed id would silently stop superseding, and the symptom is two cards for one
    // decision rather than an error.
    for (const sharper of rule.supersededBy ?? []) {
      if (!seen.has(sharper)) {
        throw new RuleError(`rule ${rule.id}: supersededBy names ${sharper}, which is not a rule here`);
      }
      if (sharper === rule.id) {
        throw new RuleError(`rule ${rule.id}: supersededBy names itself`);
      }
    }
  }

  // A cycle in enables has no column order, so the picture could not place a plate at all. Refused
  // at load rather than broken at render: a cycle is a mistake in the file and the file is what a
  // reviewer reads.
  const cycle = findCycle(doc.rules);
  if (cycle) {
    throw new RuleError(`enables has a cycle: ${cycle.join(' -> ')}. A flow needs an order`);
  }

  const sort = doc.sort ?? {};
  const forbidden = sort.forbiddenKeys ?? [];
  for (const key of sort.keys ?? []) {
    const field = String(key).split(':')[0];
    if (forbidden.includes(field)) {
      throw new RuleError(`sort.keys uses ${field}, which sort.forbiddenKeys forbids`);
    }
  }
  for (const status of sort.statusOrder ?? []) {
    if (!STATUSES.includes(status)) throw new RuleError(`sort.statusOrder has unknown ${status}`);
  }
  const sections = doc.sectionOrder ?? [];
  for (const rule of doc.rules) {
    if (sections.length && !sections.includes(rule.category)) {
      throw new RuleError(`rule ${rule.id}: category ${rule.category} has no place in sectionOrder`);
    }
  }

  return { rules: doc.rules, actions, sort, sectionOrder: sections,
           forbiddenNarrativeSources: doc.forbiddenNarrativeSources ?? [] };
}

const PATH = join(dirname(fileURLToPath(import.meta.url)), 'finding-rules.json');

function load() {
  let raw;
  try {
    raw = readFileSync(PATH, 'utf-8');
  } catch (error) {
    throw new RuleError(`cannot read ${PATH}: ${error.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new RuleError(`${PATH} is not valid JSON: ${error.message}`);
  }
  const checked = validate(doc);
  return {
    ...checked,
    // Over the bytes as they sit on disk, not over a re-serialisation of the parsed object. It is
    // the file a reviewer opens, so it is the file that gets hashed.
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

const loaded = load();

export const RULES = loaded.rules;
/** Every action any predicate names. The digest keeps these by name even inside a folded service. */
export const RULE_ACTIONS = loaded.actions;
export const RULES_SHA256 = loaded.sha256;
export const SORT = loaded.sort;
export const SECTION_ORDER = loaded.sectionOrder;
/** Fields a narrative may never be derived from (T-4). Enforced in findings.js. */
export const FORBIDDEN_NARRATIVE_SOURCES = loaded.forbiddenNarrativeSources;

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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAP } from './capabilities.js';

export class RuleError extends Error {}

const GRADES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];
const ASSET_GRADES = [...GRADES, 'UNDETERMINED'];
const STATUSES = ['CONFIRMED', 'UNVERIFIED', 'NOT_ASSESSABLE'];
const CATEGORIES = ['ESCALATION', 'EXPOSURE', 'RECON', 'DESTRUCTIVE'];
const SCOPES = ['policyActionUnion', 'resourceActionSet', 'policyNonRestrictable'];
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

  for (const rule of doc.rules) {
    for (const related of rule.relatedTo ?? []) {
      if (!seen.has(related)) {
        throw new RuleError(`rule ${rule.id}: relatedTo names ${related}, which is not a rule here`);
      }
    }
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

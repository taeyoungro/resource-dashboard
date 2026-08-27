// Restriction templates - a decision an organisation makes once, offered on every plan.
//
// The thing an organisation asks for after the third permission set: "we always deny function URLs
// on production, stop making me tick it." The obvious shape for that is a policy installed at
// account creation, and this deliberately is NOT that. Three reasons, and they are the same reason
// three times:
//
//   there is nothing to attach to   the permission set does not exist until a plan is approved and
//                                   applied, so at account-creation time there is no document
//   the merge REPLACES              the writer owns every AdminDeny statement and replaces them
//                                   wholesale, so a template installed under that prefix is
//                                   discarded by the first approved restriction - and one
//                                   installed under any other prefix is invisible to the assessment
//                                   while still spending the quota
//   it would have no reviewer       every statement in that document traces to one Decision, in one
//                                   approval marker, bound to one assessment digest, written by the
//                                   one authority. A statement with no reviewer, no comment and no
//                                   expected_impact_sha256 is the one thing the marker contract
//                                   exists to make impossible
//
// So a template is a PRE-FILLED FORM, not a policy. It seeds the restriction array an approver is
// already looking at; they see it, edit it, and approve it for this plan. Every gate the route and
// the writer hold still runs, unchanged, because what arrives at them is an ordinary decision.
//
// The binding is per plan and cannot be otherwise. A template names ACTIONS - it is written once,
// for an organisation, and cannot know which attached policy grants what in this account - so
// seeding resolves each action against this assessment's own grants. Actions nothing grants are
// dropped and NAMED: a template that silently shrinks reads as a control that was applied.

export class TemplateError extends Error {}

const INTENTS = new Set(['deny_action', 'tag_condition', 'key_condition']);
const OPERATORS = new Set(['StringNotEquals', 'StringEquals']);

/**
 * Check one template, or refuse it by name.
 *
 * Only the three unscoped intents. allow_only and deny_only name ARNs, and an ARN is an account
 * fact - a template carrying one would either name a resource that does not exist in the account
 * being approved, or would have to be rewritten per account, which is not a template. The three
 * that remain are exactly the three that say something without an inventory, which is also why
 * they are the three that work on a new account.
 */
export function validateTemplate(template, at = 'template') {
  if (!template || typeof template !== 'object') {
    throw new TemplateError(`${at}: not an object`);
  }
  for (const field of ['id', 'title', 'why']) {
    if (typeof template[field] !== 'string' || !template[field].trim()) {
      throw new TemplateError(`${at}: ${field} is required`);
    }
  }
  const rows = template.restrictions;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new TemplateError(`${at}: restrictions must be a non-empty array`);
  }
  for (const [index, row] of rows.entries()) {
    const where = `${at}.restrictions[${index}]`;
    if (!INTENTS.has(row?.intent)) {
      throw new TemplateError(
        `${where}: intent must be one of ${[...INTENTS].join(', ')}. A template names no ARNs - `
        + 'those are an account fact, and a template that carried one would have to be rewritten '
        + 'per account',
      );
    }
    if (!Array.isArray(row.actions) || row.actions.length === 0
        || row.actions.some((a) => typeof a !== 'string' || !a.trim())) {
      throw new TemplateError(`${where}: actions must be a non-empty array of strings`);
    }
    if (row.actions.some((a) => a.includes('*'))) {
      // A wildcard would resolve to a different set of actions in every account, so what the
      // template says would depend on where it landed - and the whole point is that it says one
      // thing everywhere and an approver reads exactly what they are agreeing to.
      throw new TemplateError(`${where}: a template names actions literally, never with a wildcard`);
    }
    if (row.intent === 'tag_condition') {
      if (!row.tag_key || !Array.isArray(row.tag_values) || row.tag_values.length === 0) {
        throw new TemplateError(`${where}: a tag_condition template needs tag_key and tag_values`);
      }
    }
    if (row.intent === 'key_condition') {
      if (!row.condition_key || !Array.isArray(row.condition_values)
          || row.condition_values.length === 0) {
        throw new TemplateError(
          `${where}: a key_condition template needs condition_key and condition_values`);
      }
    }
    if (row.condition_operator !== undefined && !OPERATORS.has(row.condition_operator)) {
      throw new TemplateError(
        `${where}: condition_operator must be one of ${[...OPERATORS].join(', ')}`);
    }
  }
  return template;
}

export function loadTemplates(document) {
  const list = document?.templates;
  if (!Array.isArray(list)) throw new TemplateError('the template file has no templates array');
  const seen = new Set();
  for (const [index, template] of list.entries()) {
    validateTemplate(template, `templates[${index}]`);
    if (seen.has(template.id)) throw new TemplateError(`templates[${index}]: ${template.id} twice`);
    seen.add(template.id);
  }
  return list;
}

/**
 * Which attached policies grant an action, from the assessment itself.
 *
 * actions_offerable is the expanded list - wildcards already resolved by the container - so a
 * policy granting s3:* is found for s3:DeleteObject without this file expanding anything, which it
 * has no table to do.
 */
function grantedBy(assessment, action) {
  const out = [];
  for (const policy of assessment?.policies ?? []) {
    if (policy.restrictable === false || policy.unreadable) continue;
    const granted = policy.actions_offerable ?? policy.actions_granted ?? [];
    if (granted.includes(action)) out.push(policy.identifier);
  }
  return out;
}

/**
 * Turn a template into restrictions for THIS plan, and say what did not survive.
 *
 * One restriction per (policy, action), which is the shape the editor and the writer already use -
 * so a seeded row is indistinguishable from one an approver ticked, and every gate downstream sees
 * an ordinary decision.
 *
 * `dropped` is the honest half. An action no attached policy grants cannot be restricted - the
 * writer refuses it by name ("not granted by the policies being approved") - and an action the
 * assessment marks protected is the declaration path. Both are returned rather than removed in
 * silence, because a template that quietly shrank reads as a control that was fully applied.
 */
export function seedFromTemplate(template, assessment) {
  validateTemplate(template);
  const protectedActions = new Set(assessment?.protected_actions ?? []);
  const untaggable = new Set(assessment?.action_reference?.no_resource_tag ?? []);
  const restrictions = [];
  const dropped = [];

  for (const row of template.restrictions) {
    for (const action of row.actions) {
      if (protectedActions.has(action)) {
        dropped.push({ action, why: 'protected' });
        continue;
      }
      const policies = grantedBy(assessment, action);
      if (policies.length === 0) {
        dropped.push({ action, why: 'not_granted' });
        continue;
      }
      // A tag condition on an action AWS reads no resource tag for is recorded and never
      // evaluated, and the route refuses it. Dropped here so a template cannot make a decision
      // that is refused at submit time, after the approver believed it applied.
      if (row.intent === 'tag_condition' && untaggable.has(action)) {
        dropped.push({ action, why: 'no_resource_tag' });
        continue;
      }
      for (const policy of policies) {
        restrictions.push({
          policy,
          intent: row.intent,
          actions: [action],
          ...(row.intent === 'tag_condition'
            ? { tag_key: row.tag_key, tag_values: [...row.tag_values],
                // The closed form unless the template says otherwise: a template is written once
                // and read on every plan, so the form that fails safe is the one to default to.
                condition_operator: row.condition_operator ?? 'StringNotEquals' }
            : {}),
          ...(row.intent === 'key_condition'
            ? { condition_key: row.condition_key, condition_values: [...row.condition_values],
                condition_operator: row.condition_operator ?? 'StringNotEquals' }
            : {}),
        });
      }
    }
  }
  return { restrictions, dropped };
}

/**
 * Merge seeded restrictions into what the approver already has.
 *
 * Replaces any earlier decision on the same (policy, action) - the editor's own rule is one action,
 * one section, and an appended duplicate would be the contradiction that rule exists to prevent.
 * Same semantics as blockPath.mergeBlock, and deliberately the same words.
 */
export function mergeTemplate(existing, seeded) {
  const claimed = new Set(
    seeded.flatMap((r) => (r.actions ?? []).map((a) => `${r.policy} ${a}`)),
  );
  const kept = (existing ?? []).map((r) => ({
    ...r,
    actions: (r.actions ?? []).filter((a) => !claimed.has(`${r.policy} ${a}`)),
  })).filter((r) => r.actions.length > 0);
  return [...kept, ...seeded];
}

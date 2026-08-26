// What a composed document does to a resource that does not exist yet.
//
// The new-account question. An administrator restricting an account with no Lambda functions in it
// has nothing to point at, so the only check on what they just wrote is to describe a resource that
// WILL exist and ask the document about it:
//
//     arn:aws:lambda:ap-northeast-2:1234:function:prod-api, Environment=production
//     lambda:CreateFunctionUrlConfig  ->  DENIED_BY AdminDeny3
//
// NOT the authority, and pinned like the preview beside it. event_pipeline's
// code/generator/virtual_resource.py is the one that decides, and server/fixtures/inline-preview.json
// carries its verdicts for every probe; virtualResource.test.js re-evaluates them here and demands
// the same answer, so the two drift apart as a test failure rather than in front of an approver.
//
// Three things are load-bearing, and the first two are why a naive version lies.
//
//   THE VERDICT CANNOT BE "ALLOW"     This document is Deny-only. An Allow comes from the attached
//                                     managed policies, and the assessment stores only their flat
//                                     expanded action list - never their Resource or Condition
//                                     clauses - so nothing here can establish that a call would
//                                     succeed. NOT_DENIED is exactly what was checked.
//   A MISSING KEY IS UNKNOWN          StringNotEquals on an absent key evaluates true and the Deny
//                                     fires; StringEquals on an absent key does not. Both turn on
//                                     what the request carried, which a resource description
//                                     cannot say - and since StringNotEquals is this platform's
//                                     default, that is the COMMON case, not a corner.
//   TAGS ARE COMPLETE, CONTEXT IS NOT A virtual resource's tag map describes the resource, so an
//                                     absent tag is an answer. Its request context does not, so an
//                                     absent key is a question.

/** The verdict vocabulary. There is no ALLOW - see the header. */
export const DENIED = 'DENIED_BY';
export const NOT_DENIED = 'NOT_DENIED';
export const UNKNOWN = 'UNKNOWN';

// The condition operators this evaluator knows the MEANING of. Not imported from the authoring
// whitelist on purpose: if the writer ever admits a third operator, this file must be taught what
// it does rather than silently accepting it and guessing.
const OPERATORS = new Set(['StringEquals', 'StringNotEquals']);

export class VirtualResourceError extends Error {}

/**
 * IAM wildcard matching, where * is the ONLY metacharacter. Mirrors restriction.wildcard_match.
 *
 * Deliberately not a RegExp built from the pattern: a policy is caller-controlled text, and
 * anything that treats [ ] ? or . as syntax would match actions and ARNs it does not spell.
 *
 * foldCase is not cosmetic. IAM action names are matched case-insensitively and ARNs are NOT - the
 * resource part of an ARN is case sensitive, so folding it would treat two different buckets as one.
 */
export function wildcardMatch(text, pattern, { foldCase }) {
  let subject = String(text);
  let glob = String(pattern);
  if (foldCase) {
    subject = subject.toLowerCase();
    glob = glob.toLowerCase();
  }
  if (glob === subject || glob === '*') return true;
  if (!glob.includes('*')) return false;

  const segments = glob.split('*');
  if (!subject.startsWith(segments[0])) return false;
  if (!subject.endsWith(segments[segments.length - 1])) return false;
  // Walk the interior segments left to right, each after the previous - the greedy-free scan that
  // makes a*b*c mean "a, then b, then c, in order and without overlap".
  let cursor = segments[0].length;
  for (const segment of segments.slice(1, -1)) {
    if (segment === '') continue;
    const at = subject.indexOf(segment, cursor);
    if (at < 0) return false;
    cursor = at + segment.length;
  }
  // The tail must not overlap what the interior already consumed.
  return cursor <= subject.length - segments[segments.length - 1].length;
}

/**
 * One resource that may exist tomorrow, described well enough to ask a question about it.
 *
 * A pattern is refused: matching a document against arn:aws:lambda:*:*:function:* asks whether it
 * covers SOME resource of that shape, which is a different question wearing the same words, and
 * answering it as if it were this one is how a test starts lying.
 */
export function virtualResource({ arn, tags = {}, requestContext = {} } = {}) {
  if (typeof arn !== 'string' || !arn.startsWith('arn:')) {
    throw new VirtualResourceError(
      `${String(arn)} is not an ARN. A virtual resource is described by the ARN it would have, `
      + 'because that is what a Resource clause is matched against.',
    );
  }
  if (arn.includes('*')) {
    throw new VirtualResourceError(
      `${arn} contains a wildcard. Describe ONE resource - a pattern asks whether the document `
      + 'covers some resource of that shape, which is a different question.',
    );
  }
  return { arn, tags, requestContext };
}

const actionMatches = (statement, action) => {
  const listed = statement.Action;
  const names = Array.isArray(listed) ? listed : [listed];
  return names.some((one) => typeof one === 'string'
    && wildcardMatch(action, one, { foldCase: true }));
};

const resourceMatches = (statement, arn) => {
  if ('NotResource' in statement) {
    const listed = statement.NotResource;
    const patterns = Array.isArray(listed) ? listed : [listed];
    return !patterns.some((one) => wildcardMatch(arn, one, { foldCase: false }));
  }
  const listed = statement.Resource ?? '*';
  const patterns = Array.isArray(listed) ? listed : [listed];
  return patterns.some((one) => wildcardMatch(arn, one, { foldCase: false }));
};

/**
 * A tag's value, matched by a CASE-INSENSITIVE key.
 *
 * AWS matches tag KEY names case-insensitively and tag VALUES case-sensitively, and collapsing the
 * two into one rule is wrong in whichever direction it is collapsed. A resource tagged
 * `environment=production` IS selected by a condition on `aws:ResourceTag/Environment`; a resource
 * tagged `Environment=Production` is NOT selected by a condition on the value `production`.
 */
function tagValue(resource, key) {
  const folded = key.toLowerCase();
  for (const [name, value] of Object.entries(resource.tags ?? {})) {
    if (name.toLowerCase() === folded) return value;
  }
  return null;
}

/**
 * Whether a Condition block holds. Returns { holds, missing } with holds null when a key the
 * caller did not supply decides it. AND across keys, OR within one key's value list.
 */
function conditionHolds(condition, resource) {
  const missing = new Set();
  let result = true;
  for (const [operator, keys] of Object.entries(condition)) {
    if (!OPERATORS.has(operator)) {
      throw new VirtualResourceError(
        `the document carries the condition operator ${operator}, whose evaluation semantics this `
        + `evaluator does not implement. It can answer for ${[...OPERATORS].join(', ')}.`,
      );
    }
    for (const [key, listed] of Object.entries(keys)) {
      const values = Array.isArray(listed) ? listed : [listed];
      let present;
      if (key.startsWith('aws:ResourceTag/')) {
        present = tagValue(resource, key.slice('aws:ResourceTag/'.length));
      } else if (Object.hasOwn(resource.requestContext ?? {}, key)) {
        present = resource.requestContext[key];
      } else {
        missing.add(key);
        continue;
      }
      const equal = present !== null && values.includes(present);
      const holds = operator === 'StringEquals' ? equal : !equal;
      if (!holds) result = false;
    }
  }
  // A key that could still flip the answer outranks one that already decided it: the statement
  // cannot be called dead while something unsupplied might make it fire.
  if (missing.size > 0) return { holds: null, missing: [...missing].sort() };
  return { holds: result, missing: [] };
}

/**
 * What this document says about one action on one resource that may not exist yet.
 *
 * Explicit Deny wins, so the first statement that matches with a holding condition decides, and an
 * UNKNOWN is reported only when nothing denied outright.
 */
export function evaluate(document, action, resource) {
  const considered = [];
  const unknown = [];
  const missing = new Set();

  for (const statement of document.Statement ?? []) {
    // Nothing this platform composes is an Allow, and an Allow in a hand-edited document is not
    // this evaluator's to reason about - it would need every other attached policy to mean anything.
    if (statement.Effect !== 'Deny') continue;
    if (!actionMatches(statement, action)) continue;
    if (!resourceMatches(statement, resource.arn)) continue;
    const sid = statement.Sid ?? '(no Sid)';
    considered.push(sid);
    if (!statement.Condition) {
      return { action, outcome: DENIED, sid, missingKeys: [], considered: [...considered] };
    }
    const { holds, missing: absent } = conditionHolds(statement.Condition, resource);
    if (holds === null) {
      unknown.push(sid);
      for (const key of absent) missing.add(key);
    } else if (holds) {
      return { action, outcome: DENIED, sid, missingKeys: [], considered: [...considered] };
    }
  }

  if (unknown.length > 0) {
    return { action, outcome: UNKNOWN, sid: unknown[0],
             missingKeys: [...missing].sort(), considered };
  }
  return { action, outcome: NOT_DENIED, sid: null, missingKeys: [], considered };
}

/** Every action against one resource, in the order asked. */
export const evaluateAll = (document, actions, resource) =>
  (actions ?? []).map((action) => evaluate(document, action, resource));

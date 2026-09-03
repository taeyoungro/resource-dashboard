// IAM action matching, and what a wildcard action COVERS in an assessment's reference.
//
// The page asks two questions of every action an administrator ticks - does it reach below the
// resource picked for it, and what does it bring into being - and both are answered per ACTION out
// of impact.json's action_reference, which is keyed by concrete name. A wildcard has no entry
// there, so both questions answered "no" for `s3:Get*` and `ec2:Create*`, and the preview showed:
//
//   deny_only s3:Delete*    Resource [bucket]        -> the objects in it are not denied
//   allow_only ec2:Create*  NotResource [subnet]     -> 83 created-type exemptions missing
//
// while the writer, which holds the table and expands the pattern, wrote the other document. A
// preview that differs from what gets written is a wrong answer with a screenshot, so the pattern
// is expanded here against the same reference the page already has.
//
// Deliberately not RegExp and not fnmatch. `*` is IAM's only metacharacter; an action string is
// caller-controlled text, and building a RegExp from it would make `.` and `[` mean something. The
// matcher below is the byte-for-byte mirror of restriction.wildcard_match in the Python.
//
// Plain JS with a .d.ts beside it, same arrangement as inlinePreview.js - node --test is the one
// runner here and it cannot load TypeScript.

/**
 * IAM wildcard matching, where `*` is the only metacharacter.
 *
 * foldCase is not cosmetic: IAM matches action names case-insensitively and ARNs case-sensitively,
 * so folding an ARN would treat two different buckets as one.
 */
export function wildcardMatch(text, pattern, { foldCase = false } = {}) {
  let subject = String(text ?? '');
  let glob = String(pattern ?? '');
  if (foldCase) {
    subject = subject.toLowerCase();
    glob = glob.toLowerCase();
  }
  if (glob === subject || glob === '*') return true;
  if (!glob.includes('*')) return false;

  const segments = glob.split('*');
  if (!subject.startsWith(segments[0])) return false;
  if (!subject.endsWith(segments[segments.length - 1])) return false;
  if (segments.length === 2) {
    // prefix*suffix - the two only have to fit without overlapping.
    return subject.length >= segments[0].length + segments[segments.length - 1].length;
  }
  let cursor = segments[0].length;
  for (const middle of segments.slice(1, -1)) {
    const found = subject.indexOf(middle, cursor);
    if (found === -1) return false;
    cursor = found + middle.length;
  }
  return cursor <= subject.length - segments[segments.length - 1].length;
}

/** The service prefix of an action and the name after the colon. Empty strings when it has none. */
export function splitAction(action) {
  const text = String(action ?? '').trim();
  const cut = text.indexOf(':');
  if (cut < 0) return { service: '', name: '' };
  return { service: text.slice(0, cut).toLowerCase(), name: text.slice(cut + 1) };
}

/**
 * The concrete names in `names` this action covers, in the reference's own spelling.
 *
 * A concrete action covers itself, whether or not the reference knows it - the caller's other
 * lookups already answer "unknown" for that case. A wildcard covers every name it matches.
 */
export function coveredNames(action, names) {
  const { name } = splitAction(action);
  if (!name) return [];
  if (!name.includes('*')) return [name];
  return (names ?? []).filter((known) => wildcardMatch(known, name, { foldCase: true }));
}

/**
 * Whether this action - concrete or wildcard - operates BELOW the resource an index can hold.
 *
 * `any` over what a wildcard covers, which is the rule under_another_type already applies over one
 * action's own types: the extra pattern is inert for a member acting on the container itself, whose
 * request names the container, and load-bearing for the member that reaches inside it.
 */
export function reachesInside(reference, action) {
  const nested = reference?.nested_types ?? {};
  const { service, name } = splitAction(action);
  const types = nested[service];
  if (!name || !types?.length) return false;
  const block = reference?.services?.[service] ?? {};
  return coveredNames(action, Object.keys(block))
    .some((known) => Boolean(block[known]?.[1]?.some((type) => types.includes(type))));
}

/**
 * The creation-exemption patterns this action's allow_only statement needs, still carrying
 * ${Partition} and ${Account} for the caller to substitute.
 *
 * The UNION over what a wildcard covers, exactly as restriction._creation_exemptions composes it:
 * the statement is one clause for the whole Action, and every covered call is authorised against
 * what IT brings into being.
 */
export function createdFormats(reference, action) {
  const created = reference?.created_formats ?? {};
  const { service } = splitAction(action);
  const block = created[service] ?? {};
  const out = new Set();
  for (const known of coveredNames(action, Object.keys(block))) {
    for (const pattern of block[known] ?? []) out.add(pattern);
  }
  return [...out].sort();
}

/**
 * Which of these protected actions the pattern would deny. The gate B-1 was about, in the
 * direction that is easy to get backwards: the administrator's action is the PATTERN and each
 * protected name is the text it might match.
 *
 * Needs no reference, so it holds for an assessment that carries none - the same property
 * restriction.covers_protected has for a table that failed to load.
 */
export function coversProtected(action, protectedActions) {
  const pattern = String(action ?? '').trim();
  return [...(protectedActions ?? [])]
    .filter((name) => wildcardMatch(name, pattern, { foldCase: true }));
}

/**
 * The first creation exemption this allow_only statement needs and CANNOT compose, or null.
 *
 * ${Account} is substituted from the picked ARNs, and some ARN shapes carry no account at all - an
 * s3 bucket is arn:aws:s3:::name. A pattern whose type HAS an account, substituted with an empty
 * one, matches nothing: the exemption silently disappears and the statement becomes the total deny
 * it exists to prevent. The writer refuses the decision (restriction._validate); this is the same
 * answer on the page, so a fold that would be refused is never offered.
 */
export function unsubstitutableExemption(reference, action, picked, substitute) {
  const arns = [...(picked ?? [])].sort();
  if (!arns.length) return null;
  const created = reference?.created_formats ?? {};
  const { service } = splitAction(action);
  const block = created[service] ?? {};
  for (const known of coveredNames(action, Object.keys(block))) {
    for (const pattern of block[known] ?? []) {
      if (substitute(pattern, arns) === null) {
        return { action: `${service}:${known}`, pattern };
      }
    }
  }
  return null;
}

/**
 * The (covered action, exemption pattern, picked ARN) where an allow_only statement's own exemption
 * would keep every resource of the type it claims to scope, or null.
 *
 * Only a wildcard reaches this. The exemption is written once for the whole Action, so the members
 * the created type is an EXISTING resource for are judged against it too: `athena:*` covers
 * CreateDataCatalog, so the statement must exempt datacatalog/*, and that pattern matches every
 * other catalog in the account - a statement reading "only this catalog" then permits deleting all
 * of them. The writer refuses this decision (restriction.swallowed_by_exemption); the page must not
 * offer it or preview it as a scope.
 *
 * `substitute` makes one pattern concrete from the picked ARNs - inlinePreview.creationExemption -
 * and `covers` is ARN matching, case-sensitively.
 */
export function swallowedByExemption(reference, action, picked, substitute) {
  if (!String(action ?? '').includes('*')) return null;
  const arns = [...(picked ?? [])].sort();
  if (!arns.length) return null;
  const created = reference?.created_formats ?? {};
  const { service } = splitAction(action);
  const block = created[service] ?? {};
  for (const known of coveredNames(action, Object.keys(block))) {
    for (const pattern of block[known] ?? []) {
      const concrete = substitute(pattern, arns);
      if (!concrete) continue;
      for (const arn of arns) {
        if (wildcardMatch(arn, concrete)) {
          return { action: `${service}:${known}`, pattern: concrete, resource: arn };
        }
      }
    }
  }
  return null;
}

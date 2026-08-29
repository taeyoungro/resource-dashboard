// An S3 bucket policy, read against the principals this pipeline governs.
//
// The question this answers, stated narrowly on purpose: given ONE bucket's resource-based policy
// and the mirror roles and permission sets this deployment issued, which of them does that policy
// speak about, and what does it say? It is a READ. Nothing here composes, proposes or writes a
// bucket policy, and the dashboard holds no permission to - a host that could edit a bucket policy
// could open a bucket, which is a larger blast radius than the approval screen is worth.
//
// Why this is not virtualResource.js
// ----------------------------------
// That evaluator answers "does this Deny-only inline document refuse a call", and its header is
// explicit that it CANNOT say ALLOW: the allow side lives in attached managed policies it never
// sees. A bucket policy is the opposite shape. It grants, and for a principal in another account it
// is the half without which nothing works - so an Allow here is a real answer rather than an
// absence of one, and a separate evaluator is owed. What is borrowed is wildcardMatch, because IAM
// wildcards must mean the same thing in both.
//
// The four things a tool like this gets wrong
// -------------------------------------------
//   SILENCE IS NOT ABSENCE OF ACCESS  For a principal in the SAME account as the bucket, an
//                                     identity policy alone is enough - the bucket policy is not
//                                     required and its silence says nothing at all. Across
//                                     accounts, both sides must allow, so silence there IS an
//                                     answer. The two are different sentences and this returns
//                                     different outcomes for them.
//   ACCOUNT ROOT IS NOT A GRANT       Principal arn:aws:iam::123:root does not hand access to every
//                                     principal in 123. It DELEGATES: the bucket agrees, and
//                                     account 123's own identity policies decide who actually
//                                     gets it. Reporting that as "allowed" would name principals
//                                     whose identity policies may say nothing.
//   A CONDITION IS NOT DECORATION     Most of what appears in a bucket policy Condition is request
//                                     context - a source address, a VPC endpoint, a TLS flag, an
//                                     object prefix - and none of it can be decided from a
//                                     principal. An Allow carrying one is conditional, not allowed,
//                                     and the keys that could not be read are named.
//   THE POLICY IS NOT THE ONLY DOOR   Object ACLs, access points and Block Public Access all sit
//                                     beside the bucket policy. This reads one of the four and says
//                                     so; nothing here may be read as "this is every way in".

import { wildcardMatch } from './virtualResource.js';

/**
 * What this reading concluded about one principal.
 *
 * Five, not three, because collapsing them would put two different decisions under one word. An
 * approver reading DELEGATED has to go and look at another account's identity policies; one reading
 * ALLOWED does not.
 */
export const OUTCOME = {
  /** An Allow names this principal and carries no condition this reading could not settle. */
  ALLOWED: 'ALLOWED',
  /** An Allow names it, and something in the Condition cannot be decided from a principal. */
  CONDITIONAL: 'CONDITIONAL',
  /** An Allow names this principal's ACCOUNT. The bucket agrees; that account's policies decide. */
  DELEGATED: 'DELEGATED',
  /** An explicit Deny matches. This outranks every Allow anywhere, in either account. */
  DENIED: 'DENIED',
  /** Nothing in the policy speaks about this principal. What that MEANS depends on the account. */
  SILENT: 'SILENT',
  /**
   * The policy holds a statement this reading does not interpret, so nothing here is settled.
   *
   * NotPrincipal is the case. Its meaning - everyone EXCEPT these - inverts the question this
   * evaluator asks, and it can bear on ANY principal, so a document carrying one leaves every
   * answer in doubt rather than one of them. Reported as its own outcome because the alternative
   * was reporting it as silence, which is the same word this uses for "the policy does not mention
   * you" - and those are not the same fact.
   */
  UNREADABLE: 'UNREADABLE',
};

/** How a statement came to name a principal. Carried so a card can say why it matched. */
export const MATCH = {
  /** Principal "*" - everyone, including principals that are not this deployment's. */
  ANY: 'any',
  /** The principal's own ARN, written out. */
  ARN: 'arn',
  /** The account, as an id or as an :root ARN. */
  ACCOUNT: 'account',
  /** A condition on aws:PrincipalArn, which unlike Principal does take wildcards. */
  CONDITION: 'condition',
};

/** Condition keys that can be decided from a principal alone. Everything else is a question. */
const PRINCIPAL_KEYS = new Set(['aws:principalarn', 'aws:principalaccount']);

// Operators this reading knows the meaning of. An unknown operator makes its key unreadable.
//
// ArnEquals is in the GLOB set and that is not a slip. AWS states outright that "the ArnEquals and
// ArnLike condition operators behave identically", and the same for ArnNotEquals and ArnNotLike -
// both pairs accept * and ?. Modelling ArnEquals as an exact string compare is a common and
// consequential error: it makes the reading miss every policy that pins aws:PrincipalArn with a
// wildcard through the Equals spelling, which is the shape an Identity Center role is reached by.
const EXACT_OPS = new Set(['stringequals', 'stringequalsignorecase']);
const GLOB_OPS = new Set(['stringlike', 'arnlike', 'arnequals']);
const NEGATED_OPS = new Set(['stringnotequals', 'arnnotequals', 'stringnotlike', 'arnnotlike']);

/** Every value of a policy field, whether it was written as a string or a list. */
const list = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [String(value)];
};

/**
 * Whether this principal is inside the bucket's own account, or null when nobody said.
 *
 * Null and false are different answers and T-6 is why they stay apart. False means the principal is
 * in another account, which makes the policy's silence decisive - across accounts both halves are
 * required, so a policy that does not name it does not reach it. Null means this deployment was
 * never told which account the bucket is in, and interpreting silence then would be a claim built
 * on a value nobody supplied.
 */
export function sameAccountOf(principal, bucketAccountId) {
  if (!bucketAccountId) return null;
  return principal.accountId === bucketAccountId;
}

export class BucketPolicyError extends Error {}

/**
 * A bucket policy document from the text S3 returned.
 *
 * S3 hands back the policy as a JSON string inside a JSON response, so a malformed body is a real
 * case rather than a defensive one. It throws rather than returning an empty document: a policy
 * that could not be parsed and a bucket with no policy are opposite facts, and a caller that
 * confused them would report "nothing grants access here" about a document it failed to read.
 */
export function parsePolicy(text) {
  let document;
  try {
    document = JSON.parse(String(text));
  } catch (error) {
    throw new BucketPolicyError(`the bucket policy is not JSON: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new BucketPolicyError('the bucket policy is not a policy document');
  }
  const statements = Array.isArray(document.Statement)
    ? document.Statement
    : (document.Statement ? [document.Statement] : []);
  return { version: document.Version ?? null, statements, document };
}

/**
 * The principals one statement names, normalised.
 *
 * Principal takes several shapes and the differences matter to the answer, so they are kept apart
 * rather than flattened to a list of strings: "*" reaches principals this deployment never issued,
 * an account id delegates rather than grants, and a Service or Federated principal is never one of
 * ours however it is spelled.
 */
export function principalsOf(statement) {
  const principal = statement?.Principal;
  const out = { any: false, arns: [], accounts: [], services: [], federated: [], canonical: [] };
  if (principal === undefined || principal === null) return out;
  if (typeof principal === 'string') {
    if (principal === '*') out.any = true;
    return out;
  }
  for (const value of list(principal.AWS)) {
    if (value === '*') { out.any = true; continue; }
    // An account is written either as the bare id or as its root ARN, and they mean the same thing.
    if (/^\d{12}$/.test(value)) { out.accounts.push(value); continue; }
    const root = /^arn:aws[a-z-]*:iam::(\d{12}):root$/.exec(value);
    if (root) { out.accounts.push(root[1]); continue; }
    out.arns.push(value);
  }
  out.services = list(principal.Service);
  out.federated = list(principal.Federated);
  out.canonical = list(principal.CanonicalUser);
  return out;
}

/**
 * Whether a policy ARN and one of our principals are the same principal.
 *
 * Matched in BOTH directions, and that is not belt and braces. The Principal element takes no
 * wildcard but the thing we are matching against sometimes does: an Identity Center permission set
 * materialises as a role whose name ends in a suffix AWS chooses, so what this deployment knows is
 * a pattern rather than an ARN. A policy naming the provisioned role in full is matched by testing
 * the POLICY's literal against OUR pattern, which is the reverse of the usual direction.
 *
 * ARNs are matched case sensitively. The resource half of an ARN is case sensitive in IAM, and
 * folding it would make two different roles read as one.
 */
function sameArn(policyArn, principal) {
  if (policyArn === principal.arn) return true;
  if (principal.arnIsPattern && wildcardMatch(policyArn, principal.arn, { foldCase: false })) {
    return true;
  }
  // A session ARN names the role it came from. A policy naming the role covers its sessions, and a
  // policy naming a session ARN is about the same role - so the role half is compared.
  const session = /^arn:aws[a-z-]*:sts::(\d{12}):assumed-role\/([^/]+)\//.exec(policyArn);
  if (session) {
    const asRole = `arn:aws:iam::${session[1]}:role/${session[2]}`;
    if (asRole === principal.arn) return true;
    if (principal.arnIsPattern && wildcardMatch(asRole, principal.arn, { foldCase: false })) {
      return true;
    }
  }
  return false;
}

/**
 * What one condition block says about this principal: true, false, or a question.
 *
 * Returns { holds, unknown } where holds is null when nothing could be decided. The shape mirrors
 * virtualResource's conditionHolds for the same reason it has one - a condition nobody read is not
 * a condition that passed, and saying so is the difference between a card an approver can act on
 * and one that is confidently wrong.
 */
function conditionHolds(condition, principal) {
  const unknown = new Set();
  let decided = true;

  for (const [operator, block] of Object.entries(condition ?? {})) {
    const op = String(operator).toLowerCase().replace(/ifexists$/, '');
    for (const [key, raw] of Object.entries(block ?? {})) {
      const name = String(key).toLowerCase();
      const values = list(raw);
      if (!PRINCIPAL_KEYS.has(name)) { unknown.add(key); continue; }

      const subject = name === 'aws:principalaccount' ? principal.accountId : principal.arn;
      // Whether the thing WE hold is a pattern. A permission set's provisioned role name carries a
      // suffix AWS chose, so this deployment knows a namespace rather than an ARN - and a condition
      // naming one provisioned role in full is still about this permission set when that name falls
      // inside the namespace. That is the reverse of the usual direction and it has to be tried, or
      // every policy written the way AWS recommends reads as being about nobody.
      const ours = name === 'aws:principalarn' && principal.arnIsPattern;
      const meets = (value) => {
        if (EXACT_OPS.has(op)) {
          return ours ? wildcardMatch(value, subject, { foldCase: false }) : value === subject;
        }
        // A glob operator makes the POLICY's value the pattern. Where both sides are patterns they
        // meet if either covers the other: the same namespace written twice, or a literal inside
        // ours.
        return wildcardMatch(subject, value, { foldCase: false })
          || (ours && wildcardMatch(value, subject, { foldCase: false }));
      };

      let hit;
      if (EXACT_OPS.has(op) || GLOB_OPS.has(op)) {
        hit = values.some(meets);
      } else if (NEGATED_OPS.has(op)) {
        hit = !values.some(meets);
      } else {
        unknown.add(key);
        continue;
      }
      if (!hit) decided = false;
    }
  }

  if (!decided) return { holds: false, unknown: [...unknown].sort() };
  return { holds: unknown.size ? null : true, unknown: [...unknown].sort() };
}

/** Whether a statement's Action/NotAction covers any S3 action at all. */
function touchesS3(statement) {
  const not = list(statement.NotAction);
  if (not.length) {
    // NotAction on a Deny reaches everything it does not name, which certainly includes S3.
    return true;
  }
  const actions = list(statement.Action);
  if (actions.length === 0) return false;
  return actions.some((a) => a === '*' || /^s3[a-z-]*:/i.test(a));
}

/**
 * Whether naming an ACCOUNT in this statement reaches this principal.
 *
 * Allow and Deny do not mean the same thing here, and the difference is dated.
 *
 *   Allow + account   Delegation. The bucket agrees and that account's own identity policies
 *                     decide who actually gets it, so it reaches the principal as a maybe - which
 *                     is what OUTCOME.DELEGATED is for.
 *   Deny + account    Since 20 October 2023, a Deny naming the BUCKET-OWNING account's root is
 *                     expanded by S3 to every IAM principal in that account. Before that date, and
 *                     still today for any OTHER account, it means the literal root user and
 *                     nothing else.
 *
 * So a Deny naming a third account's root does NOT deny that account's roles, and reporting it as
 * one would tell an approver a principal is blocked when it is not - the one direction of error
 * this whole reading exists to avoid. Where the bucket's account is unknown the expansion cannot be
 * established either way, so it is not claimed.
 */
function accountReaches(effect, principal, bucketAccountId) {
  if (effect === 'Allow') return true;
  return Boolean(bucketAccountId) && principal.accountId === bucketAccountId;
}

/**
 * How one statement bears on one principal, or null when it does not.
 *
 * NotPrincipal is not evaluated and does not silently pass. Its meaning - everyone EXCEPT these -
 * inverts the question this function asks, and a statement carrying one is reported as unreadable
 * so it reaches the screen as a thing to go and look at rather than as a statement that said
 * nothing about anybody.
 */
function statementFor(statement, principal, bucketAccountId) {
  const effect = statement?.Effect;
  if (effect !== 'Allow' && effect !== 'Deny') return null;
  const sid = typeof statement.Sid === 'string' && statement.Sid ? statement.Sid : null;

  if (statement.NotPrincipal !== undefined) {
    return { sid, effect, match: null, unreadable: 'NotPrincipal', unknownKeys: [], holds: null };
  }
  if (!touchesS3(statement)) return null;

  const named = principalsOf(statement);
  let match = null;
  if (named.arns.some((arn) => sameArn(arn, principal))) match = MATCH.ARN;
  else if (named.accounts.includes(principal.accountId) && accountReaches(effect, principal, bucketAccountId)) {
    match = MATCH.ACCOUNT;
  } else if (named.any) match = MATCH.ANY;

  // Principal "*" with a condition pinning aws:PrincipalArn is the ONLY way a bucket policy can
  // name a principal by pattern - the Principal element itself takes no wildcard - so it is the
  // shape that reaches an Identity Center role, whose provisioned name nobody writes out by hand.
  const condition = statement.Condition;
  const { holds, unknown } = conditionHolds(condition, principal);
  if (match === null) return null;
  if (holds === false) return null;

  const pinned = Object.values(condition ?? {}).some(
    (block) => Object.keys(block ?? {}).some((k) => k.toLowerCase() === 'aws:principalarn'));
  return {
    sid,
    effect,
    match: match === MATCH.ANY && pinned ? MATCH.CONDITION : match,
    unreadable: null,
    unknownKeys: unknown,
    holds,
  };
}

/**
 * Everything this bucket policy says about one principal.
 *
 * Deny is settled first and without qualification. An explicit Deny in a resource policy refuses
 * the call whatever any identity policy allows and whichever account the principal is in, so a
 * reading that let an Allow elsewhere in the same document soften it would be wrong in the one
 * direction that matters.
 */
export function readForPrincipal(policy, principal, { bucketAccountId }) {
  const hits = [];
  for (const statement of policy.statements ?? []) {
    const hit = statementFor(statement, principal, bucketAccountId);
    if (hit) hits.push(hit);
  }

  const sameAccount = sameAccountOf(principal, bucketAccountId);
  const unreadable = hits.filter((h) => h.unreadable);
  const denies = hits.filter((h) => h.effect === 'Deny' && !h.unreadable);
  const allows = hits.filter((h) => h.effect === 'Allow' && !h.unreadable);

  const firm = (h) => h.holds === true;
  let outcome;
  // A firm Deny is settled whatever else the document holds: a Deny in a resource policy refuses
  // the call however any identity policy reads and whichever account the principal is in.
  if (denies.some(firm)) outcome = OUTCOME.DENIED;
  // Then anything unreadable, BEFORE the allows. A statement this cannot interpret may name this
  // principal or may not, so an Allow found beside it is not the whole answer either.
  else if (unreadable.length) outcome = OUTCOME.UNREADABLE;
  else if (allows.some((h) => firm(h) && h.match !== MATCH.ACCOUNT)) outcome = OUTCOME.ALLOWED;
  else if (allows.some((h) => firm(h))) outcome = OUTCOME.DELEGATED;
  else if (allows.length || denies.length) outcome = OUTCOME.CONDITIONAL;
  else outcome = OUTCOME.SILENT;

  return {
    principal,
    outcome,
    sameAccount,
    statements: hits,
    // Every condition key this reading could not settle, across the statements that matched. What
    // an approver has to go and check by hand before the card means what it appears to mean.
    unknownKeys: [...new Set(hits.flatMap((h) => h.unknownKeys))].sort(),
    unreadable: [...new Set(unreadable.map((h) => h.unreadable))],
  };
}

/** Every governed principal against one bucket policy, worst first so the top of the list is the point. */
export function readPolicy(policy, principals, { bucketAccountId } = {}) {
  const order = [OUTCOME.DENIED, OUTCOME.UNREADABLE, OUTCOME.ALLOWED, OUTCOME.CONDITIONAL,
                 OUTCOME.DELEGATED, OUTCOME.SILENT];
  return (principals ?? [])
    .map((principal) => readForPrincipal(policy, principal, { bucketAccountId }))
    .sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome)
      || String(a.principal.label).localeCompare(String(b.principal.label)));
}

/**
 * What the policy opens to principals that are NOT this deployment's.
 *
 * Read separately because it is a different question with a different audience. The per-principal
 * list answers "does this reach what we issued"; this answers "does this reach anybody at all",
 * which is the one an approver asks about a bucket they have never seen. A statement with
 * Principal "*" and no condition is public in the sense that matters, and one with "*" plus an
 * organisation or ARN condition is not - so the conditions are carried rather than summarised.
 */
export function openStatements(policy, { bucketAccountId } = {}) {
  const out = [];
  const accountOf = (arn) => /^arn:aws[a-z-]*:(?:iam|sts)::(\d{12}):/.exec(arn)?.[1] ?? null;
  for (const statement of policy.statements ?? []) {
    if (statement?.Effect !== 'Allow') continue;
    if (statement.NotPrincipal !== undefined) continue;
    if (!touchesS3(statement)) continue;
    const named = principalsOf(statement);
    // A principal in the bucket's OWN account is not an opening beyond it. Counting one was the
    // reading's own version of the mistake it warns about elsewhere: a statement naming a role that
    // lives in this very account was appearing under a heading that says the opposite. Where the
    // bucket's account is unknown nothing is subtracted - an unnamed account cannot be shown to be
    // this one, and over-reporting here is the direction that gets looked at rather than missed.
    const outside = (id) => !bucketAccountId || id !== bucketAccountId;
    const accounts = named.accounts.filter(outside);
    const arns = named.arns.filter((arn) => {
      const id = accountOf(arn);
      return id === null || outside(id);
    });
    if (!named.any && accounts.length === 0 && arns.length === 0) continue;
    out.push({
      sid: typeof statement.Sid === 'string' && statement.Sid ? statement.Sid : null,
      anyPrincipal: named.any,
      accounts,
      arns,
      services: named.services,
      conditionKeys: Object.values(statement.Condition ?? {})
        .flatMap((block) => Object.keys(block ?? {})).sort(),
      actions: list(statement.Action),
    });
  }
  return out;
}

// The principals this deployment issued, as a resource policy would have to name them.
//
// The dashboard already lists every governed resource - it sweeps the state bucket for plans and
// each plan is keyed <account id>:<resource>. That listing is the whole input here. Nothing calls
// IAM, and the dashboard holds no permission to: reading a bucket policy is a question about the
// bucket, and answering "who of ours does it name" must not become a reason to grant this host a
// read over another account's identity state.
//
// The two shapes, and why only one of them is an ARN
// -------------------------------------------------
// A mirror role is named by this pipeline, so its ARN is arithmetic: the account from the plan key
// and the role name from the resource.
//
//     718100330247 : mirror-lambda-Test
//       -> arn:aws:iam::718100330247:role/mirror-lambda-Test
//
// A permission set is not. It is an Identity Center object, and what a bucket policy can name is
// the IAM role it MATERIALISES as in the member account - whose name carries a suffix AWS chooses
// and nobody records:
//
//     718100330247 : SolutionAdmin
//       -> arn:aws:iam::718100330247:role/aws-reserved/sso.amazonaws.com/<region>/
//          AWSReservedSSO_SolutionAdmin_<suffix>
//
// So a permission set yields a PATTERN, and that is carried on the descriptor rather than hidden:
// a card built from it may say the policy names a role of this permission set, and may not say it
// names THIS role. The suffix is knowable from iam:ListRoles in the member account and this
// deployment does not have it, which is a gap to state rather than to paper over with a guess.

/** A permission set's provisioned role, as a pattern. Region and suffix are both AWS's to choose. */
const RESERVED_PATH = 'aws-reserved/sso.amazonaws.com';

export const PRINCIPAL_KIND = {
  MIRROR_ROLE: 'mirror_role',
  PERMISSION_SET: 'permission_set',
};

/**
 * One governed resource as a principal a bucket policy could name.
 *
 * Returns null for a plan whose key this cannot read. A malformed key is not a principal with an
 * unknown ARN - it is not a principal at all, and inventing one would put a row on the screen that
 * matches nothing forever.
 */
export function principalOf(plan, { mirrorPrefix = 'mirror-' } = {}) {
  const accountId = String(plan?.account_id ?? '');
  const resource = String(plan?.resource ?? '');
  if (!/^\d{12}$/.test(accountId) || !resource) return null;

  if (mirrorPrefix && resource.startsWith(mirrorPrefix)) {
    return {
      id: `${accountId}:${resource}`,
      kind: PRINCIPAL_KIND.MIRROR_ROLE,
      label: resource,
      accountId,
      arn: `arn:aws:iam::${accountId}:role/${resource}`,
      arnIsPattern: false,
      planId: plan.plan_id ?? `${accountId}:${resource}`,
    };
  }
  return {
    id: `${accountId}:${resource}`,
    kind: PRINCIPAL_KIND.PERMISSION_SET,
    label: resource,
    accountId,
    // Two wildcards, and each stands for something genuinely unknown rather than something not
    // looked up: the suffix AWS appended, and whether there is a region segment at all.
    //
    // The region one is easy to get wrong and expensive to. An Identity Center whose identity
    // source is hosted in us-east-1 provisions roles with NO region component:
    //
    //   .../sso.amazonaws.com/ap-northeast-2/AWSReservedSSO_Admin_2f9a1c4d8b6e0a53
    //   .../sso.amazonaws.com/AWSReservedSSO_Admin_2f9a1c4d8b6e0a53
    //
    // so a pattern anchored on /<region>/ misses every us-east-1-homed organisation entirely - and
    // misses it silently, as a permission set nothing ever matches. The wildcard sits BEFORE the
    // name with no slash of its own, which covers both spellings.
    arn: `arn:aws:iam::${accountId}:role/${RESERVED_PATH}/*AWSReservedSSO_${resource}_*`,
    arnIsPattern: true,
    planId: plan.plan_id ?? `${accountId}:${resource}`,
  };
}

/**
 * Every governed principal in the swept state, deduplicated and ordered.
 *
 * Deduplicated because one governed resource can appear under several plans over time and a bucket
 * policy says the same thing about all of them. Ordered by account then label so a list read twice
 * reads the same way twice.
 */
export function governedPrincipals(state, options = {}) {
  const byId = new Map();
  for (const plan of state?.plans ?? []) {
    const principal = principalOf(plan, options);
    if (principal && !byId.has(principal.id)) byId.set(principal.id, principal);
  }
  return [...byId.values()].sort(
    (a, b) => a.accountId.localeCompare(b.accountId) || a.label.localeCompare(b.label));
}

// Reading an S3 bucket policy against the principals this deployment issued.
//
// The tests are ordered by the mistake they prevent, because every one of them is a way to be
// confidently wrong on a screen an approver trusts: silence read as absence of access, an account
// delegation read as a grant, an unreadable condition read as a passed one.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OUTCOME, openStatements, parsePolicy, readForPrincipal, readPolicy } from './bucketPolicy.js';
import { governedPrincipals, principalOf } from './governedPrincipals.js';

const ACCOUNT = '718100330247';
const OTHER = '999900001111';

const mirror = principalOf({ account_id: ACCOUNT, resource: 'mirror-lambda-Test' });
const foreign = principalOf({ account_id: OTHER, resource: 'mirror-ec2-Test' });
// ps-<name>, because that is what a plan key holds for the permission set domain: the governed
// SOURCE role. The permission set it produces is <account>-<name truncated to 19>, and the role
// AWS provisions for it is AWSReservedSSO_<that>_<suffix> - so the pattern below is built from the
// derived name and not from the source one. Naming the source role there matched nothing.
const permissionSet = principalOf({ account_id: ACCOUNT, resource: 'ps-SolutionAdmin' });
const PS_NAME = `${ACCOUNT}-SolutionAdmin`;

const policy = (...statements) => parsePolicy(JSON.stringify({
  Version: '2012-10-17', Statement: statements,
}));

const read = (doc, principal, bucketAccountId = ACCOUNT) =>
  readForPrincipal(doc, principal, { bucketAccountId });

// ---- what a principal looks like ---------------------------------------------------------------

test('a mirror role is an ARN and a permission set is a pattern', () => {
  // The pipeline names mirror roles, so their ARN is arithmetic. A permission set is an Identity
  // Center object whose provisioned IAM role carries a suffix AWS chooses and nobody records, so
  // what this deployment knows is a pattern - and the card must be able to say so rather than
  // present a guess as an ARN.
  assert.equal(mirror.arn, `arn:aws:iam::${ACCOUNT}:role/mirror-lambda-Test`);
  assert.equal(mirror.arnIsPattern, false);
  assert.equal(permissionSet.arn,
    `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_${PS_NAME}_*`);
  assert.equal(permissionSet.arnIsPattern, true);
  // A key this cannot read is not a principal with an unknown ARN - it is not a principal.
  assert.equal(principalOf({ account_id: 'nope', resource: 'x' }), null);
  assert.equal(principalOf({ account_id: ACCOUNT, resource: '' }), null);
});

test('the governed list is every plan once, ordered', () => {
  const state = { plans: [
    { account_id: ACCOUNT, resource: 'mirror-lambda-Test' },
    { account_id: ACCOUNT, resource: 'mirror-lambda-Test' },
    { account_id: OTHER, resource: 'mirror-ec2-Test' },
    { account_id: ACCOUNT, resource: 'ps-SolutionAdmin' },
    { account_id: null, resource: null },
  ] };
  // Account first, then LABEL by locale order - and the label is the derived name, so the
  // permission set sorts under <account>-SolutionAdmin and not under its source role's ps- name.
  // What the test pins is that the order is STABLE and the list deduplicated, not which of the two
  // collation rules applies.
  assert.deepEqual(governedPrincipals(state).map((p) => p.id),
                   [`${ACCOUNT}:ps-SolutionAdmin`, `${ACCOUNT}:mirror-lambda-Test`,
                    `${OTHER}:mirror-ec2-Test`]);
});

// ---- the four ways to be wrong -----------------------------------------------------------------

test('silence means opposite things either side of the account boundary', () => {
  // The mistake this exists to prevent. For a principal in the bucket's own account an identity
  // policy alone is enough, so a bucket policy that does not name it has said nothing; across
  // accounts both halves are required, so the same silence IS the answer. Same outcome token,
  // different meaning, and the flag is what lets the card say which.
  const doc = policy({
    Sid: 'Unrelated', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:role/other` },
    Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*',
  });
  assert.equal(read(doc, mirror).outcome, OUTCOME.SILENT);
  assert.equal(read(doc, mirror).sameAccount, true);
  assert.equal(read(doc, foreign).outcome, OUTCOME.SILENT);
  assert.equal(read(doc, foreign).sameAccount, false);
  // T-6: not told which account the bucket is in is UNKNOWN, never "a different account".
  assert.equal(readForPrincipal(doc, mirror, { bucketAccountId: null }).sameAccount, null);
});

test('an account root delegates and does not grant', () => {
  // Principal arn:aws:iam::123:root does not hand access to every principal in 123 - it says the
  // bucket agrees and account 123's own identity policies decide. Reporting it as ALLOWED would
  // name principals whose identity policies may say nothing at all.
  for (const written of [{ AWS: `arn:aws:iam::${OTHER}:root` }, { AWS: OTHER }]) {
    const doc = policy({
      Sid: 'Delegate', Effect: 'Allow', Principal: written,
      Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
    });
    assert.equal(read(doc, foreign).outcome, OUTCOME.DELEGATED, JSON.stringify(written));
    // And it says nothing about a principal in a different account than the one it names.
    assert.equal(read(doc, mirror).outcome, OUTCOME.SILENT);
  }
});

test('a condition nobody could read is not a condition that passed', () => {
  // Most of what appears in a bucket policy Condition is request context - a source address, a VPC
  // endpoint, a TLS flag - and none of it can be decided from a principal. The Allow is real and
  // the access is not established, which is its own answer.
  const doc = policy({
    Sid: 'FromOfficeOnly', Effect: 'Allow', Principal: { AWS: mirror.arn },
    Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*',
    Condition: { IpAddress: { 'aws:SourceIp': '203.0.113.0/24' } },
  });
  const out = read(doc, mirror);
  assert.equal(out.outcome, OUTCOME.CONDITIONAL);
  assert.deepEqual(out.unknownKeys, ['aws:SourceIp']);
});

test('a bucket policy is one door of four, and an explicit deny outranks everything', () => {
  // Deny is settled first and without qualification: a Deny in a resource policy refuses the call
  // whatever any identity policy allows and whichever account the principal is in. A reading that
  // let an Allow elsewhere in the same document soften it would be wrong in the one direction that
  // costs something.
  const doc = policy(
    { Sid: 'Allow', Effect: 'Allow', Principal: { AWS: mirror.arn },
      Action: 's3:*', Resource: 'arn:aws:s3:::b/*' },
    { Sid: 'DenyUnlessTls', Effect: 'Deny', Principal: '*',
      Action: 's3:*', Resource: 'arn:aws:s3:::b/*' },
  );
  assert.equal(read(doc, mirror).outcome, OUTCOME.DENIED);
});

// ---- the shapes a policy actually takes --------------------------------------------------------

test('a permission set is reached through a condition, because Principal takes no wildcard', () => {
  // The Principal element accepts no wildcard other than the lone "*", so a policy CANNOT name
  // AWSReservedSSO_<permission set>_* there. The only way to write that intent is Principal "*" with
  // a condition on aws:PrincipalArn, which does take wildcards - so that shape is the one an
  // Identity Center role is reached by, and the match is reported as a condition rather than as
  // "everyone".
  const doc = policy({
    Sid: 'AdminsOnly', Effect: 'Allow', Principal: '*',
    Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
    Condition: { ArnLike: { 'aws:PrincipalArn': permissionSet.arn } },
  });
  const out = read(doc, permissionSet);
  assert.equal(out.outcome, OUTCOME.ALLOWED);
  assert.deepEqual(out.statements.map((s) => s.match), ['condition']);
  // The same statement reaches a mirror role only if the pattern covers it, which it does not.
  assert.equal(read(doc, mirror).outcome, OUTCOME.SILENT);
});

test('a policy naming the provisioned role in full is matched against our pattern', () => {
  // The reverse direction, and it is why the match is two-way. The policy holds a literal ARN with
  // the suffix AWS assigned; this deployment holds a pattern. Testing the literal against the
  // pattern is the only way the two meet.
  const provisioned = `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/`
    + `ap-northeast-2/AWSReservedSSO_${PS_NAME}_2f9a1c4d8b6e0a53`;
  const doc = policy({
    Sid: 'ByFullArn', Effect: 'Allow', Principal: { AWS: provisioned },
    Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*',
  });
  assert.equal(read(doc, permissionSet).outcome, OUTCOME.ALLOWED);
  // A different permission set's provisioned role is not this one.
  const otherSet = principalOf({ account_id: ACCOUNT, resource: 'ReadOnly' });
  assert.equal(read(doc, otherSet).outcome, OUTCOME.SILENT);
});

test('a session ARN names the role it came from', () => {
  const session = `arn:aws:sts::${ACCOUNT}:assumed-role/mirror-lambda-Test/i-0abc`;
  const doc = policy({
    Sid: 'BySession', Effect: 'Allow', Principal: { AWS: session },
    Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*',
  });
  assert.equal(read(doc, mirror).outcome, OUTCOME.ALLOWED);
});

test('a service or federated principal is never one of ours', () => {
  const doc = policy({
    Sid: 'Logs', Effect: 'Allow', Principal: { Service: 'logging.s3.amazonaws.com' },
    Action: 's3:PutObject', Resource: 'arn:aws:s3:::b/*',
  });
  assert.equal(read(doc, mirror).outcome, OUTCOME.SILENT);
});

test('a statement about no S3 action bears on nothing here', () => {
  const doc = policy({
    Sid: 'NotS3', Effect: 'Allow', Principal: { AWS: mirror.arn },
    Action: 'kms:Decrypt', Resource: '*',
  });
  assert.equal(read(doc, mirror).outcome, OUTCOME.SILENT);
});

test('an evaluable condition that fails removes the statement rather than softening it', () => {
  const doc = policy({
    Sid: 'OtherAccountOnly', Effect: 'Allow', Principal: '*',
    Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
    Condition: { StringEquals: { 'aws:PrincipalAccount': OTHER } },
  });
  assert.equal(read(doc, mirror).outcome, OUTCOME.SILENT);
  assert.equal(read(doc, foreign).outcome, OUTCOME.ALLOWED);
});

test('NotPrincipal is reported unreadable rather than passed over', () => {
  // Its meaning - everyone EXCEPT these - inverts the question this evaluator asks, and a statement
  // carrying one must reach the screen as a thing to go and read rather than as a statement that
  // said nothing about anybody.
  const doc = policy({
    Sid: 'EveryoneElse', Effect: 'Deny', NotPrincipal: { AWS: mirror.arn },
    Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
  });
  const out = read(doc, mirror);
  assert.deepEqual(out.unreadable, ['NotPrincipal']);
  assert.equal(out.outcome, OUTCOME.UNREADABLE,
               'an unreadable statement was reported as the policy saying nothing');
  // It bears on EVERY principal, because "everyone except these" can name any of them.
  assert.equal(read(doc, foreign).outcome, OUTCOME.UNREADABLE);
  // A firm Deny still settles it - that one is definitive whatever else the document holds.
  const withDeny = policy(
    { Sid: 'EveryoneElse', Effect: 'Deny', NotPrincipal: { AWS: mirror.arn },
      Action: 's3:*', Resource: 'arn:aws:s3:::b/*' },
    { Sid: 'DenyMirror', Effect: 'Deny', Principal: { AWS: mirror.arn },
      Action: 's3:*', Resource: 'arn:aws:s3:::b/*' },
  );
  assert.equal(read(withDeny, mirror).outcome, OUTCOME.DENIED);
});

test('ArnEquals globs, exactly as ArnLike does', () => {
  // AWS states outright that the two operators behave identically and that both accept wildcards.
  // Modelling ArnEquals as an exact string compare misses every policy that pins aws:PrincipalArn
  // through that spelling - which is most of them, because it reads like the stricter choice.
  const doc = policy({
    Sid: 'AdminsOnly', Effect: 'Allow', Principal: '*',
    Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
    Condition: { ArnEquals: { 'aws:PrincipalArn':
      `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_${PS_NAME}_*` } },
  });
  assert.equal(read(doc, permissionSet).outcome, OUTCOME.ALLOWED);
});

test('a condition naming one provisioned role is about the permission set it belongs to', () => {
  // The reverse direction inside a condition. The policy holds the role in full, with the suffix
  // AWS assigned; this deployment holds the namespace. Testing the literal against the namespace is
  // the only way the two meet, and without it every policy written the way AWS recommends reads as
  // being about nobody.
  const provisioned = `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/`
    + `ap-northeast-2/AWSReservedSSO_${PS_NAME}_2f9a1c4d8b6e0a53`;
  for (const operator of ['ArnEquals', 'StringEquals', 'ArnLike']) {
    const doc = policy({
      Sid: 'ExactArn', Effect: 'Allow', Principal: '*',
      Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
      Condition: { [operator]: { 'aws:PrincipalArn': provisioned } },
    });
    assert.equal(read(doc, permissionSet).outcome, OUTCOME.ALLOWED, operator);
    // A different permission set's provisioned role is not this one, under any operator.
    assert.equal(read(doc, principalOf({ account_id: ACCOUNT, resource: 'ReadOnly' })).outcome,
                 OUTCOME.SILENT, operator);
  }
});

test('an Identity Center role provisioned with no region segment is still matched', () => {
  // An Identity Center whose identity source is hosted in us-east-1 provisions roles with no region
  // component at all. A pattern anchored on /<region>/ misses every such organisation, silently, as
  // a permission set nothing ever matches.
  const noRegion = `arn:aws:iam::${ACCOUNT}:role/aws-reserved/sso.amazonaws.com/`
    + `AWSReservedSSO_${PS_NAME}_2f9a1c4d8b6e0a53`;
  const doc = policy({
    Sid: 'ByFullArn', Effect: 'Allow', Principal: { AWS: noRegion },
    Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*',
  });
  assert.equal(read(doc, permissionSet).outcome, OUTCOME.ALLOWED);
});

test('a deny naming a THIRD account\'s root does not block that account\'s roles', () => {
  // Since 20 October 2023 S3 expands a Deny naming the BUCKET-OWNING account's root to every IAM
  // principal in that account. For any other account it still means the literal root user - so
  // reporting it as a block on that account's roles would tell an approver a principal is stopped
  // when it is not, which is the one direction of error this reading exists to avoid.
  const doc = policy({
    Sid: 'DenyOtherRoot', Effect: 'Deny', Principal: { AWS: `arn:aws:iam::${OTHER}:root` },
    Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
  });
  assert.equal(read(doc, foreign).outcome, OUTCOME.SILENT,
               'a third account\'s root deny was read as blocking its roles');
  // The bucket owner's own root IS expanded, so the same shape does block a principal there.
  const owner = policy({
    Sid: 'DenyOwnerRoot', Effect: 'Deny', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
    Action: 's3:*', Resource: 'arn:aws:s3:::b/*',
  });
  assert.equal(read(owner, mirror).outcome, OUTCOME.DENIED);
  // Not claimed either way when nobody said which account the bucket is in.
  assert.equal(readForPrincipal(owner, mirror, { bucketAccountId: null }).outcome, OUTCOME.SILENT);
});

// ---- the document itself -----------------------------------------------------------------------

test('a policy that will not parse is not a bucket with nothing in it', () => {
  assert.throws(() => parsePolicy('{not json'), /not JSON/);
  assert.throws(() => parsePolicy('[]'), /not a policy document/);
  // A single statement written as an object rather than a list is a policy, not a malformed one.
  assert.equal(parsePolicy(JSON.stringify({ Statement: { Effect: 'Allow' } })).statements.length, 1);
});

test('what is open to everybody is a separate question with a separate answer', () => {
  const doc = policy(
    { Sid: 'Public', Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::b/*' },
    { Sid: 'OrgOnly', Effect: 'Allow', Principal: '*', Action: 's3:GetObject',
      Resource: 'arn:aws:s3:::b/*',
      Condition: { StringEquals: { 'aws:PrincipalOrgID': 'o-abc123' } } },
    { Sid: 'Partner', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${OTHER}:root` },
      Action: 's3:ListBucket', Resource: 'arn:aws:s3:::b' },
    { Sid: 'DenyAll', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: '*' },
  );
  const open = openStatements(doc, { bucketAccountId: ACCOUNT });
  assert.deepEqual(open.map((s) => s.sid), ['Public', 'OrgOnly', 'Partner'],
                   'a Deny was reported as an opening, or an opening was missed');
  assert.deepEqual(open[0].conditionKeys, [], 'the unconditioned public grant carries a condition');
  assert.deepEqual(open[1].conditionKeys, ['aws:PrincipalOrgID']);
  assert.deepEqual(open[2].accounts, [OTHER]);
});

test('the worst answer is at the top of the list', () => {
  // A reader who stops after the first row has to have seen the sharpest thing the policy says.
  const doc = policy(
    { Sid: 'Allow', Effect: 'Allow', Principal: { AWS: mirror.arn }, Action: 's3:*',
      Resource: 'arn:aws:s3:::b/*' },
    { Sid: 'Delegate', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${OTHER}:root` },
      Action: 's3:*', Resource: 'arn:aws:s3:::b/*' },
  );
  const list = readPolicy(doc, [permissionSet, foreign, mirror], { bucketAccountId: ACCOUNT });
  assert.deepEqual(list.map((r) => r.outcome),
                   [OUTCOME.ALLOWED, OUTCOME.DELEGATED, OUTCOME.SILENT]);
});

test('a principal in the bucket\'s own account is not an opening beyond it', () => {
  // The reading's own version of the mistake it warns about: a statement naming a role that lives
  // in this very account was appearing under a heading that says the opposite.
  const doc = policy(
    { Sid: 'OwnRole', Effect: 'Allow', Principal: { AWS: mirror.arn },
      Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
    { Sid: 'OwnAccount', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
      Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
    { Sid: 'Partner', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${OTHER}:root` },
      Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' },
  );
  assert.deepEqual(openStatements(doc, { bucketAccountId: ACCOUNT }).map((s) => s.sid), ['Partner']);
  // Nothing is subtracted when the bucket's account was never supplied: an unnamed account cannot
  // be shown to be this one, and over-reporting is the direction that gets looked at.
  assert.deepEqual(openStatements(doc).map((s) => s.sid), ['OwnRole', 'OwnAccount', 'Partner']);
});

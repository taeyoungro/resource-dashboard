// The console list links: right URL for the mapped types, and NO URL for anything that could send
// an approver somewhere wrong - an unmapped type, or an account/region that does not look like one
// and would otherwise end up in the hostname.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSOLE_LIST_PAGES, consoleListUrl, permissionSetUrl, planLinks } from './consoleLinks.js';

const ACCOUNT = '718100330247';

test('the hand-verified example builds byte for byte', () => {
  // The URL that was tested against a live Identity Center session, with the random session
  // suffix removed from the host - the whole reason these links can be offered at all.
  assert.equal(
    consoleListUrl(ACCOUNT, 'us-east-1', 'ec2:instance'),
    'https://718100330247.us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Instances:',
  );
  // Same verification story for the Athena data source list: AwsDataCatalog surfaced in a live
  // assessment with no link, and this URL was checked by hand in that console session.
  assert.equal(
    consoleListUrl(ACCOUNT, 'us-east-1', 'athena:datacatalog'),
    'https://718100330247.us-east-1.console.aws.amazon.com/athena/home?region=us-east-1#/data-sources',
  );
});

test('the region reaches both the host and the query', () => {
  const url = consoleListUrl(ACCOUNT, 'ap-northeast-2', 's3:bucket');
  assert.equal(
    url,
    'https://718100330247.ap-northeast-2.console.aws.amazon.com/s3/buckets?region=ap-northeast-2',
  );
});

test('a global resource falls back to us-east-1 the way the console does', () => {
  // Resource Explorer reports region "global" for IAM. The IAM console ignores region, so the
  // host uses us-east-1 - and the path carries no region parameter at all.
  assert.equal(
    consoleListUrl(ACCOUNT, 'global', 'iam:role'),
    'https://718100330247.us-east-1.console.aws.amazon.com/iam/home#/roles',
  );
});

test('an unmapped type gets no link rather than a guessed one', () => {
  assert.equal(consoleListUrl(ACCOUNT, 'us-east-1', 'quantum:computer'), null);
  assert.equal(consoleListUrl(ACCOUNT, 'us-east-1', ''), null);
});

test('an account id that does not look like one gets no link - it would change the origin', () => {
  for (const bad of [
    '71810033024', // 11 digits
    '7181003302477', // 13 digits
    '718100330247.evil.example', // hostname injection
    '718100330247-w35htiu5', // the session-suffixed form is not an account id
    'accountid1234',
    '',
  ]) {
    assert.equal(consoleListUrl(bad, 'us-east-1', 'ec2:instance'), null, bad);
  }
});

test('a region that does not look like one gets no link, for the same reason', () => {
  for (const bad of [
    'us-east-1.evil.example',
    'US-EAST-1',
    'us-east-1/x',
    'useast1',
    '',
  ]) {
    assert.equal(consoleListUrl(ACCOUNT, bad, 'ec2:instance'), null, bad);
  }
  // Partitioned regions are real regions: three-part names must pass.
  assert.ok(consoleListUrl(ACCOUNT, 'us-gov-west-1', 'ec2:instance'));
});

test('every table entry produces a complete URL with nothing left unsubstituted', () => {
  for (const [type, path] of Object.entries(CONSOLE_LIST_PAGES)) {
    assert.ok(path.startsWith('/'), `${type}: path must start with /`);
    const url = consoleListUrl(ACCOUNT, 'us-east-1', type);
    assert.ok(url !== null, `${type}: table entry did not build`);
    assert.ok(
      url.startsWith(`https://${ACCOUNT}.us-east-1.console.aws.amazon.com/`),
      `${type}: wrong origin ${url}`,
    );
    assert.ok(!url.includes('{region}'), `${type}: placeholder left in ${url}`);
  }
});

test('a plan gets its Spec and Governed links by resource prefix', () => {
  // ps-*: the spec is the IAM role the user edits; the governed artifact is a permission set,
  // whose console page lives under an Identity Center instance id nothing client-side can derive.
  // Without the ARN from the applier's outcome record, Governed opens the Identity Center console
  // rather than a deep link that would 404.
  assert.deepEqual(planLinks(ACCOUNT, 'ps-Prod-Admin'), {
    spec: `https://${ACCOUNT}.us-east-1.console.aws.amazon.com/iam/home#/roles/details/ps-Prod-Admin`,
    governed: `https://${ACCOUNT}.us-east-1.console.aws.amazon.com/singlesignon/home?region=us-east-1`,
  });
  // service roles: both ends are IAM roles, the governed one under the pipeline's mirror- prefix.
  assert.deepEqual(planLinks(ACCOUNT, 'lambda-x'), {
    spec: `https://${ACCOUNT}.us-east-1.console.aws.amazon.com/iam/home#/roles/details/lambda-x`,
    governed: `https://${ACCOUNT}.us-east-1.console.aws.amazon.com/iam/home#/roles/details/mirror-lambda-x`,
  });
  // spec policies: policy detail pages take the URL-ENCODED policy ARN, not the name.
  const policy = planLinks(ACCOUNT, 'cmp-Reporting');
  assert.ok(policy.spec.endsWith(
    `/iam/home#/policies/details/${encodeURIComponent(`arn:aws:iam::${ACCOUNT}:policy/cmp-Reporting`)}`,
  ), policy.spec);
  assert.ok(policy.governed.includes(encodeURIComponent('policy/mirror-cmp-Reporting')), policy.governed);
});

// The ARN the applier recorded for a live permission set, and the console URL that was opened by
// hand from it: the instance segment is the ssoins- id WITHOUT its prefix.
const PS_ARN = 'arn:aws:sso:::permissionSet/ssoins-7223da1aa8587c47/ps-7223bc011e9f4d36';
const PS_DETAIL_URL =
  `https://${ACCOUNT}.us-east-1.console.aws.amazon.com/singlesignon/home?region=us-east-1`
  + '#/instances/7223da1aa8587c47/permission-sets/details/ps-7223bc011e9f4d36';

test('the hand-verified permission set detail page builds byte for byte from the ARN', () => {
  assert.equal(permissionSetUrl(ACCOUNT, PS_ARN), PS_DETAIL_URL);
  // And through planLinks, which is how the page asks: an applied ps-* plan whose outcome carries
  // the ARN deep-links the permission set instead of the console home.
  assert.equal(planLinks(ACCOUNT, 'ps-DataOps-Analyst', { permissionSetArn: PS_ARN }).governed,
               PS_DETAIL_URL);
});

test('an ARN that does not parse falls back to the console home, never a guessed deep link', () => {
  const home =
    `https://${ACCOUNT}.us-east-1.console.aws.amazon.com/singlesignon/home?region=us-east-1`;
  for (const bad of [
    null,
    '',
    `arn:aws:iam::${ACCOUNT}:role/ps-x`, // a role ARN is not a permission set ARN
    'arn:aws:sso:::permissionSet/ssoins-7223da1aa8587c47', // no ps segment
    'arn:aws:sso:::permissionSet/ins-7223da1aa8587c47/ps-7223bc011e9f4d36', // not ssoins-
    'arn:aws:sso:::permissionSet/ssoins-a/ps-b/extra', // trailing segment
    'arn:aws:sso:::permissionSet/ssoins-a"quote/ps-b', // characters that do not belong in a URL
  ]) {
    assert.equal(permissionSetUrl(ACCOUNT, bad), null, String(bad));
    assert.equal(planLinks(ACCOUNT, 'ps-x', { permissionSetArn: bad }).governed, home,
                 String(bad));
  }
});

test('the permission set ARN is validated with the same account and region rules as everything', () => {
  assert.equal(permissionSetUrl('12345', PS_ARN), null);
  // The region reaches the host and the query; a malformed one falls back to us-east-1.
  assert.ok(permissionSetUrl(ACCOUNT, PS_ARN, 'ap-northeast-2').startsWith(
    `https://${ACCOUNT}.ap-northeast-2.console.aws.amazon.com/singlesignon/home?region=ap-northeast-2#`,
  ));
  assert.equal(permissionSetUrl(ACCOUNT, PS_ARN, 'AP-NORTHEAST-2'), PS_DETAIL_URL);
});

test('a recorded ARN changes nothing outside the permission set namespace', () => {
  // A mirror-role plan's Governed link is the mirror role, whatever the outcome carries - the
  // ARN belongs to one domain and must not leak into the others.
  assert.equal(planLinks(ACCOUNT, 'lambda-x', { permissionSetArn: PS_ARN }).governed,
               `https://${ACCOUNT}.us-east-1.console.aws.amazon.com/iam/home#/roles/details/mirror-lambda-x`);
});

test('a plan outside the governed namespaces, or with bad inputs, gets no links', () => {
  assert.deepEqual(planLinks(ACCOUNT, 'random-role'), { spec: null, governed: null });
  assert.deepEqual(planLinks(ACCOUNT, null), { spec: null, governed: null });
  assert.deepEqual(planLinks('123', 'ps-x'), { spec: null, governed: null });
  // a resource name that is not an IAM name must not reach a URL
  assert.equal(planLinks(ACCOUNT, 'ps-a/b').spec, null);
});


// The console list links: right URL for the mapped types, and NO URL for anything that could send
// an approver somewhere wrong - an unmapped type, or an account/region that does not look like one
// and would otherwise end up in the hostname.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONSOLE_LIST_PAGES, consoleListUrl } from './consoleLinks.js';

const ACCOUNT = '718100330247';

test('the hand-verified example builds byte for byte', () => {
  // The URL that was tested against a live Identity Center session, with the random session
  // suffix removed from the host - the whole reason these links can be offered at all.
  assert.equal(
    consoleListUrl(ACCOUNT, 'us-east-1', 'ec2:instance'),
    'https://718100330247.us-east-1.console.aws.amazon.com/ec2/home?region=us-east-1#Instances:',
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

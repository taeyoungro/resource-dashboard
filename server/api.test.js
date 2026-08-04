// Configuration refusals and the API key comparison.
//
// These are the two places where being lenient is expensive: a server that starts against the
// wrong bucket shows an empty list, and an empty list is what a healthy system looks like.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authorised } from './api.js';
import { ConfigError, load } from './config.js';

const GOOD = {
  OPT_MARKER_BUCKET: 'opt-solution-markers',
  OPT_STATE_BUCKET: 'opt-org-policy-terraform-state',
  OPT_DASHBOARD_API_KEY: 'k'.repeat(64),
};

function withEnv(overrides, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OPT_')) delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test('the defaults that matter are the ones that are not there', () => {
  for (const missing of Object.keys(GOOD)) {
    const env = { ...GOOD };
    delete env[missing];
    assert.throws(() => withEnv(env, load), ConfigError, `${missing} was accepted while unset`);
  }
});

test('a key short enough to have been typed by hand is refused', () => {
  assert.throws(() => withEnv({ ...GOOD, OPT_DASHBOARD_API_KEY: 'letmein' }, load), ConfigError);
});

test('prefixes are not configurable', () => {
  // They are the other half of the instance role's Resource statements. A mismatch would be
  // AccessDenied on write and a silently empty list on read, so they are not left to a file.
  const config = withEnv({ ...GOOD, OPT_INSPECTOR_PREFIX: 'somewhere/' }, load);
  assert.equal(config.inspectorPrefix, 'inspector/');
  assert.equal(config.applierPrefix, 'applier/');
  // The state bucket has no plan prefix. Plans are keyed by the governed resource, so they live at
  // <account id>/<resource>/plan/ - one per resource, beside its state.
  assert.equal(config.planPrefix, undefined);
  assert.equal(config.planSuffix, 'plan/');
});

test('loopback is the default bind address', () => {
  // Plain HTTP with a shared key in a header. Anything routable is a decision to be made in the
  // environment file, with TLS in front.
  assert.equal(withEnv(GOOD, load).bindAddress, '127.0.0.1');
});

test('a non-numeric interval is refused rather than becoming NaN', () => {
  assert.throws(
    () => withEnv({ ...GOOD, OPT_SWEEP_INTERVAL_SECONDS: 'daily' }, load),
    ConfigError,
  );
});

test('the key comparison accepts only the key', () => {
  const config = { apiKey: 'k'.repeat(64) };
  assert.equal(authorised(config, 'k'.repeat(64)), true);
  assert.equal(authorised(config, 'k'.repeat(63)), false);
  assert.equal(authorised(config, 'k'.repeat(65)), false);
  assert.equal(authorised(config, undefined), false);
  assert.equal(authorised(config, ''), false);
  assert.equal(authorised(config, 'K'.repeat(64)), false);
});

test('a length mismatch answers false instead of throwing', () => {
  // timingSafeEqual throws on differing lengths, which would become a 500 - and a 500 on a wrong
  // key reads as the server being broken rather than as the key being wrong.
  assert.doesNotThrow(() => authorised({ apiKey: 'abc' }, 'a much longer value'));
});

test('the release is read from the file the installer writes, not only from the environment', () => {
  // Every approval marker records issued_by.release. It read "unknown" on the live host because
  // install.sh writes the commit to /opt/opt-dashboard/RELEASE and nothing puts it in the
  // environment - the environment file is written by hand and a deploy must not rewrite it.
  const config = withEnv({ ...GOOD, OPT_RELEASE: 'abc1234' }, load);
  assert.equal(config.release, 'abc1234');

  // No env var and no file beside a checkout: 'unknown' is then the accurate answer, not a bug.
  assert.equal(withEnv(GOOD, load).release, 'unknown');
});

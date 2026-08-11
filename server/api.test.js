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

// ---- the decision route, with a restriction on it ------------------------------------------------
//
// There was no test here at all, and that is how two bugs shipped together that made every
// restricted approval fail. Both were invisible from the plain approval path, which is the only one
// anybody had exercised:
//
//   a const declared below the restriction block   read inside it, so ReferenceError -> 500
//   the digest set on the stored path only         an assessment that arrived by PUSH gave the page
//                                                  a null sha256, so the route refused it with 400
//
// The harness below is deliberately the whole route rather than a unit: both bugs lived in the
// wiring between reading a plan, reading an assessment and writing a marker, and neither would have
// been visible from a smaller test.

import { createHash } from 'node:crypto';
import { routes } from './api.js';

const ACCOUNT = '644701781058';
const REQUEST = `${ACCOUNT}-8f2c41d90b7e6a35`;
const PLAN_ID = `${ACCOUNT}:ps-alice`;
const PREFIX = `${ACCOUNT}/ps-alice/plan/`;
const QUEUE = `arn:aws:sqs:us-east-1:${ACCOUNT}:nty-stage-orders`;
const CHANGES = 'c'.repeat(64);

const ASSESSMENT = {
  schema: 1,
  request_id: REQUEST,
  account_id: ACCOUNT,
  resource: 'ps-alice',
  kind: 'ps_role',
  allowed_resources: [QUEUE],
  protected_actions: ['iam:CreateRole'],
  policies: [],
  coverage: { complete: true },
};
const ASSESSMENT_JSON = JSON.stringify(ASSESSMENT);
const ASSESSMENT_SHA = createHash('sha256').update(ASSESSMENT_JSON).digest('hex');

function stubS3(objects) {
  const puts = [];
  const s3 = {
    puts,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input ?? {};
      if (name.startsWith('ListObjects')) {
        return {
          Contents: Object.keys(objects).map((key) => ({
            Key: key, Size: objects[key].length, LastModified: new Date(0),
          })),
        };
      }
      if (name.startsWith('GetObject')) {
        const body = objects[input.Key];
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        const buffer = Buffer.from(body);
        return { Body: { transformToByteArray: async () => new Uint8Array(buffer) } };
      }
      if (name.startsWith('PutObject')) {
        puts.push({ key: input.Key, body: input.Body });
        return {};
      }
      return {};
    },
  };
  return s3;
}

function harness({ pushed = null } = {}) {
  const s3 = stubS3({
    [`${PREFIX}plan.txt`]: 'Terraform will perform the following actions:',
    [`${PREFIX}main.tf.json`]: JSON.stringify({ resource: {} }),
    [`${PREFIX}request.json`]: JSON.stringify({
      request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice', kind: 'ps_role',
      has_changes: true,
    }),
    [`${PREFIX}changes.sha256`]: CHANGES,
    [`${PREFIX}tfplan`]: 'binary-plan-bytes',
    [`${PREFIX}plan.json`]: JSON.stringify({ resource_changes: [{ change: { actions: ['update'] } }] }),
    [`${PREFIX}impact.json`]: ASSESSMENT_JSON,
    [`${PREFIX}impact.sha256`]: ASSESSMENT_SHA,
  });
  const route = routes({
    config: {
      markerBucket: 'opt-solution-markers', stateBucket: 'state',
      applierPrefix: 'applier/', planSuffix: 'plan/', release: 'test',
    },
    s3,
    store: {
      state: () => ({ plans: [], markers: [], counts: {}, errors: [] }),
      // Called after a decision is written, so the list stops offering a plan somebody just decided.
      refresh: async () => ({ plans: [], markers: [], counts: {}, errors: [] }),
    },
    notifications: { recent: () => [], enabled: true },
    markerBodies: { put: () => {}, get: () => null },
    impacts: { get: () => pushed },
    actions: { all: () => ({ schema: 1, services: {}, error: null }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { route, s3 };
}

const PUSHED = { impact: ASSESSMENT, impact_sha256: ASSESSMENT_SHA, body_omitted: false };

const decision = (extra = {}) => ({
  decision: 'approve', reviewer: 'someone', comment: 'ok',
  expected_changes_sha256: CHANGES,
  ...extra,
});

const restriction = {
  policy: 'mirror-cmp-Reporting',
  intent: 'deny_only',
  actions: ['sqs:DeleteMessage'],
  resources: [QUEUE],
};

test('the page is given a digest whichever way the assessment arrived', async () => {
  // The push is the ordinary path - the container POSTs the assessment and the dashboard records it -
  // and it was the one returning null. A null here is a 400 later, so the two paths have to agree.
  for (const [label, pushed] of [['pushed', PUSHED], ['stored', null]]) {
    const { route } = harness({ pushed });
    const answer = await route['GET /api/plans/:id']({ params: { id: PLAN_ID } });
    assert.equal(answer.assessment_source, label, `source for ${label}`);
    assert.equal(answer.assessment_sha256, ASSESSMENT_SHA, `digest missing on the ${label} path`);
  }
});

test('an approval carrying a restriction is written, from either assessment path', async () => {
  for (const [label, pushed] of [['pushed', PUSHED], ['stored', null]]) {
    const { route, s3 } = harness({ pushed });
    const answer = await route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ restrictions: [restriction], expected_impact_sha256: ASSESSMENT_SHA }),
    });
    assert.ok(answer.written, `nothing written on the ${label} path`);
    const put = s3.puts.find((p) => p.key.startsWith('applier/'));
    assert.ok(put, `no applier marker on the ${label} path`);
    const marker = JSON.parse(put.body);
    assert.equal(marker.request_id, REQUEST);
    assert.equal(marker.restrictions.length, 1);
    // Copied from the artifact, never computed by this process - it is the untrusted component and
    // must not author the value that authorises its own approval.
    assert.equal(marker.expected_impact_sha256, ASSESSMENT_SHA);
  }
});

test('a restriction naming a resource the assessment did not enumerate is refused', async () => {
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ ...restriction, resources: [`arn:aws:sqs:us-east-1:${ACCOUNT}:elsewhere`] }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /not in the impact assessment/,
  );
});

test('a restriction whose digest is not the stored one is refused', async () => {
  // The page sends back what it displayed. A different value means the prefix was re-assessed under
  // an open page, and the enumerated set the resources were chosen from no longer exists.
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ restrictions: [restriction], expected_impact_sha256: 'f'.repeat(64) }),
    }),
    /was re-assessed since it was shown/,
  );
});

test('a restriction with no digest at all is refused', async () => {
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ restrictions: [restriction] }),
    }),
    /expected_impact_sha256 is required/,
  );
});

test('a denial cannot carry a restriction', async () => {
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        decision: 'deny', comment: 'no', restrictions: [restriction],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /a denial cannot carry a restriction/,
  );
});

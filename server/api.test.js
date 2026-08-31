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
import { readFileSync } from 'node:fs';
import { routes } from './api.js';
import { seedFromTemplate } from './templates.js';

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
  // The action list the container carries, which replaced this server's own copy of it. An empty
  // resource list means the action names no resource type - sqs:ListQueues is account wide.
  action_reference: {
    reference_version: 'a'.repeat(64),
    retrieved_at: '2026-08-11T00:00:00Z',
    services: { sqs: {
      DeleteMessage: ['Write', ['queue']],
      ListQueues: ['Read', []],
      // The third element: this action MAKES every resource it names, so the enumeration - a
      // list of what exists - is no scope for it.
      CreateQueue: ['Write', ['queue'], true],
    } },
  },
  coverage: { complete: true, services_failed: [], truncated_groups: [], policies_unreadable: [] },
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
        // Filtered, because two prefixes in two buckets are now listed for one plan and an
        // unfiltered listing would answer both with everything.
        return {
          Contents: Object.keys(objects)
            .filter((key) => key.startsWith(input.Prefix ?? ''))
            .map((key) => ({
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

function harness({ pushed = null, riskAnalysis = false, assessment = null, planOutputs = null,
                   noChanges = false, refreshFails = false, outcome = null, markers = {},
                   // The ingest key authorises the MACHINE routes - announcements, the assessment
                   // delivery, and the notifier's failure reports. Set here so those are reachable;
                   // the routes a person drives use the dashboard's own key, which this table never
                   // sees because that check happens at the HTTP layer.
                   ingestKey = 'i'.repeat(40),
                   makeModelClient = async () => { throw new Error('not configured'); },
                 } = {}) {
  const document = assessment ? JSON.stringify(assessment) : ASSESSMENT_JSON;
  const sha = createHash('sha256').update(document).digest('hex');
  const s3 = stubS3({
    [`${PREFIX}plan.txt`]: 'Terraform will perform the following actions:',
    [`${PREFIX}main.tf.json`]: JSON.stringify({ resource: {} }),
    [`${PREFIX}request.json`]: JSON.stringify({
      request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice', kind: 'ps_role',
      has_changes: true,
    }),
    [`${PREFIX}changes.sha256`]: CHANGES,
    [`${PREFIX}tfplan`]: 'binary-plan-bytes',
    [`${PREFIX}plan.json`]: JSON.stringify({
      resource_changes: noChanges ? [] : [{ change: { actions: ['update'] } }],
      ...(planOutputs ? { output_changes: planOutputs } : {}),
    }),
    [`${PREFIX}impact.json`]: document,
    [`${PREFIX}impact.sha256`]: sha,
    // What the applier recorded, when a test is about a plan that has been applied. Absent by
    // default: a prefix with one of these is a plan nobody may decide about again.
    ...(outcome ? { [`${PREFIX}outcome.json`]: JSON.stringify(outcome) } : {}),
    // The inline writer's locks and results, in the marker bucket. Same namespace in this stub as
    // the state bucket, which is harmless because every read of them is prefixed.
    ...markers,
  });
  const route = routes({
    config: {
      markerBucket: 'opt-solution-markers', stateBucket: 'state', ingestKey,
      applierPrefix: 'applier/', planSuffix: 'plan/', release: 'test',
      inlineWriterPrefix: 'inline_writer/', inlineResultPrefix: 'inline_result/',
      region: 'us-east-1',
      // What this deployment's own resources are called, for the risk analysis. Defaults here
      // rather than undefined so controlPlane() is exercised the way it runs.
      approvalTable: 'opt-approval-store', lockTable: 'opt-tf-state-lock',
      inlineStateBucket: 'opt-inlinepolicy-terraform', eventQueue: 'opt-iam-event-queue',
      cluster: 'opt-solution-cluster', solutionPrefix: 'opt-', mirrorPrefix: 'mirror-',
      specPolicyPrefix: 'cmp-', controlPlaneArns: [],
      riskAnalysis, bedrockModelId: 'us.anthropic.claude-sonnet-4-6',
      riskAnalysisMaxTokens: 16000, riskAnalysisBatch: 10,
    },
    makeModelClient,
    s3,
    store: {
      state: () => ({ plans: [], markers: [], counts: {}, errors: [] }),
      // Called after a decision is written, so the list stops offering a plan somebody just decided.
      refresh: async () => {
        if (refreshFails) throw new Error('ListObjectsV2 timed out');
        return { plans: [], markers: [], counts: {}, errors: [] };
      },
    },
    notifications: { recent: () => [], enabled: true },
    markerBodies: { put: () => {}, get: () => null },
    impacts: { get: () => pushed },
    actions: { all: () => ({ schema: 1, services: {}, error: null }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { route, s3, impactSha256: sha };
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

test('the model id in the code and in the example environment are the same one', () => {
  // Three places name the model and all three must agree: this default, OPT_BEDROCK_MODEL_ID in
  // the environment file an operator copies from the example, and RiskAnalysisInferenceProfileId
  // in opt-stack-dashboard-host. The grant is built from the last one and the call is made with
  // the first two, so a mismatch is AccessDenied on the screen an approver is waiting on - never a
  // quiet fall back to another model. Only two of the three are in this repository.
  const example = readFileSync(new URL('../deploy/dashboard.env.example', import.meta.url), 'utf8');
  const [, configured] = readFileSync(new URL('./config.js', import.meta.url), 'utf8')
    .match(/OPT_BEDROCK_MODEL_ID \?\? '([^']+)'/);
  assert.equal(configured, 'us.anthropic.claude-sonnet-4-6',
               'this deployment is built for Claude Sonnet 4.6 alone');
  assert.ok(example.includes(`OPT_BEDROCK_MODEL_ID=${configured}`),
            `the example environment does not name ${configured}, so an operator who copies it `
            + 'gets a model the stack did not grant');
  // The profile id, not the bare model id. Sonnet 4.6 is offered through cross-region inference,
  // so a call passing the bare id comes back 400 telling you to pass a profile.
  assert.ok(configured.startsWith('us.'), 'the configured id is not a regional inference profile');
});

test('the page sends the assessment digest whether or not there is a restriction', async () => {
  // Structural, because the runner cannot load the .tsx - and because the test below passes the
  // digest in the body directly, so it proves the SERVER accepts it and says nothing about
  // whether the page ever sends one. That gap shipped once: the server was taught to carry the
  // digest on a plain approval while the page still had it nested inside the restriction
  // conditional, so the PassRole fence was never dispatched and nothing anywhere said why.
  const source = readFileSync(
    new URL('../src/components/PlanPage.tsx', import.meta.url), 'utf8',
  );
  assert.match(
    source,
    /\.\.\.\(detail\.assessment_sha256\s*\n?\s*\?\s*\{\s*expected_impact_sha256:/,
    'PlanPage no longer sends expected_impact_sha256 guarded by having one - if it is nested '
    + 'under restrictions again, a plain approval carries no digest and no fence is ever composed',
  );
});

test('a plain approval carries the digest when it matches, so the fence can be dispatched', async () => {
  // No restriction - but the applier now needs the digest for the PassRole fence: only a
  // digest-named assessment may be the source of the passrole_grants it copies into the dispatch.
  const { route, s3 } = harness({});
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({ expected_impact_sha256: ASSESSMENT_SHA }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal(marker.expected_impact_sha256, ASSESSMENT_SHA);
  assert.equal('restrictions' in marker, false, 'an empty restriction list must not travel');
});

test('a plain approval with a stale or missing digest proceeds without one', async () => {
  // The asymmetry is deliberate: a restriction REQUIRES the digest, the fence merely rides it.
  // Approval was never blocked on the assessment, and must not start being now.
  for (const extra of [{}, { expected_impact_sha256: 'f'.repeat(64) }]) {
    const { route, s3 } = harness({});
    const answer = await route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID }, body: decision(extra),
    });
    assert.ok(answer.written);
    const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
    assert.equal('expected_impact_sha256' in marker, false, JSON.stringify(extra));
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


test('an account-level action cannot be narrowed by an allow_only restriction', async () => {
  // A NotResource list can never contain "*", so the statement would deny sqs:ListQueues outright
  // rather than narrow it. generator/restriction.py refuses this and so does the inline writer; the
  // point of refusing here too is that the person hears the reason while they are still choosing.
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ ...restriction, intent: 'allow_only', actions: ['sqs:ListQueues'] }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /names no resource/,
  );
});

test('an action that makes the resource it names cannot be given a list of them', async () => {
  // Deny sqs:CreateQueue NotResource [the queue that exists] reads as "you may create a queue
  // called this", about a queue that is already there. The inline writer refuses it; the point of
  // refusing here is that the person hears the reason while they are still choosing, rather than
  // finding out after the approval has been sitting in a bucket.
  const { route } = harness({ pushed: PUSHED });
  for (const intent of ['allow_only', 'deny_only']) {
    await assert.rejects(
      () => route['POST /api/plans/:id/decision']({
        params: { id: PLAN_ID },
        body: decision({
          restrictions: [{ ...restriction, intent, actions: ['sqs:CreateQueue'] }],
          expected_impact_sha256: ASSESSMENT_SHA,
        }),
      }),
      /brings the resource it names into being/,
      intent,
    );
  }
});

test('a tag condition on an action that makes its target is refused as dead', async () => {
  // Provably, not as a matter of taste: aws:ResourceTag reads the tags of a resource that exists.
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ policy: restriction.policy, intent: 'tag_condition',
                         actions: ['sqs:CreateQueue'], tag_key: 'env', tag_values: ['prod'] }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /never match/,
  );
});

test('the same action with no resources is the shape that gets through', async () => {
  const { route } = harness({ pushed: PUSHED });
  const answer = await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'deny_only',
                       actions: ['sqs:CreateQueue'], resources: [] }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  assert.ok(answer);
});

test('an account-level action cannot be denied against named resources', async () => {
  // This one is worse than impossible: the statement is accepted by IAM and matches nothing, because
  // the action is authorised against "*" and never against a queue ARN. It reads as a control.
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ ...restriction, intent: 'deny_only', actions: ['sqs:ListQueues'] }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /would never match it/,
  );
});

test('an account-level action denied with no resources is the shape that works', async () => {
  const { route, s3 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: 'p', intent: 'deny_only', actions: ['sqs:ListQueues'], resources: [] }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.restrictions[0].actions, ['sqs:ListQueues']);
});

test('an action a resource list cannot scope is accepted outright as deny_action', async () => {
  // The section that exists so this can be SAID. sqs:CreateQueue brings the queue it names into
  // being, so every shape carrying a resource list is refused above - and until deny_action there
  // was no shape left that meant "may not create a queue at all" except an empty deny_only, which
  // is also what an administrator produces by forgetting to pick. Same statement, different
  // decision, and only one of the two is refused for the forgetting.
  const { route, s3 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'deny_action',
                       actions: ['sqs:CreateQueue'] }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal(marker.restrictions[0].intent, 'deny_action');
  assert.deepEqual(marker.restrictions[0].actions, ['sqs:CreateQueue']);
});

test('deny_action refuses what it would record and never evaluate', async () => {
  // It composes Resource "*" and nothing else. A resource list or a tag alongside it would sit in
  // the marker, describe a decision the statement does not carry, and be refused hours later by the
  // inline writer - which is the whole reason this route mirrors generator/restriction.py._validate
  // rather than letting the bucket be the first place it is checked.
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ ...restriction, intent: 'deny_action' }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /denies the action outright/,
  );
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ policy: restriction.policy, intent: 'deny_action',
                         actions: ['sqs:DeleteMessage'], tag_key: 'env', tag_values: ['prod'] }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /unconditional by construction/,
  );
});

test('a tag condition carries an operator now, and only a valid one', async () => {
  // The fix: the branch hardcoded StringEquals - the open form, under which a resource carrying no
  // such tag at all does not match and walks past the control. Both spellings are now decisions.
  const { route, s3 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'tag_condition',
                       actions: ['sqs:DeleteMessage'], tag_key: 'env', tag_values: ['prod'],
                       condition_operator: 'StringNotEquals' }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal(marker.restrictions[0].condition_operator, 'StringNotEquals');

  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ policy: restriction.policy, intent: 'tag_condition',
                         actions: ['sqs:DeleteMessage'], tag_key: 'env', tag_values: ['prod'],
                         condition_operator: 'Null' }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /must be one of/,
  );
  // And an intent whose statement has no Condition still cannot carry one.
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ ...restriction, intent: 'deny_action', resources: [],
                         condition_operator: 'StringEquals' }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /carries a condition operator/,
  );
});

// An assessment whose reference names the actions AWS evaluates no aws:ResourceTag for.
const UNTAGGABLE = {
  ...ASSESSMENT,
  action_reference: {
    ...ASSESSMENT.action_reference,
    services: {
      ...ASSESSMENT.action_reference.services,
      iam: { AttachGroupPolicy: ['Permissions management', ['group']] },
    },
    no_resource_tag: ['iam:AttachGroupPolicy', 'sqs:ListQueues'],
  },
};

test('a tag condition on an action AWS reads no resource tag for is refused', async () => {
  // The coherence gate tag_condition was missing while key_condition had one. `group` is one of
  // seven iam types carrying no aws:ResourceTag, so the condition is absent from the request
  // context and the statement never fires - it just reads as the control that was chosen.
  const { route, impactSha256 } = harness({ assessment: UNTAGGABLE });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ policy: restriction.policy, intent: 'tag_condition',
                         actions: ['iam:AttachGroupPolicy'], tag_key: 'env',
                         tag_values: ['prod'] }],
        expected_impact_sha256: impactSha256,
      }),
    }),
    /aws:ResourceTag를 평가하지 않는다/,
  );
});

test('an assessment without the tag vocabulary passes the tag condition through', async () => {
  // Same arrangement as condition_keys and created_formats: an older assessment cannot say, the
  // route does not guess, and the writer judges from its own table.
  const { route, s3 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'tag_condition',
                       actions: ['sqs:DeleteMessage'], tag_key: 'env', tag_values: ['prod'] }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  assert.ok(s3.puts.some((p) => p.key.startsWith('applier/')));
});

// An assessment whose reference carries the condition-key vocabulary, for the key_condition gates.
// The design review's example: lambda:CreateFunctionUrlConfig declares lambda:FunctionUrlAuthType.
const KEYED = {
  ...ASSESSMENT,
  action_reference: {
    ...ASSESSMENT.action_reference,
    services: {
      ...ASSESSMENT.action_reference.services,
      lambda: { CreateFunctionUrlConfig: ['Write', ['function']] },
    },
    condition_keys: { lambda: { CreateFunctionUrlConfig: ['lambda:FunctionUrlAuthType'] } },
  },
};

test('a key_condition on a declared key is written, operator and all', async () => {
  // The operator is absent on purpose: the writer's parser fills in StringNotEquals, so the route
  // must not demand it - absence is the closed default, not a third state.
  const { route, s3, impactSha256 } = harness({ assessment: KEYED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'key_condition',
                       actions: ['lambda:CreateFunctionUrlConfig'],
                       condition_key: 'lambda:FunctionUrlAuthType',
                       condition_values: ['AWS_IAM'] }],
      expected_impact_sha256: impactSha256,
    }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal(marker.restrictions[0].intent, 'key_condition');
  assert.equal(marker.restrictions[0].condition_key, 'lambda:FunctionUrlAuthType');
  assert.deepEqual(marker.restrictions[0].condition_values, ['AWS_IAM']);
});

test('a key the action does not declare is refused with what it does declare', async () => {
  // On an action that does not declare the key, the condition never evaluates - under StringEquals
  // the statement denies nothing, under StringNotEquals it denies every call - and either way it
  // reads as the control that was chosen. The writer refuses this; refusing here means the person
  // hears it while choosing, with the declared keys as the way forward.
  const { route, impactSha256 } = harness({ assessment: KEYED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ policy: restriction.policy, intent: 'key_condition',
                         actions: ['lambda:CreateFunctionUrlConfig'],
                         condition_key: 'lambda:FunctionUrlSomethingElse',
                         condition_values: ['NONE'] }],
        expected_impact_sha256: impactSha256,
      }),
    }),
    /does not declare .*It declares: lambda:FunctionUrlAuthType/,
  );
  // And an action with no declared keys at all says that, rather than listing nothing.
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ policy: restriction.policy, intent: 'key_condition',
                         actions: ['sqs:DeleteMessage'],
                         condition_key: 'sqs:SomeKey', condition_values: ['x'] }],
        expected_impact_sha256: impactSha256,
      }),
    }),
    /declares no service condition key at all/,
  );
});

test('an assessment without the vocabulary passes key_condition through to the writer', async () => {
  // The same arrangement created_formats has: an assessment written before the reference carried
  // condition_keys cannot distinguish "declares no keys" from "predates the map", so the route does
  // not guess - the writer refuses authoritatively, and the runbook's re-query step closes the
  // window. Structural gates still apply either way.
  const { route, s3 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'key_condition',
                       actions: ['sqs:DeleteMessage'],
                       condition_key: 'sqs:SomeKey', condition_values: ['x'] }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  assert.ok(s3.puts.some((p) => p.key.startsWith('applier/')));
});

test('key_condition refuses what it would record and never evaluate', async () => {
  const { route, impactSha256 } = harness({ assessment: KEYED });
  const attempt = (extra) => route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'key_condition',
                       actions: ['lambda:CreateFunctionUrlConfig'],
                       condition_key: 'lambda:FunctionUrlAuthType',
                       condition_values: ['AWS_IAM'], ...extra }],
      expected_impact_sha256: impactSha256,
    }),
  });
  await assert.rejects(attempt({ condition_values: [] }), /needs both a condition key/);
  await assert.rejects(attempt({ condition_operator: 'StringLike' }), /must be one of/);
  await assert.rejects(attempt({ resources: [QUEUE] }), /change nothing about the statement/);
  await assert.rejects(attempt({ tag_key: 'env', tag_values: ['prod'] }), /"태그로 거부"/);
});

test('condition fields on any other intent are refused as recorded-and-inert', async () => {
  // The mirror of the writer's cross-intent gate: only key_condition composes a request-key
  // condition, so these fields anywhere else would sit in the marker and never reach a statement.
  const { route } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ ...restriction, condition_key: 'sqs:SomeKey' }],
        expected_impact_sha256: ASSESSMENT_SHA,
      }),
    }),
    /Only "조건으로 거부" composes a request-key condition/,
  );
});

// An assessment whose reference carries allow_only verdicts, and whose groups type the ARNs the
// cover check reads. ec2:AttachVolume is authorised against the instance AND the volume - a
// decision keeping only one leaves the other type's authorisation context outside the NotResource
// and denies every call.
const EC2_INSTANCE = `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/i-060d7f3f7d9798447`;
const EC2_VOLUME = `arn:aws:ec2:us-east-1:${ACCOUNT}:volume/vol-049df61146c4d7901`;
const VERDICTED = {
  ...ASSESSMENT,
  allowed_resources: [QUEUE, EC2_INSTANCE, EC2_VOLUME],
  policies: [{
    identifier: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
    source: 'aws_managed', default_version_id: 'v5', is_baseline: false, restrictable: true,
    unreadable: null,
    actions_granted: ['ec2:AttachVolume'], actions_offerable: ['ec2:AttachVolume'],
    actions_non_restrictable: [],
    affected: [
      { service: 'ec2', resource_type: 'ec2:instance', actions: ['ec2:AttachVolume'],
        scope: '*', total: 1, truncated: false, sensitive_hits: 0, attribution: 'resource_type',
        resources: [{ arn: EC2_INSTANCE, region: 'us-east-1', tags: {}, sensitive: false }] },
      { service: 'ec2', resource_type: 'ec2:volume', actions: ['ec2:AttachVolume'],
        scope: '*', total: 1, truncated: false, sensitive_hits: 0, attribution: 'resource_type',
        resources: [{ arn: EC2_VOLUME, region: 'us-east-1', tags: {}, sensitive: false }] },
    ],
  }],
  action_reference: {
    ...ASSESSMENT.action_reference,
    services: {
      ...ASSESSMENT.action_reference.services,
      ec2: {
        AttachVolume: ['Write', ['instance', 'volume']],
        ReplaceRouteTableAssociation: ['Write', ['route-table', 'subnet']],
      },
    },
    allow_only: { ec2: {
      ReplaceRouteTableAssociation: { refuse: 'deref:AssociationId' },
      AttachVolume: { cover: ['instance', 'volume'] },
    } },
  },
};

test('an action judged unsafe for allow_only is refused with its mechanism', async () => {
  // The reported defect class: the call is authorised against the route table CURRENTLY
  // associated, resolved from the AssociationId - no enumeration can hold that ARN, so the
  // statement denies every call while reading as a scope. The writer refuses it from the table;
  // refusing here means the administrator hears it while still choosing.
  const { route, impactSha256 } = harness({ assessment: VERDICTED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        restrictions: [{ policy: restriction.policy, intent: 'allow_only',
                         actions: ['ec2:ReplaceRouteTableAssociation'], resources: [QUEUE] }],
        expected_impact_sha256: impactSha256,
      }),
    }),
    /AssociationId[\s\S]*범위처럼 읽힌다/,
  );
});

test('a safe multi-type action must keep at least one resource of every type', async () => {
  // The gate the writer cannot hold - it receives a flat resource set with no types - so this
  // route holds it, from the assessment's own typed enumeration.
  const { route, s3, impactSha256 } = harness({ assessment: VERDICTED });
  const attempt = (resources) => route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'allow_only',
                       actions: ['ec2:AttachVolume'], resources }],
      expected_impact_sha256: impactSha256,
    }),
  });
  await assert.rejects(attempt([EC2_VOLUME]), /instance/);
  await attempt([EC2_VOLUME, EC2_INSTANCE]);
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.restrictions[0].actions, ['ec2:AttachVolume']);
});

test('an assessment without verdicts passes allow_only through to the writer', async () => {
  // Same arrangement as condition_keys and created_formats: an older assessment cannot say, the
  // route does not guess, and the writer judges from its own table.
  const { route, s3 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ policy: restriction.policy, intent: 'allow_only',
                       actions: ['sqs:DeleteMessage'], resources: [QUEUE] }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  assert.ok(s3.puts.some((p) => p.key.startsWith('applier/')));
});

test('five sections on one policy are five restrictions in the marker', async () => {
  // The composability the editor was rebuilt for. A policy carried exactly one intent because the
  // page had one dropdown, never because the wire could not hold more - a Deny is a Deny whatever
  // prompted it, and each decision composes its own statement into the one inline document.
  const { route, s3, impactSha256 } = harness({ assessment: KEYED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [
        { policy: restriction.policy, intent: 'allow_only',
          actions: ['sqs:DeleteMessage'], resources: [QUEUE] },
        { policy: restriction.policy, intent: 'deny_only',
          actions: ['sqs:SendMessage'], resources: [QUEUE] },
        { policy: restriction.policy, intent: 'deny_action', actions: ['sqs:CreateQueue'] },
        { policy: restriction.policy, intent: 'tag_condition',
          actions: ['sqs:PurgeQueue'], tag_key: 'env', tag_values: ['prod'] },
        { policy: restriction.policy, intent: 'key_condition',
          actions: ['lambda:CreateFunctionUrlConfig'],
          condition_key: 'lambda:FunctionUrlAuthType', condition_values: ['AWS_IAM'] },
      ],
      expected_impact_sha256: impactSha256,
    }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.restrictions.map((r) => r.intent),
                   ['allow_only', 'deny_only', 'deny_action', 'tag_condition', 'key_condition']);
});

test('an action with resource types is unaffected by the account-level checks', async () => {
  const { route, s3 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      restrictions: [{ ...restriction, intent: 'allow_only' }],
      expected_impact_sha256: ASSESSMENT_SHA,
    }),
  });
  assert.ok(s3.puts.some((p) => p.key.startsWith('applier/')));
});

// ---- the risk analysis route ------------------------------------------------------------------
//
// The route is one call with two halves. The rules are deterministic and always run; the model is
// asked only when a deployment turned it on. What is tested here is that the halves do not depend
// on each other - a deployment with no Bedrock still gets rule findings, and a model that fails
// does not take them down with it.

/** An assessment holding one policy that produces a candidate path and fires a rule. */
const ANALYSABLE = {
  ...ASSESSMENT,
  policies: [{
    identifier: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess',
    source: 'aws_managed',
    default_version_id: 'v7',
    is_baseline: false,
    restrictable: true,
    unreadable: null,
    actions_granted: ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'],
    actions_offerable: ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'],
    actions_non_restrictable: [],
    affected: [{
      service: 'lambda',
      resource_type: 'lambda:function',
      actions: ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction'],
      scope: '*',
      total: 2,
      truncated: false,
      sensitive_hits: 0,
      attribution: 'resource_type',
      resources: [
        { arn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:report-writer`, region: 'us-east-1',
          tags: {}, sensitive: false },
        { arn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:order-sync`, region: 'us-east-1',
          tags: {}, sensitive: false },
      ],
    }],
  }],
  action_reference: {
    reference_version: 'a'.repeat(64),
    retrieved_at: '2026-08-11T00:00:00Z',
    services: {
      lambda: { UpdateFunctionCode: ['Write', ['function']], InvokeFunction: ['Write', ['function']] },
    },
  },
};

/**
 * A model that answers every candidate it is given, citing the actions it was given.
 *
 * `delayMs` holds the call open before it resolves - for the one test that has to observe a run
 * still in the RUNNING state without racing the stub's own near-instant resolution. Zero elsewhere,
 * which is a real `await` and not a no-op, so those tests keep exercising the actual async path.
 */
function modelStub(over = {}, { delayMs = 0 } = {}) {
  const calls = [];
  return {
    calls,
    make: async () => ({
      messages: {
        async create(body) {
          calls.push(body);
          if (delayMs > 0) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
          // Parsed out of the block rather than scraped with a regular expression. A first
          // attempt scraped every lambda:* token and picked up 'lambda:function', the resource
          // TYPE - which the validator correctly called a fabricated action and discarded the whole
          // run for. The stub has to cite what a candidate offers, exactly as the frame requires.
          const text = body.messages[0].content[1].text;
          const block = text.slice(text.indexOf('<candidates>') + 12, text.indexOf('</candidates>'));
          const batch = JSON.parse(block);
          const ids = batch.map((c) => c.id);
          const cited = [...new Set(batch.flatMap(
            (c) => [...c.steps, ...c.also_granted].flatMap((s) => s.actions)))];
          return {
            content: [{ type: 'text', text: JSON.stringify({
              verdicts: ids.map((id) => ({
                candidate_id: id, real: true, human_error: true, mechanism: 'existing_resource',
                preconditions: [], final_impact: '함수에 부착된 역할로 코드가 실행된다.',
                evidence_sufficient: true, cited_actions: cited, category: 'ESCALATION',
                proposed_grade: 'HIGH', title: '실행 코드 교체',
                narrative: '코드를 교체한 뒤 호출하면 부착된 역할로 실행된다. 역할 전달 권한은 필요하지 않다.',
                containment: { deny_actions: cited.slice(0, 1),
                               breaks: '이 함수들에 대한 코드 배포가 막힌다.',
                               blocked_elsewhere: false },
                ...over,
              })),
            }) }],
            usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 4000,
                     cache_creation_input_tokens: 0 },
          };
        },
      },
    }),
  };
}

test('the rules run with no model, and the route says the model was not asked', async () => {
  // The half an approver can rely on without trusting a model at all. A deployment that never
  // enables Bedrock still gets the twelve rules fired against the assessment.
  const { route } = harness({ assessment: ANALYSABLE });
  const answer = await route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} });
  assert.ok(answer.rule_findings.length > 0, 'no rule fired on a grant that rewrites function code');
  assert.ok(answer.rule_findings.some((f) => f.id === 'E-3'));
  assert.equal(answer.analysis, null);
  assert.match(answer.analysis_error, /OPT_RISK_ANALYSIS is not on/);
  assert.ok(answer.digest_bytes > 0);
  assert.ok(answer.candidates > 0);
  assert.equal(answer.rules_sha256.length, 64);
});

/**
 * Ask for the analysis and wait for the model half, the way the page does.
 *
 * The POST answers as soon as the RULES have fired and leaves the model running on the server -
 * that split is what took a minutes-long request, and the 504 in front of it, off the table. A test
 * that only pressed the button would be asserting about an answer that has not been written yet.
 */
async function analysed(route, id = PLAN_ID) {
  const started = await route['POST /api/plans/:id/analysis']({ params: { id }, body: {} });
  if (started.run?.state !== 'running') return started;
  for (let tick = 0; tick < 500; tick += 1) {
    const next = await route['GET /api/plans/:id/analysis']({ params: { id } });
    if (next.run?.state !== 'running') return next;
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
  throw new Error('the run never left the running state');
}

test('the rules come back without waiting for the model', async () => {
  // The whole reason the route is split. A real assessment is several batches and minutes of model
  // time, and it used to be one request holding a connection open for all of it - long enough for
  // whatever terminates TLS in front of the dashboard to answer 504 while the server kept paying
  // for verdicts the browser would never receive.
  const model = modelStub();
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const started = await route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} });
  assert.ok(started.rule_findings.length > 0, 'the rule findings did not come back with the POST');
  assert.equal(started.analysis, null, 'the POST waited for the model');
  assert.equal(started.run.state, 'running');
  assert.ok(typeof started.run.started_at === 'string');
});

test('정책 기반 분석: engine "rules" returns the rules and starts no model run', async () => {
  // The entire reason the field exists. Two buttons, and pressing the free one must not bill the
  // paid one as a side effect - that is the difference between this and a client that posts the
  // same body from both buttons and only chooses what to render.
  const model = modelStub();
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const answer = await route['POST /api/plans/:id/analysis'](
    { params: { id: PLAN_ID }, body: { engine: 'rules' } },
  );
  assert.ok(answer.rule_findings.length > 0);
  assert.equal(answer.analysis, null, 'a model run started');
  assert.equal(answer.run, null, 'a run entry was created for this plan');
  assert.equal(model.calls.length, 0, 'the model was called');
});

test('AI 분석 first, then 정책 기반 분석: the second call rides the model run rather than starting one', async () => {
  // Order must not matter. If the AI button already bought an answer for this assessment, asking
  // for the rules half again should hand back what already exists rather than pretend it is not
  // there - but it must not be the rules-only call that triggers a SECOND model run.
  const model = modelStub();
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const ai = await analysed(route);
  assert.equal(ai.run.state, 'done');
  assert.equal(model.calls.length, 1);

  const rules = await route['POST /api/plans/:id/analysis'](
    { params: { id: PLAN_ID }, body: { engine: 'rules' } },
  );
  assert.equal(model.calls.length, 1, 'a second model call was made');
  // The already-finished model answer rides along - it is not withheld from a rules-only ask,
  // because handing back work already paid for costs nothing further.
  assert.equal(rules.analysis.findings_sha256, ai.analysis.findings_sha256);
  assert.equal(rules.run.state, 'done');
});

test('정책 기반 분석 while AI 분석 is still running surfaces the in-flight run without starting another', async () => {
  // delayMs holds the model call open, so the second POST lands while the run is provably still
  // RUNNING rather than racing the stub's own near-instant resolution.
  const model = modelStub({}, { delayMs: 30 });
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const started = await route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} });
  assert.equal(started.run.state, 'running');

  const rules = await route['POST /api/plans/:id/analysis'](
    { params: { id: PLAN_ID }, body: { engine: 'rules' } },
  );
  assert.equal(rules.run.state, 'running', 'the in-flight run was not surfaced');
  assert.equal(rules.analysis, null, 'a rules-only ask should not itself have an answer yet');
  assert.equal(model.calls.length, 1, 'the rules-only ask started a second model call');
});

test('an unrecognised engine value defaults to starting the model, never to silently skipping it', async () => {
  // This field is set by our own two buttons, never by a person typing into a form - so the failure
  // mode that matters is a typo costing more, not a typo silently costing less than the user meant.
  const model = modelStub();
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const answer = await route['POST /api/plans/:id/analysis'](
    { params: { id: PLAN_ID }, body: { engine: 'ai' } },
  );
  assert.equal(answer.run.state, 'running');
});

test('the run is polled until it has an answer, and the answer carries the rules too', async () => {
  const model = modelStub();
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const answer = await analysed(route);
  assert.equal(answer.run.state, 'done');
  assert.ok(answer.analysis.findings.length > 0);
  assert.ok(answer.rule_findings.length > 0);
  // How long it took, recorded. Its absence is why the 504 could not be told from a hung process.
  assert.ok(answer.analysis.timing.totalMs >= 0);
  assert.equal(answer.analysis.timing.batchMs.length, 1);
});

test('asking again for an assessment already answered does not ask the model again', async () => {
  // A second press of the button, or a browser reload, is not a request for a second opinion - and
  // the model half costs money and minutes.
  const model = modelStub();
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const first = await analysed(route);
  const again = await route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} });
  assert.equal(model.calls.length, 1, 'the model was asked a second time');
  assert.equal(again.analysis.findings_sha256, first.analysis.findings_sha256);
  // And it says it is finished. The task took its copy of the answer before it started, so the run
  // field frozen into that copy still says running - handing it back would send the page off
  // polling for an answer it is already holding.
  assert.equal(again.run.state, 'done');
});

test('polling a plan nobody started says so instead of hanging', async () => {
  // Nothing is stored, so a restart loses what was in flight. The page can act on that sentence;
  // it cannot act on a poll that never resolves.
  const { route } = harness({ assessment: ANALYSABLE, riskAnalysis: true });
  await assert.rejects(
    () => route['GET /api/plans/:id/analysis']({ params: { id: PLAN_ID } }),
    /no analysis has been started/,
  );
});

test('with the analysis on, the model judges the candidates the code proposed', async () => {
  const model = modelStub();
  const { route, impactSha256 } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const answer = await analysed(route);
  assert.equal(model.calls.length, 1);
  assert.ok(answer.analysis.findings.length > 0);
  assert.equal(answer.analysis.impact_sha256, impactSha256);
  assert.equal(answer.analysis.findings_sha256.length, 64);
  assert.equal(answer.analysis.usage.cacheRead, 4000);
  assert.equal(answer.analysis_error, null);
  // The rules ran too, and the two lists are kept apart - one is a rule firing, the other is a
  // model's judgement of a proposed path, and an approver reads them differently.
  assert.ok(answer.rule_findings.length > 0);
  assert.ok(answer.analysis.findings.every((f) => f.source === 'model'));
});

test('a model that fails leaves the rule findings standing', async () => {
  // An analysis outage is not an approval outage - the same rule the assessment itself follows.
  const { route } = harness({
    assessment: ANALYSABLE, riskAnalysis: true,
    makeModelClient: async () => { throw new Error('AccessDeniedException'); },
  });
  const answer = await analysed(route);
  assert.ok(answer.rule_findings.length > 0);
  assert.equal(answer.analysis, null);
  assert.match(answer.analysis_error, /AccessDenied/);
  // The RUN finished. A model outage is a result, not a broken run - which is why it comes back as
  // done carrying analysis_error rather than as failed.
  assert.equal(answer.run.state, 'done');
});

test('there is nothing to analyse without a stored assessment, and it says so', async () => {
  const s3 = stubS3({
    [`${PREFIX}plan.txt`]: 'Terraform will perform the following actions:',
    [`${PREFIX}request.json`]: JSON.stringify({
      request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice', kind: 'ps_role',
      has_changes: true,
    }),
    [`${PREFIX}changes.sha256`]: CHANGES,
    [`${PREFIX}tfplan`]: 'binary-plan-bytes',
  });
  const route = routes({
    config: {
      markerBucket: 'opt-solution-markers', stateBucket: 'state', applierPrefix: 'applier/',
      planSuffix: 'plan/', release: 'test', region: 'us-east-1', controlPlaneArns: [],
      riskAnalysis: false,
    },
    s3,
    store: { state: () => ({}), refresh: async () => ({}) },
    notifications: { recent: () => [], enabled: true },
    markerBodies: { put: () => {}, get: () => null },
    impacts: { get: () => null },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} }),
    /no stored impact assessment/,
  );
});

test('an assessment describing another inspection is refused rather than analysed', async () => {
  // The same drift check the restriction path makes. A prefix is overwritten in place by every
  // inspection, so a stale assessment beside a fresh plan is a true-looking description of
  // something that no longer exists.
  const { route } = harness({
    assessment: { ...ANALYSABLE, request_id: `${ACCOUNT}-0000000000000000` },
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} }),
    /reload the plan/,
  );
});

// ---- citing the analysis on the marker --------------------------------------------------------

const citation = (over = {}) => ({
  findings_sha256: 'f'.repeat(64),
  model_id: 'us.anthropic.claude-sonnet-4-6',
  prompt_version: 'v1-abcdef123456',
  ...over,
});

test('an approval cites the analysis it was taken against', async () => {
  const { route, s3, impactSha256 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({
      expected_impact_sha256: impactSha256,
      risk_analysis: citation({ impact_sha256: impactSha256 }),
    }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.risk_analysis, {
    findings_sha256: 'f'.repeat(64),
    model_id: 'us.anthropic.claude-sonnet-4-6',
    prompt_version: 'v1-abcdef123456',
    impact_sha256: impactSha256,
  });
  // Cited, not copied. The findings are advisory text and the applier has no use for them.
  assert.equal(marker.risk_analysis.findings, undefined);
});

test('a citation naming another assessment is refused', async () => {
  // The screen and the bucket had drifted apart, which is what every digest check here is for.
  const { route, impactSha256 } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({
        expected_impact_sha256: impactSha256,
        risk_analysis: citation({ impact_sha256: 'b'.repeat(64) }),
      }),
    }),
    /does not match the stored assessment/,
  );
});

test('a citation without a verified assessment digest is refused', async () => {
  const { route, impactSha256 } = harness({ pushed: PUSHED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ risk_analysis: citation({ impact_sha256: impactSha256 }) }),
    }),
    /without a verified assessment digest/,
  );
});

test('a malformed citation is refused rather than recorded', async () => {
  const { route, impactSha256 } = harness({ pushed: PUSHED });
  for (const bad of [{ findings_sha256: 'short' }, { model_id: '' }, { prompt_version: '' }]) {
    await assert.rejects(
      () => route['POST /api/plans/:id/decision']({
        params: { id: PLAN_ID },
        body: decision({
          expected_impact_sha256: impactSha256,
          risk_analysis: citation({ impact_sha256: impactSha256, ...bad }),
        }),
      }),
      /risk_analysis/,
      JSON.stringify(bad),
    );
  }
});

test('an approval with no analysis carries no citation', async () => {
  const { route, s3, impactSha256 } = harness({ pushed: PUSHED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({ expected_impact_sha256: impactSha256 }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal('risk_analysis' in marker, false);
});

test('the templates route serves what the deployment ships, validated', async () => {
  const { route } = harness({ pushed: PUSHED });
  const answer = await route['GET /api/templates']();
  assert.equal(answer.error, null, 'the shipped template file is unusable');
  assert.ok(answer.templates.length >= 3);
  // Only the three intents that mean the same thing in every account - a template carrying an ARN
  // would name a resource that does not exist in the account being approved.
  for (const template of answer.templates) {
    for (const row of template.restrictions) {
      assert.ok(['deny_action', 'tag_condition', 'key_condition'].includes(row.intent),
                `${template.id} carries ${row.intent}`);
      assert.ok(!row.resources, `${template.id} names resources`);
    }
  }
});

test('a template seeds an ordinary decision that the route accepts unchanged', async () => {
  // The property the whole shape rests on: what arrives at the route is indistinguishable from
  // something an approver ticked, so every gate still runs on it.
  const { route, s3, impactSha256 } = harness({ assessment: KEYED });
  const template = (await route['GET /api/templates']()).templates
    .find((t) => t.id === 'no-public-function-url');
  const { restrictions, dropped } = seedFromTemplate(template, KEYED);
  assert.equal(restrictions.length, 0, 'this assessment grants none of it');
  assert.ok(dropped.every((d) => d.why === 'not_granted'));

  // And with a policy that DOES grant it, the seeded row goes through the decision route as-is.
  const granting = {
    ...KEYED,
    policies: [{
      identifier: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess',
      source: 'aws_managed', default_version_id: 'v7', is_baseline: false, restrictable: true,
      unreadable: null,
      actions_granted: ['lambda:CreateFunctionUrlConfig'],
      actions_offerable: ['lambda:CreateFunctionUrlConfig'],
      actions_non_restrictable: [], affected: [],
    }],
  };
  const seeded = seedFromTemplate(template, granting).restrictions;
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].condition_operator, 'StringNotEquals');
  const withGrant = harness({ assessment: granting });
  await withGrant.route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID },
    body: decision({ restrictions: seeded, expected_impact_sha256: withGrant.impactSha256 }),
  });
  const marker = JSON.parse(
    withGrant.s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal(marker.restrictions[0].intent, 'key_condition');
  assert.equal(marker.restrictions[0].condition_key, 'lambda:FunctionUrlAuthType');
  assert.ok(s3 && impactSha256);
});

// ---- one policy at a time ----------------------------------------------------------------------

/** Two attached policies that fire different rules, so a scope is visible in the result. */
const TWO_POLICIES = {
  ...ASSESSMENT,
  policies: [
    { source: 'aws_managed', identifier: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
      default_version_id: 'v1', is_baseline: false, restrictable: true, unreadable: null,
      actions_granted: ['ec2:TerminateInstances'], actions_offerable: ['ec2:TerminateInstances'],
      affected: [] },
    { source: 'aws_managed', identifier: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess',
      default_version_id: 'v1', is_baseline: false, restrictable: true, unreadable: null,
      actions_granted: ['lambda:DeleteFunction'], actions_offerable: ['lambda:DeleteFunction'],
      affected: [] },
  ],
  action_reference: {
    ...ASSESSMENT.action_reference,
    services: {
      ...ASSESSMENT.action_reference.services,
      ec2: { TerminateInstances: ['Write', ['instance']] },
      lambda: { DeleteFunction: ['Write', ['function']] },
    },
  },
};

test('an analysis can be scoped to one attached policy, and the scope is echoed', async () => {
  // Five attached policies is five policies' worth of candidates, and the model half is billed per
  // candidate. Nothing in either half is computed ACROSS policies - every finding and every
  // candidate belongs to exactly one grant - so scoping is a filter and loses nothing.
  const { route } = harness({ assessment: TWO_POLICIES });
  const whole = await route['POST /api/plans/:id/analysis'](
    { params: { id: PLAN_ID }, body: { engine: 'rules' } });
  assert.equal(whole.policies.length, 2, 'the fixture has nothing to scope between');
  assert.ok(whole.rule_findings.length >= 2, 'both policies should have fired something');
  assert.equal(whole.policy, null);

  const one = whole.policies[0].identifier;
  const scoped = await route['POST /api/plans/:id/analysis'](
    { params: { id: PLAN_ID }, body: { engine: 'rules', policy: one } });
  assert.equal(scoped.policy, one);
  assert.ok(scoped.rule_findings.every((f) => f.policyName === one),
            "a scoped analysis returned another policy's findings");
  assert.ok(scoped.rule_findings.length < whole.rule_findings.length,
            'the scope filtered nothing out');
  // The roster travels either way, so the page can draw every area from one call.
  assert.deepEqual(scoped.policies, whole.policies);
});

test('a policy that is not attached is refused rather than silently meaning all of them', async () => {
  // A typo that fell through to the whole plan would bill for five and report as one.
  const { route } = harness({ assessment: TWO_POLICIES });
  await assert.rejects(
    route['POST /api/plans/:id/analysis'](
      { params: { id: PLAN_ID }, body: { engine: 'rules', policy: 'arn:aws:iam::aws:policy/Nope' } }),
    (e) => e.status === 400 && /not an attached policy/.test(e.message),
  );
});

test('polling one scope never returns another scope\'s run', async () => {
  // Two policies analysed separately are two runs under one plan id. A poll that did not name the
  // scope would be handed whichever happened to be there - an answer about a different policy,
  // under this one's heading.
  const { route } = harness({ assessment: TWO_POLICIES });
  await assert.rejects(
    route['GET /api/plans/:id/analysis']({
      params: { id: PLAN_ID },
      query: new URLSearchParams({ policy: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess' }),
    }),
    (e) => e.status === 404 && /AmazonEC2FullAccess/.test(e.message),
    'the poll fell back to the whole-plan run',
  );
});


// ---- the resource policy review, and the document it is a claim about ---------------------------
//
// The panel that prints the policy needs one thing from this route that the reading does not: the
// document as S3 returned it. Re-serialising the parsed structure is not the same document - key
// order, spacing and a duplicate key are the parser's to decide - and on a policy that will not
// parse there is no parsed structure at all, which is exactly when somebody needs to see the bytes.

function reviewRoute(policyText, { accountId = ACCOUNT } = {}) {
  const s3 = {
    async send(command) {
      if (!command.constructor.name.startsWith('GetBucketPolicy')) {
        throw new Error(`unexpected ${command.constructor.name}`);
      }
      if (policyText === null) {
        const err = new Error('NoSuchBucketPolicy');
        err.name = 'NoSuchBucketPolicy';
        throw err;
      }
      return { Policy: policyText };
    },
  };
  return routes({
    config: {
      markerBucket: 'opt-solution-markers', stateBucket: 'state', region: 'us-east-1',
      solutionPrefix: 'opt-', mirrorPrefix: 'mirror-', specPolicyPrefix: 'cmp-',
      controlPlaneArns: [], resourcePolicyReview: true, accountId,
    },
    s3,
    store: { get: () => ({ plans: [{ account_id: ACCOUNT, resource: 'mirror-lambda-Test' }] }) },
    notifications: { recent: () => [], enabled: true },
    markerBodies: { put: () => {}, get: () => null },
    impacts: { get: () => null },
    actions: { all: () => ({ schema: 1, services: {}, error: null }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

const REVIEW = 'GET /api/buckets/:bucket/review';
const BUCKET = 'reporting-data';

test('the document reaches the page as the bytes S3 returned, not as a round trip', async () => {
  // Written so a round trip cannot reproduce it: keys out of alphabetical order, two-space indent,
  // and a trailing newline. If the route ever starts sending JSON.stringify(parsed) instead, every
  // one of those is silently rewritten and this fails.
  const text = '{\n  "Statement": [\n    {"Effect": "Allow", "Principal": "*", "Action": "s3:GetObject",'
    + ' "Resource": "arn:aws:s3:::reporting-data/*"}\n  ],\n  "Version": "2012-10-17"\n}\n';
  const body = await reviewRoute(text)[REVIEW]({ params: { bucket: BUCKET } });

  assert.equal(body.has_policy, true);
  assert.equal(body.error, null);
  assert.equal(body.document_text, text, 'the document was not passed through unchanged');
  assert.notEqual(body.document_text, JSON.stringify(body.policy, null, 2));
  // And the parsed form is there beside it, because that is what the reading was made from.
  assert.equal(body.policy.Version, '2012-10-17');
});

test('a policy that will not parse still arrives with its text, which is all there is of it', async () => {
  const text = '{"Version": "2012-10-17", "Statement": [ this is not json ]}';
  const body = await reviewRoute(text)[REVIEW]({ params: { bucket: BUCKET } });

  assert.equal(body.has_policy, true);
  assert.equal(body.policy, null);
  assert.ok(body.error, 'a policy that cannot be parsed must say so');
  assert.equal(body.document_text, text, (
    'the text was withheld on the one answer where the reading is empty, so the screen would report '
    + 'a problem with a document nobody can look at'
  ));
});

test('a bucket with no policy has no document, and that is not an empty one', async () => {
  const body = await reviewRoute(null)[REVIEW]({ params: { bucket: BUCKET } });

  assert.equal(body.has_policy, false);
  assert.equal(body.policy, null);
  assert.equal(body.document_text, null, 'no policy must not arrive looking like an empty document');
  assert.equal(body.error, null, 'a bucket with no policy is an answer, not a failure');
});

test('the review is refused outright when the switch is off', async () => {
  const route = routes({
    config: {
      markerBucket: 'opt-solution-markers', stateBucket: 'state', region: 'us-east-1',
      solutionPrefix: 'opt-', mirrorPrefix: 'mirror-', specPolicyPrefix: 'cmp-',
      controlPlaneArns: [], resourcePolicyReview: false, accountId: ACCOUNT,
    },
    s3: { async send() { throw new Error('the route must not reach S3 while it is off'); } },
    store: { get: () => ({ plans: [] }) },
    notifications: { recent: () => [], enabled: true },
    markerBodies: { put: () => {}, get: () => null },
    impacts: { get: () => null },
    actions: { all: () => ({ schema: 1, services: {}, error: null }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await assert.rejects(() => route[REVIEW]({ params: { bucket: BUCKET } }), /resource policy review is off/);
  await assert.rejects(() => route['GET /api/buckets']({}), /resource policy review is off/);
});


// ---- the decision survives a failing sweep, and the bound counts what it says it counts --------

test('a sweep that fails after the marker is written does not fail the decision', async () => {
  // The marker is already in S3 and the applier is already starting, so the decision HAPPENED.
  // Rethrowing the sweep error made this route answer 500, which reads as "the approval did not go
  // through" - the reviewer presses again, the second press hits an already-decided plan and comes
  // back 409, and two contradictory errors now describe an approval that succeeded.
  const { route, s3 } = harness({ refreshFails: true });
  const result = await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID }, body: decision(),
  });
  assert.ok(result.written, 'the decision did not answer with what it wrote');
  assert.ok(s3.puts.some((p) => p.key.startsWith('applier/')),
    'the marker was not written');
});

test('the restriction bound counts actions, not entries', async () => {
  // The message says "restricted actions" and one entry carries a list of them, so counting
  // entries let 200 x N through. The only thing left bounding the request was the writer's byte
  // check, which runs AFTER the approval - too late to say which list to shorten.
  const { route, impactSha256 } = harness();
  const entries = Array.from({ length: 3 }, (_, i) => ({
    policy: 'mirror-cmp-WebHosting',
    intent: 'deny_action',
    actions: Array.from({ length: 100 }, (_, j) => `s3:Action${i}x${j}`),
    resources: [],
  }));
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ restrictions: entries, expected_impact_sha256: impactSha256 }),
    }),
    (e) => e.status === 400 && /300/.test(e.message),
    'three entries carrying a hundred actions each passed a bound of two hundred actions');
});


// ---- confirming a PassRole grant, which is not approving the plan -------------------------------

const ASKED = {
  passrole_requested_by: { after: ['alice'] },
  passrole_services: { after: ['lambda.amazonaws.com'] },
};

test('the requests reach the page so an approver can see what is being asked', async () => {
  const { route } = harness({ planOutputs: ASKED });
  const detail = await route['GET /api/plans/:id']({ params: { id: PLAN_ID } });
  assert.deepEqual(detail.passrole, {
    requested_by: ['alice'], granted_to: [], untagged: [], unavailable: [],
    services: ['lambda.amazonaws.com'], target_arn: null,
  });
});

test('approving the plan grants nothing on its own', async () => {
  // The whole point of the second confirmation. An approval that carried the grant with it would
  // act on whatever tag happened to be on the source role when it was inspected.
  const { route, s3 } = harness({ planOutputs: ASKED });
  await route['POST /api/plans/:id/decision']({ params: { id: PLAN_ID }, body: decision() });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal('passrole_grant_to' in marker, false,
    'an approval with nobody ticked carried a grant');
});

test('a confirmed name travels as a name and nothing else', async () => {
  const { route, s3 } = harness({ planOutputs: ASKED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID }, body: decision({ passrole_grant_to: ['alice'] }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.passrole_grant_to, ['alice']);
  // What the grant SAYS is read by the applier from the plan. This tier never authors it.
  assert.equal(JSON.stringify(marker).includes('mirror_role_arn'), false);
  assert.equal(JSON.stringify(marker).includes('iam:PassRole'), false);
});

test('a name nobody asked for is refused, and the message says who did ask', async () => {
  const { route, s3 } = harness({ planOutputs: ASKED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID }, body: decision({ passrole_grant_to: ['root-admin'] }),
    }),
    (e) => e.status === 409 && /root-admin/.test(e.message) && /alice/.test(e.message));
  assert.equal(s3.puts.some((p) => p.key.startsWith('applier/')), false,
    'a marker was written despite the refusal');
});

test('a denial cannot confirm a grant', async () => {
  const { route } = harness({ planOutputs: ASKED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ decision: 'deny', comment: 'no', passrole_grant_to: ['alice'] }),
    }),
    (e) => e.status === 400 && /nothing is granted/.test(e.message));
});

test('a grant on a role no service can assume is refused before the apply, not after', async () => {
  // An unconditioned PassRole allows passing the role to anything, so the applier refuses it. That
  // refusal would land after the mirror role was already created; this one lands on the button.
  const { route } = harness({
    planOutputs: { ...ASKED, passrole_services: { after: [] } },
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID }, body: decision({ passrole_grant_to: ['alice'] }),
    }),
    (e) => e.status === 409 && /iam:PassedToService/.test(e.message));
});

test('a withdrawal is the only thing that takes a grant back', async () => {
  // Leaving somebody unticked removes nothing: the writer keeps every grant a dispatch does not
  // name. So the marker has to carry the withdrawal explicitly, and an ordinary approval must not
  // imply one - an approver who confirms bob has said nothing about alice.
  const { route, s3 } = harness({ planOutputs: ASKED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID }, body: decision({ passrole_revoke_from: ['alice'] }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.passrole_revoke_from, ['alice']);
  assert.equal('passrole_grant_to' in marker, false);
});

test('withdrawing from somebody who never asked is allowed, unlike granting', async () => {
  // The asymmetry is the point. The ordinary reason to withdraw is that the tag is gone, so the
  // person is no longer among the plan's requesters - requiring them to be would make the only
  // removal path unusable in exactly the case it exists for.
  const { route, s3 } = harness({ planOutputs: ASKED });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID }, body: decision({ passrole_revoke_from: ['carol'] }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.passrole_revoke_from, ['carol']);
});

test('a role no service can assume can still have its grants withdrawn', async () => {
  // Granting is refused there; withdrawing must not be. A role whose trust policy lost its services
  // is exactly the one whose grants should come off.
  const { route, s3 } = harness({
    planOutputs: { ...ASKED, passrole_services: { after: [] } },
  });
  await route['POST /api/plans/:id/decision']({
    params: { id: PLAN_ID }, body: decision({ passrole_revoke_from: ['alice'] }),
  });
  assert.ok(s3.puts.some((p) => p.key.startsWith('applier/')));
});

test('confirming and withdrawing the same person in one decision is refused', async () => {
  const { route } = harness({ planOutputs: ASKED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ passrole_grant_to: ['alice'], passrole_revoke_from: ['alice'] }),
    }),
    (e) => e.status === 400 && /alice/.test(e.message));
});

test('a denial cannot withdraw either, because nothing runs to write it', async () => {
  const { route } = harness({ planOutputs: ASKED });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ decision: 'deny', comment: 'no', passrole_revoke_from: ['alice'] }),
    }),
    (e) => e.status === 400 && /not applied/.test(e.message));
});

test('withdrawals of another shape are refused', async () => {
  for (const broken of ['alice', [''], [null], [{ user_name: 'alice' }]]) {
    const { route } = harness({ planOutputs: ASKED });
    await assert.rejects(
      () => route['POST /api/plans/:id/decision']({
        params: { id: PLAN_ID }, body: decision({ passrole_revoke_from: broken }),
      }),
      (e) => e.status === 400, `accepted passrole_revoke_from=${JSON.stringify(broken)}`);
  }
});


test('confirmations of another shape are refused', async () => {
  for (const broken of ['alice', [''], [null], [{ user_name: 'alice' }]]) {
    const { route } = harness({ planOutputs: ASKED });
    await assert.rejects(
      () => route['POST /api/plans/:id/decision']({
        params: { id: PLAN_ID }, body: decision({ passrole_grant_to: broken }),
      }),
      (e) => e.status === 400, `accepted passrole_grant_to=${JSON.stringify(broken)}`);
  }
});


test('an assessment survives an inspection that moves no resource', async () => {
  // The passrole tag case. Tagging a <service>-* role starts an inspection whose plan moves no IAM
  // resource, so its request id is new and the stored assessment - of a permission set that has not
  // changed - was dropped. A governed resource that had been assessed and applied read as
  // unassessed, and the answer to "what does this reach" became silence.
  const { route } = harness({
    assessment: { ...ASSESSMENT, request_id: `${ACCOUNT}-0000000000000000` },
    planOutputs: ASKED,
    noChanges: true,
  });
  const detail = await route['GET /api/plans/:id']({ params: { id: PLAN_ID } });
  assert.ok(detail.assessment, 'the earlier assessment was dropped');
  assert.equal(detail.assessment_source, 'earlier');
  // And carried WITHOUT a digest, which is the whole safety of it: a restriction is validated
  // against the assessment the approver read, and this one belongs to another inspection.
  assert.equal(detail.assessment_sha256, null);
});

test('an assessment from another inspection is still dropped when the plan changes something', async () => {
  // The rule this does not weaken. A plan that MOVES a resource produces a permission set the old
  // assessment does not describe, and showing it beside a fresh plan.txt is the mismatch the
  // digests exist to prevent.
  const { route } = harness({
    assessment: { ...ASSESSMENT, request_id: `${ACCOUNT}-0000000000000000` },
  });
  const detail = await route['GET /api/plans/:id']({ params: { id: PLAN_ID } });
  assert.equal(detail.assessment, null);
  assert.equal(detail.assessment_source, null);
});

test('a restriction cannot be composed from an earlier assessment', async () => {
  // It has no digest, so the page sends none, and the decision route refuses a restriction without
  // one. Checked here because the display change must not have opened a path around that.
  const { route } = harness({
    assessment: { ...ASSESSMENT, request_id: `${ACCOUNT}-0000000000000000` },
    planOutputs: ASKED,
    noChanges: true,
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ restrictions: [restriction] }),
    }),
    (e) => e.status === 400 || e.status === 409);
});


test('the analysis runs on an assessment kept because the plan moves nothing', async () => {
  // The regression this exists for. The detail route was taught to keep an earlier assessment for a
  // plan that changes no resource; the analysis route was not, so a tagged role showed its
  // assessment and then refused to analyse it:
  //   "the stored assessment describes <id> and this plan is <id>; reload the plan"
  const { route } = harness({
    assessment: { ...ASSESSMENT, request_id: `${ACCOUNT}-0000000000000000` },
    planOutputs: ASKED,
    noChanges: true,
  });
  const answer = await route['POST /api/plans/:id/analysis']({
    params: { id: PLAN_ID }, body: { engine: 'rules' },
  });
  assert.ok(answer, 'the analysis refused an assessment the detail route had just displayed');
});

test('the analysis still refuses an assessment for a plan that changes something', async () => {
  const { route } = harness({
    assessment: { ...ASSESSMENT, request_id: `${ACCOUNT}-0000000000000000` },
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/analysis']({
      params: { id: PLAN_ID }, body: { engine: 'rules' },
    }),
    (e) => e.status === 409 && /reload the plan/.test(e.message));
});

test('an analysis of an earlier assessment cannot be cited on the decision', async () => {
  // It names the digest of the assessment it actually read, and the page only sends a citation when
  // that equals the digest the DECISION carries - which for an earlier assessment is null. So the
  // two never match and nothing is cited. Checked here because the fix above must not have opened a
  // way to bind an approval to an assessment it was not made from.
  const { route } = harness({
    assessment: { ...ASSESSMENT, request_id: `${ACCOUNT}-0000000000000000` },
    planOutputs: ASKED,
    noChanges: true,
  });
  const detail = await route['GET /api/plans/:id']({ params: { id: PLAN_ID } });
  const answer = await route['POST /api/plans/:id/analysis']({
    params: { id: PLAN_ID }, body: { engine: 'rules' },
  });
  assert.equal(detail.assessment_sha256, null);
  assert.notEqual(answer.impact_sha256, null,
    'the analysis named no assessment, so the page would send a citation the decision refuses');
});

// ---- sending the work orders again -------------------------------------------------------------
//
// A retry is not a decision. Which role, which services, and whether the act is a grant or a
// withdrawal were all settled when the plan was approved; this route authors a list of NAMES, and
// every one has to be a name the inline writer actually failed on.
//
// The narrowness is the point. A retry overwrites the writer's LOCK - the one object in the system
// that says an execution of a permission set is outstanding - so the applier reads the writer's own
// record before taking one, and this route refuses any name that record does not mark retryable.
// Two checks over the same fact, because this tier is the one that is not trusted and the object it
// writes starts a container.

const RETRY_LOCK = (user) => `inline_writer/${ACCOUNT}:${ACCOUNT}-${user}.json`;
const RETRY_RESULT = (user) => `inline_result/${ACCOUNT}:${ACCOUNT}-${user}.json`;
const DISPATCHED = (user, action = 'grant') => ({
  user_name: user, action, permission_set: `${ACCOUNT}-${user}`, key: RETRY_LOCK(user),
  retry: false,
});

/** A plan that was applied, dispatching alice (which failed) and bob (which landed). */
function applied({ dispatch = [DISPATCHED('alice'), DISPATCHED('bob')], results = {},
                   locks = [RETRY_LOCK('alice')] } = {}) {
  const markers = {};
  for (const [user, body] of Object.entries({
    alice: { state: 'failed', ok: false, reason: 'terraform apply failed: exit 1' },
    bob: { state: 'written', ok: true, reason: '' },
    ...results,
  })) markers[RETRY_RESULT(user)] = JSON.stringify(body);
  for (const key of locks) markers[key] = JSON.stringify({ request_id: REQUEST });
  return harness({
    outcome: {
      schema: 1, request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice',
      decision: 'approve', reviewer: 'kim', applied: true, detail: 'Apply complete!',
      inline_state: 'dispatched', passrole_dispatch: dispatch, retries: [],
    },
    markers,
  });
}

const retry = (extra = {}) => ({ users: ['alice'], reviewer: 'someone', ...extra });

test('a retry names the failed target and nothing about the grant itself', async () => {
  const { route, s3 } = applied();
  const answer = await route['POST /api/plans/:id/passrole-retry']({
    params: { id: PLAN_ID }, body: retry(),
  });
  assert.ok(answer.written);

  const put = s3.puts.find((p) => p.key.startsWith('applier/'));
  const marker = JSON.parse(put.body);
  assert.equal(marker.passrole_retry, true);
  assert.equal(marker.retry_of, REQUEST, 'the retry does not say which decision it re-dispatches');
  assert.deepEqual(marker.passrole_grant_to, ['alice']);
  assert.equal('restrictions' in marker, false, 'a retry carrying a restriction is refused by the '
               + 'applier - the retry path applies nothing and writes no fence');
  assert.equal(marker.decision, 'approve');
});

test('a retry gets its own request id, so two of them are two objects', async () => {
  const { route, s3 } = applied();
  await route['POST /api/plans/:id/passrole-retry']({ params: { id: PLAN_ID }, body: retry() });
  await route['POST /api/plans/:id/passrole-retry']({ params: { id: PLAN_ID }, body: retry() });

  const keys = s3.puts.filter((p) => p.key.startsWith('applier/')).map((p) => p.key);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1],
                  'the second retry replaced the first, whose work order somebody is waiting on');
  for (const key of keys) {
    assert.match(key, /^applier\/\d{12}-[0-9a-f]{16}\.json$/);
    assert.notEqual(key, `applier/${REQUEST}.json`,
                    'a retry named after the decision it retries collides with the decision');
  }
});

test('a retry repeats the act it is retrying and never the opposite one', async () => {
  const { route, s3 } = applied({
    dispatch: [DISPATCHED('alice', 'revoke')],
    results: { alice: { state: 'failed', ok: false, reason: 'AccessDenied' } },
  });
  await route['POST /api/plans/:id/passrole-retry']({ params: { id: PLAN_ID }, body: retry() });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.passrole_revoke_from, ['alice']);
  assert.equal('passrole_grant_to' in marker, false,
               'a failed withdrawal was retried as a grant, putting back what somebody removed');
});

test('a writer that finished cannot be retried', async () => {
  const { route } = applied();
  await assert.rejects(
    () => route['POST /api/plans/:id/passrole-retry']({
      params: { id: PLAN_ID }, body: retry({ users: ['bob'] }),
    }),
    (err) => err.status === 409 && /이미 부여가 적용되어 있다/.test(err.message),
  );
});

test('a lock with no result cannot be retried, and the message says why', async () => {
  // The case the gate exists for: a run still going and a task killed before it ran any code leave
  // the identical object. Taking that lock would put a second work order under a live apply.
  const { route } = applied({
    dispatch: [DISPATCHED('carol')], results: {}, locks: [RETRY_LOCK('carol')],
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/passrole-retry']({
      params: { id: PLAN_ID }, body: retry({ users: ['carol'] }),
    }),
    (err) => err.status === 409 && /결과를 남기지 않았다/.test(err.message),
  );
});

test('a retry cannot name somebody this decision never dispatched', async () => {
  // Otherwise the route would be a way to grant PassRole to anyone, with no plan and no approval
  // behind it - the applier would refuse it, but only after a marker had started a container.
  const { route } = applied();
  await assert.rejects(
    () => route['POST /api/plans/:id/passrole-retry']({
      params: { id: PLAN_ID }, body: retry({ users: ['mallory'] }),
    }),
    (err) => err.status === 409 && /발송한 대상이 아니다/.test(err.message),
  );
});

test('a retry needs a name and at least one target', async () => {
  const { route } = applied();
  for (const [body, why] of [
    [retry({ reviewer: '' }), 'reviewer'],
    [retry({ users: [] }), 'no target'],
    [retry({ users: ['  '] }), 'blank name'],
    [retry({ users: 'alice' }), 'not an array'],
  ]) {
    await assert.rejects(
      () => route['POST /api/plans/:id/passrole-retry']({ params: { id: PLAN_ID }, body }),
      (err) => err.status === 400, why,
    );
  }
});

test('a plan with no recorded outcome has no work orders to send again', async () => {
  const { route } = harness({});
  await assert.rejects(
    () => route['POST /api/plans/:id/passrole-retry']({ params: { id: PLAN_ID }, body: retry() }),
    (err) => err.status === 409 && /no recorded outcome/.test(err.message),
  );
});

test('a decision that was not applied has nothing to send', async () => {
  const { route } = harness({
    outcome: {
      schema: 1, request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice',
      decision: 'deny', reviewer: 'kim', applied: false, detail: 'denied',
      passrole_dispatch: [], retries: [],
    },
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/passrole-retry']({ params: { id: PLAN_ID }, body: retry() }),
    (err) => err.status === 409 && /closed without applying/.test(err.message),
  );
});

test('a retry that is written survives a sweep that is not', async () => {
  // Same reasoning as the decision route. The marker is in S3 and the applier is starting, so a
  // rethrown sweep error would answer 500 for a retry that actually happened - and the person
  // presses again, taking a lock over twice.
  const base = applied();
  const { route, s3 } = harness({
    refreshFails: true,
    outcome: {
      schema: 1, request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice',
      decision: 'approve', reviewer: 'kim', applied: true, detail: 'Apply complete!',
      inline_state: 'dispatched', passrole_dispatch: [DISPATCHED('alice')], retries: [],
    },
    markers: {
      [RETRY_RESULT('alice')]: JSON.stringify({ state: 'failed', ok: false, reason: 'x' }),
      [RETRY_LOCK('alice')]: JSON.stringify({ request_id: REQUEST }),
    },
  });
  assert.ok(base);
  const answer = await route['POST /api/plans/:id/passrole-retry']({
    params: { id: PLAN_ID }, body: retry(),
  });
  assert.ok(answer.written);
  assert.ok(s3.puts.some((p) => p.key.startsWith('applier/')));
});

test('the page renders the writer verification and offers retry only where the server would', () => {
  // Structural, because the runner cannot load the .tsx - and because every test above proves the
  // SERVER refuses a name the writer did not fail on, while saying nothing about whether the page
  // ever shows a person that a grant was not written. That is the gap this whole panel exists to
  // close, and it would close silently if the component stopped rendering.
  const detail = readFileSync(
    new URL('../src/components/PlanDetail.tsx', import.meta.url), 'utf8',
  );
  assert.match(detail, /<PassroleWriters/,
               'the writer verification is no longer rendered, so a dispatched grant that was '
               + 'never written reads as applied again');
  assert.match(detail, /writers=\{detail\.passrole_writers \?\? \[\]\}/,
               'the panel is fed something other than the server\'s verification');
  // The button is offered on w.retryable and nothing else. Offering it on "not ok" would put it on
  // rows where the applier refuses to take the lock - a run still going, or one that recorded
  // nothing - and every press would come back 409.
  assert.match(detail, /\{w\.retryable\s*\n?\s*\?/,
               'retry is offered on something other than retryable');

  const page = readFileSync(new URL('../src/components/PlanPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /onRetryPassrole=\{retryPassrole\}/, 'the retry handler is not wired up');
  assert.match(page, /api\.retryPassrole\(/, 'the handler does not call the retry route');
});

test('the page shows an ask it cannot offer, and opens a way to reach it', () => {
  // Structural, because the runner cannot load the .tsx - and because every server test above
  // proves the DATA now reaches the page while saying nothing about whether anything draws it.
  // That gap is the whole bug: the inspector recorded passrole_unavailable from the start and no
  // component read it, so a tagged role produced an empty screen.
  const detail = readFileSync(
    new URL('../src/components/PlanDetail.tsx', import.meta.url), 'utf8',
  );
  assert.match(detail, /const unavailable = detail\.passrole\?\.unavailable \?\? \[\]/,
               'the panel no longer reads the ungrantable asks');
  // The panel must not bail out when the ONLY thing on the role is an ungrantable ask - that is
  // exactly the case that showed nothing.
  assert.match(
    detail,
    /requests\.length === 0 && withdrawnTags\.length === 0 && unavailable\.length === 0/,
    'the panel returns null on a role carrying only ungrantable asks, which is the reported bug',
  );
  assert.match(detail, /unavailable\.map\(\(entry\)/, 'the reasons are not rendered');
  // And the tab that reaches the panel opens for them too.
  assert.match(detail, /\|\| \(detail\.passrole\?\.unavailable \?\? \[\]\)\.length > 0/,
               'the PassRole tab is still gated on requested_by alone, so the panel is unreachable');

  const list = readFileSync(new URL('../src/components/PlanList.tsx', import.meta.url), 'utf8');
  assert.match(list, /it\.passrole_unavailable > 0 &&/,
               'the row carries no badge for an ungrantable ask, so the plan looks unasked-about');
});

// ---- taking a grant back with no plan decision behind it ---------------------------------------
//
// The gap: granting rides on approving a plan, and once that plan is applied there is no second
// decision to make. The decision route refuses one on a plan that has an outcome, and a plan whose
// twin already matches carries no changes to approve - so passrole_revoke_from, the only field that
// removes a grant, could not be sent at all. A grant held by somebody whose tag went in an earlier
// inspection stood until the permission set was edited by hand.
//
// A path with no plan behind it is defensible here and only here, because withdrawal is the safe
// direction: it removes access and can add none.

const HELD = {
  passrole_requested_by: { actions: ['create'], after: [] },
  passrole_granted_to: { actions: ['create'], after: ['Taeyoung', 'TestUser'] },
  passrole_services: { actions: ['create'], after: ['lambda.amazonaws.com'] },
  passrole_target_arn: { actions: ['create'], after: `arn:aws:iam::${ACCOUNT}:role/mirror-ps-alice` },
};

const revocation = (extra = {}) => ({ users: ['Taeyoung'], reviewer: 'someone', ...extra });

test('a grant can be taken back on a plan that was already applied', async () => {
  // The whole point. This is the state in which every other path is shut.
  const { route, s3 } = harness({
    planOutputs: HELD,
    outcome: {
      schema: 1, request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice',
      decision: 'approve', reviewer: 'kim', applied: true, detail: 'Apply complete!',
    },
  });
  const answer = await route['POST /api/plans/:id/passrole-revoke']({
    params: { id: PLAN_ID }, body: revocation(),
  });
  assert.ok(answer.written);

  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.equal(marker.passrole_revoke, true);
  assert.deepEqual(marker.passrole_revoke_from, ['Taeyoung']);
  assert.equal('passrole_grant_to' in marker, false, 'a withdrawal must not carry a grant');
  assert.equal('restrictions' in marker, false);
  assert.equal('passrole_retry' in marker, false, 'a withdrawal is not a retry');
});

test('the same plan cannot be decided again, which is why this route exists', async () => {
  // Pinned so the two stay in step. If the decision route ever stopped refusing, this route would
  // be a second way to do the same thing rather than the only way to do this one.
  const { route } = harness({
    planOutputs: HELD,
    outcome: {
      schema: 1, request_id: REQUEST, account_id: ACCOUNT, resource: 'ps-alice',
      decision: 'approve', reviewer: 'kim', applied: true, detail: 'Apply complete!',
    },
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/decision']({
      params: { id: PLAN_ID },
      body: decision({ passrole_revoke_from: ['Taeyoung'] }),
    }),
    (err) => err.status === 409 && /already applied/.test(err.message),
  );
});

test('only somebody the plan records as holding the grant can be revoked', async () => {
  // The list is a container's reading of the mirror role's own tags, not something this tier
  // authored - the same rule the grant path follows against passrole_requested_by.
  const { route } = harness({ planOutputs: HELD });
  await assert.rejects(
    () => route['POST /api/plans/:id/passrole-revoke']({
      params: { id: PLAN_ID }, body: revocation({ users: ['mallory'] }),
    }),
    (err) => err.status === 409 && /가지고 있지 않습니다/.test(err.message),
  );
});

test('a role that does not exist yet has no statement to remove', async () => {
  const { route } = harness({
    planOutputs: {
      ...HELD,
      // The ordinary shape for a plan that CREATES the role: terraform cannot say the ARN yet.
      passrole_target_arn: { actions: ['create'], after: null, after_unknown: true },
    },
  });
  await assert.rejects(
    () => route['POST /api/plans/:id/passrole-revoke']({
      params: { id: PLAN_ID }, body: revocation(),
    }),
    (err) => err.status === 409 && /미러 역할이 아직 만들어지지 않았습니다/.test(err.message),
  );
});

test('a withdrawal needs a name and at least one target', async () => {
  const { route } = harness({ planOutputs: HELD });
  for (const [body, why] of [
    [revocation({ reviewer: '' }), 'reviewer'],
    [revocation({ users: [] }), 'no target'],
    [revocation({ users: ['  '] }), 'blank name'],
    [revocation({ users: 'Taeyoung' }), 'not an array'],
  ]) {
    await assert.rejects(
      () => route['POST /api/plans/:id/passrole-revoke']({ params: { id: PLAN_ID }, body }),
      (err) => err.status === 400, why,
    );
  }
});

test('several holders can be taken back in one act', async () => {
  const { route, s3 } = harness({ planOutputs: HELD });
  await route['POST /api/plans/:id/passrole-revoke']({
    params: { id: PLAN_ID }, body: revocation({ users: ['TestUser', 'Taeyoung', 'Taeyoung'] }),
  });
  const marker = JSON.parse(s3.puts.find((p) => p.key.startsWith('applier/')).body);
  assert.deepEqual(marker.passrole_revoke_from, ['Taeyoung', 'TestUser'], 'sorted and deduplicated');
});

test('the page offers the holders and a way to reach them', () => {
  // Structural, because the runner cannot load the .tsx. The server tests above prove the ROUTE
  // works and say nothing about whether anything on screen can call it - and the holder whose tag
  // went long ago is in no request list, so nothing pointed at the panel.
  const detail = readFileSync(
    new URL('../src/components/PlanDetail.tsx', import.meta.url), 'utf8',
  );
  assert.match(detail, /<PassroleHolders/, 'the holders panel is not rendered');
  assert.match(detail, /const holders = detail\.passrole\?\.granted_to \?\? \[\]/,
               'the panel reads the holders from somewhere other than the plan');
  assert.match(detail, /\|\| \(detail\.passrole\?\.granted_to \?\? \[\]\)\.length > 0/,
               'the PassRole tab does not open for a role that only has holders');

  const list = readFileSync(new URL('../src/components/PlanList.tsx', import.meta.url), 'utf8');
  assert.match(list, /it\.passrole_granted > 0 &&/,
               'the row carries no badge for a held grant, so the revoke screen has no way in');

  const page = readFileSync(new URL('../src/components/PlanPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /api\.revokePassrole\(/, 'the handler does not call the revoke route');
});

// ---- a container that stopped badly -------------------------------------------------------------
//
// The marker that outlived the task is already visible. What the notifier adds is the REASON, which
// exists in the ECS task state change event and nowhere the dashboard can reach: a plan lock timeout
// and a task killed before it ran a line leave the same object in the same bucket.
//
// And the retry. Re-putting the object that started a task is the only way to run it again without
// ecs:RunTask - which is the whole reason it is acceptable here, because RunTask carries container
// overrides and this does not: it starts a fixed task definition with the overrides its own rule
// composes.

const FAILURE = {
  schema: 1,
  task_arn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task/opt-solution-cluster/abc123`,
  task_definition_arn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/opt-inspector:41`,
  stop_code: 'EssentialContainerExited',
  stopped_reason: 'Essential container in task exited',
  stopped_at: '2026-08-31T10:00:00Z',
  exit_codes: [1],
  marker_bucket: 'opt-solution-markers',
  marker_key: `inspector/${REQUEST}.json`,
};

function failureHarness({ marker = 'the listener wrote this' } = {}) {
  const { route, s3 } = harness({
    markers: marker === null ? {} : { [`inspector/${REQUEST}.json`]: marker },
  });
  return { route, s3 };
}

test('a report is recorded and says whether it can be retried', async () => {
  const { route } = failureHarness();
  const answer = await route['POST /api/task-failures']({ body: FAILURE });
  assert.equal(answer.retryable, true);
  assert.equal(answer.attempts, 1);
  const { failures } = await route['GET /api/task-failures']({});
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stop_code, 'EssentialContainerExited');
  assert.equal(failures[0].stopped_reason, 'Essential container in task exited');
});

test('a report about a task nobody started from an object is kept and not retryable', async () => {
  const { route } = failureHarness();
  const answer = await route['POST /api/task-failures']({
    body: { ...FAILURE, marker_bucket: null, marker_key: null },
  });
  assert.equal(answer.retryable, false, 'there is nothing to re-put');
  const { failures } = await route['GET /api/task-failures']({});
  assert.equal(failures.length, 1, 'and it is still worth showing');
});

test('a report that is not one is refused with 400 rather than rendered', async () => {
  const { route } = failureHarness();
  await assert.rejects(() => route['POST /api/task-failures']({ body: { nothing: true } }),
                       (err) => err.status === 400);
});

test('the retry re-puts the object it read, byte for byte', async () => {
  // Read and written back, never composed. What restarts the task is the write event and not the
  // contents, so this tier has no reason to author bytes a container will act on - and every reason
  // not to: the applier checks an approval came from here, and that can only keep meaning something
  // while this route cannot invent one.
  const { route, s3 } = failureHarness({ marker: 'the listener wrote this' });
  await route['POST /api/task-failures']({ body: FAILURE });
  const answer = await route['POST /api/task-failures/retry']({
    body: { id: FAILURE.marker_key, reviewer: 'kim' },
  });
  assert.equal(answer.key, `inspector/${REQUEST}.json`);
  const put = s3.puts.at(-1);
  assert.equal(put.key, `inspector/${REQUEST}.json`);
  assert.equal(put.body.toString(), 'the listener wrote this');
});

test('the retry says who pressed it, so it is not pressed twice', async () => {
  const { route } = failureHarness();
  await route['POST /api/task-failures']({ body: FAILURE });
  await route['POST /api/task-failures/retry']({ body: { id: FAILURE.marker_key, reviewer: 'kim' } });
  const { failures } = await route['GET /api/task-failures']({});
  assert.equal(failures[0].retried_by, 'kim');
  assert.ok(failures[0].retried_at);
});

test('a retry naming nothing this dashboard was told about is 404', async () => {
  const { route } = failureHarness();
  await assert.rejects(
    () => route['POST /api/task-failures/retry']({ body: { id: 'inspector/nope.json', reviewer: 'kim' } }),
    (err) => err.status === 404,
  );
});

test('a retry of an object that is already gone says so rather than failing', async () => {
  // A container that finished deletes its own object. Somebody pressing retry on a row that has
  // since resolved gets a sentence, not a stack trace.
  const { route } = failureHarness({ marker: null });
  await route['POST /api/task-failures']({ body: FAILURE });
  await assert.rejects(
    () => route['POST /api/task-failures/retry']({ body: { id: FAILURE.marker_key, reviewer: 'kim' } }),
    (err) => err.status === 409 && /already have been dealt with/.test(err.message),
  );
});

test('the retry needs a name, and it is recorded', async () => {
  const { route } = failureHarness();
  await route['POST /api/task-failures']({ body: FAILURE });
  await assert.rejects(
    () => route['POST /api/task-failures/retry']({ body: { id: FAILURE.marker_key } }),
    (err) => err.status === 400,
  );
});

test('a report naming a plan artifact cannot be retried, whatever it says', async () => {
  // The fence, reached through the route rather than the unit. tfplan is what an approval binds to.
  const { route } = failureHarness();
  const key = `${ACCOUNT}/ps-alice/plan/tfplan`;
  await route['POST /api/task-failures']({
    body: { ...FAILURE, marker_bucket: 'state', marker_key: key },
  });
  await assert.rejects(
    () => route['POST /api/task-failures/retry']({ body: { id: key, reviewer: 'kim' } }),
    (err) => err.status === 409,
  );
});

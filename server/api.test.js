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
    services: { sqs: { DeleteMessage: ['Write', ['queue']], ListQueues: ['Read', []] } },
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

function harness({ pushed = null, riskAnalysis = false, assessment = null,
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
    [`${PREFIX}plan.json`]: JSON.stringify({ resource_changes: [{ change: { actions: ['update'] } }] }),
    [`${PREFIX}impact.json`]: document,
    [`${PREFIX}impact.sha256`]: sha,
  });
  const route = routes({
    config: {
      markerBucket: 'opt-solution-markers', stateBucket: 'state',
      applierPrefix: 'applier/', planSuffix: 'plan/', release: 'test',
      region: 'us-east-1',
      // What this deployment's own resources are called, for the risk analysis. Defaults here
      // rather than undefined so controlPlane() is exercised the way it runs.
      approvalTable: 'opt-approval-store', lockTable: 'opt-tf-state-lock',
      inlineStateBucket: 'opt-inlinepolicy-terraform', eventQueue: 'opt-iam-event-queue',
      cluster: 'opt-solution-cluster', solutionPrefix: 'opt-', mirrorPrefix: 'mirror-',
      specPolicyPrefix: 'cmp-', controlPlaneArns: [],
      riskAnalysis, bedrockModelId: 'us.anthropic.claude-sonnet-5',
      riskAnalysisMaxTokens: 16000, riskAnalysisBatch: 10,
    },
    makeModelClient,
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

/** A model that answers every candidate it is given, citing the actions it was given. */
function modelStub(over = {}) {
  const calls = [];
  return {
    calls,
    make: async () => ({
      messages: {
        async create(body) {
          calls.push(body);
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
                narrative: '코드를 교체한 뒤 호출하면 부착된 역할로 실행된다.',
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

test('with the analysis on, the model judges the candidates the code proposed', async () => {
  const model = modelStub();
  const { route, impactSha256 } = harness({
    assessment: ANALYSABLE, riskAnalysis: true, makeModelClient: model.make,
  });
  const answer = await route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} });
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
  const answer = await route['POST /api/plans/:id/analysis']({ params: { id: PLAN_ID }, body: {} });
  assert.ok(answer.rule_findings.length > 0);
  assert.equal(answer.analysis, null);
  assert.match(answer.analysis_error, /AccessDenied/);
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
  model_id: 'us.anthropic.claude-sonnet-5',
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
    model_id: 'us.anthropic.claude-sonnet-5',
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

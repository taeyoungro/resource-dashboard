// The parts of the sweep that turn bucket contents into what the page shows.
//
// No AWS. These are the pure functions plus one end-to-end sweep against a fake client, which is
// where the interesting behaviour lives: a young marker is a running task and not a failure, a
// plan with an approval beside it is decided, and a body that will not read still counts.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeMarkerBodies } from './markerBodies.js';
import {
  changesFromPlan, identityFromConfig, isDigest, passroleFromPlan, planIdFromKey,
  requestersFromConfig,
  planPrefixFromId, readPlan,
  requestIdFromMarkerKey, sweep, writerVerification,
} from './sweep.js';

const CONFIG = {
  region: 'us-east-1',
  markerBucket: 'opt-solution-markers',
  stateBucket: 'opt-org-policy-terraform-state',
  inspectorPrefix: 'inspector/',
  applierPrefix: 'applier/',
  impactPrefix: 'impact/',
  inlineWriterPrefix: 'inline_writer/',
  planSuffix: 'plan/',
  markerGraceSeconds: 900,
  maxBodiesPerSweep: 200,
};

const NOW = Date.parse('2026-08-03T12:00:00Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

function fakeS3(objects, bodies = {}) {
  const gets = [];
  return {
    gets,
    async send(command) {
      const input = command.input;
      if (command.constructor.name === 'ListObjectsV2Command') {
        const contents = (objects[input.Bucket] ?? [])
          .filter((o) => o.key.startsWith(input.Prefix))
          .map((o) => ({
            Key: o.key,
            Size: o.size ?? 100,
            LastModified: new Date(o.lastModified),
            ETag: `"${o.etag ?? 'abc'}"`,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      if (command.constructor.name === 'GetObjectCommand') {
        // Recorded so a test can assert that a body already held was not fetched again.
        gets.push(input.Key);
        const body = bodies[`${input.Bucket}/${input.Key}`];
        if (body === undefined) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        return { Body: { transformToByteArray: async () => bytes } };
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
}

const MAIN_TF = {
  terraform: {
    backend: { s3: { bucket: 'opt-org-policy-terraform-state',
                     key: '644701781058/cmp-WebHosting/terraform.tfstate' } },
  },
};

const BUCKET = 'opt-org-policy-terraform-state';

/** The six artifacts the inspector writes, as a listing and a body map.
 *
 * Keyed by <account>/<resource>/plan/, which is the whole point: two edits to one resource are one
 * prefix, not two. Every test that used to spell out plans/<request id>/ was spelling out the bug.
 */
function planFixture(account, resource,
                     { at, requestId, hasChanges = true, digest, outcome, requestedBy } = {}) {
  const prefix = `${account}/${resource}/plan/`;
  const names = ['tfplan', 'main.tf.json', 'plan.json', 'plan.txt', 'changes.sha256',
                 'request.json'];
  if (outcome) names.push('outcome.json');
  const objects = names.map((n) => ({ key: `${prefix}${n}`, lastModified: at }));
  const bodies = {
    [`${BUCKET}/${prefix}main.tf.json`]: {
      terraform: { backend: { s3: { bucket: BUCKET,
                                    key: `${account}/${resource}/terraform.tfstate` } } },
      ...(requestedBy ? { output: { passrole_requested_by: { value: requestedBy } } } : {}),
    },
    [`${BUCKET}/${prefix}tfplan`]: 'binary plan',
    [`${BUCKET}/${prefix}plan.txt`]: 'terraform will do things',
    [`${BUCKET}/${prefix}plan.json`]: { resource_changes: [] },
    [`${BUCKET}/${prefix}changes.sha256`]: `${digest ?? 'd'.repeat(64)}\n`,
    [`${BUCKET}/${prefix}request.json`]: {
      schema: 1, request_id: requestId, account_id: account, resource, has_changes: hasChanges,
      planned_at: at,
    },
  };
  if (outcome) {
    bodies[`${BUCKET}/${prefix}outcome.json`] = {
      schema: 1, request_id: requestId, account_id: account, resource,
      decision: 'approve', reviewer: 'kim', comment: '', applied: true,
      detail: 'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.',
      finished_at: at, ...outcome,
    };
  }
  return { objects, bodies, prefix };
}

test('the account and resource come from the backend key, not the request id', () => {
  assert.deepEqual(identityFromConfig(MAIN_TF),
                   { accountId: '644701781058', resource: 'cmp-WebHosting' });
});

test('a configuration without a usable backend key yields nulls rather than throwing', () => {
  for (const bad of [null, {}, { terraform: {} }, { terraform: { backend: { s3: { key: 'x' } } } }]) {
    assert.deepEqual(identityFromConfig(bad), { accountId: null, resource: null });
  }
});

test('no-op changes are not changes', () => {
  const changes = changesFromPlan({
    resource_changes: [
      { address: 'aws_iam_policy.twin', type: 'aws_iam_policy', name: 'twin',
        change: { actions: ['create'] } },
      { address: 'aws_iam_policy.other', type: 'aws_iam_policy', name: 'other',
        change: { actions: ['no-op'] } },
    ],
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].address, 'aws_iam_policy.twin');
});

test('a young marker is a running task, not a failure', async () => {
  const s3 = fakeS3(
    { 'opt-solution-markers': [
      { key: 'inspector/644701781058-aaaaaaaaaaaaaaaa.json', lastModified: ago(60) },
      { key: 'inspector/644701781058-bbbbbbbbbbbbbbbb.json', lastModified: ago(7200) },
    ] },
    { 'opt-solution-markers/inspector/644701781058-aaaaaaaaaaaaaaaa.json':
        { account_id: '644701781058', resource: 'cmp-A', kind: 'spec_policy' },
      'opt-solution-markers/inspector/644701781058-bbbbbbbbbbbbbbbb.json':
        { account_id: '644701781058', resource: 'cmp-B', kind: 'spec_policy' } },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.counts.running, 1);
  assert.equal(state.counts.failed, 1);
  assert.equal(state.markers.find((m) => m.resource === 'cmp-A').state, 'running');
  assert.equal(state.markers.find((m) => m.resource === 'cmp-B').state, 'failed');
});

test('a marker whose body will not read is still reported, and the failure is recorded', async () => {
  const s3 = fakeS3({ 'opt-solution-markers': [
    { key: 'inspector/644701781058-cccccccccccccccc.json', lastModified: ago(7200) },
  ] });
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.markers.length, 1);
  assert.equal(state.markers[0].state, 'failed');
  assert.equal(state.markers[0].body_read, false);
  assert.equal(state.markers[0].resource, null);
  assert.equal(state.errors.length, 1, 'a body that would not read has to be reported');
});

test('a plan with an approval beside it is decided, one without is awaiting a decision', async () => {
  const a = planFixture('644701781058', 'cmp-WebHosting',
                        { at: ago(600), requestId: '644701781058-1111111111111111' });
  const b = planFixture('644701781058', 'cmp-Other',
                        { at: ago(300), requestId: '644701781058-2222222222222222' });
  const s3 = fakeS3(
    { 'opt-solution-markers': [
        { key: 'applier/644701781058-1111111111111111.json', lastModified: ago(30) },
      ],
      [BUCKET]: [...a.objects, ...b.objects] },
    { 'opt-solution-markers/applier/644701781058-1111111111111111.json':
        { request_id: '644701781058-1111111111111111', decision: 'approve', reviewer: 'kim' },
      ...a.bodies, ...b.bodies },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  const byId = Object.fromEntries(state.plans.map((p) => [p.plan_id, p]));
  assert.equal(byId['644701781058:cmp-WebHosting'].state, 'decided');
  assert.equal(byId['644701781058:cmp-Other'].state, 'awaiting_decision');
  assert.equal(state.counts.awaiting_decision, 1);
  assert.equal(byId['644701781058:cmp-Other'].resource, 'cmp-Other');
  // The request id is no longer in the key, so it has to come from request.json - and it is what
  // the approval marker is named by, so it has to survive the trip.
  assert.equal(byId['644701781058:cmp-Other'].request_id, '644701781058-2222222222222222');
});

test('two edits to one resource are one plan, not two', async () => {
  // The bug this layout exists to fix. Keyed by the request, the bucket held a folder per edit and
  // every one of them stayed approvable - so an administrator could approve an edit that a later
  // one had already superseded. The second inspection now overwrites the first.
  const first = planFixture('644701781058', 'cmp-TestLimitPolicyByte',
                            { at: ago(900), requestId: '644701781058-1111111111111111' });
  const second = planFixture('644701781058', 'cmp-TestLimitPolicyByte',
                             { at: ago(60), requestId: '644701781058-2222222222222222' });
  assert.equal(first.prefix, second.prefix, 'the fixture itself must land on one prefix');

  const s3 = fakeS3({ [BUCKET]: second.objects }, second.bodies);
  const state = await sweep(s3, CONFIG, { now: NOW });

  assert.equal(state.plans.length, 1, 'one governed resource, one plan');
  assert.equal(state.plans[0].plan_id, '644701781058:cmp-TestLimitPolicyByte');
  assert.equal(state.plans[0].request_id, '644701781058-2222222222222222',
               'the stored plan is the latest inspection');
});

test('a plan with nothing to do is not awaiting a decision', async () => {
  // The inspector stores it anyway, so that it replaces the previous plan. That previous plan does
  // have changes and would otherwise stay approvable - an instruction to make an edit the
  // administrator has since reverted.
  const none = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(60), requestId: '644701781058-3333333333333333',
                             hasChanges: false });
  const s3 = fakeS3({ [BUCKET]: none.objects }, none.bodies);
  const state = await sweep(s3, CONFIG, { now: NOW });

  assert.equal(state.plans.length, 1, 'it is still shown - a resource that matches is worth seeing');
  assert.equal(state.plans[0].state, 'no_changes');
  assert.equal(state.counts.awaiting_decision, 0);
});

test('the state file is not mistaken for a plan artifact', async () => {
  // The listing has no prefix to narrow it, so terraform.tfstate comes back with everything else.
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(60), requestId: '644701781058-4444444444444444' });
  const s3 = fakeS3(
    { [BUCKET]: [
      ...plan.objects,
      { key: '644701781058/cmp-WebHosting/terraform.tfstate', lastModified: ago(30) },
      { key: '644701781058/cmp-WebHosting/', lastModified: ago(30) },
      { key: '644701781058/', lastModified: ago(30) },
    ] },
    plan.bodies,
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans.length, 1);
  assert.deepEqual(state.errors, [], 'state files and folder placeholders are normal, not errors');
});

test('a prefix without request.json is an upload in progress, and is reported', async () => {
  // request.json is written last. Without it the prefix is mid-overwrite, which is a state a
  // healthy system passes through - so it is reported rather than dropped, and clears itself.
  const partial = planFixture('644701781058', 'cmp-WebHosting',
                              { at: ago(60), requestId: '644701781058-5555555555555555' });
  const s3 = fakeS3(
    { [BUCKET]: partial.objects.filter((o) => !o.key.endsWith('request.json')) },
    partial.bodies,
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans.length, 0);
  assert.match(state.errors[0], /incomplete/);
});

test('newest plan first', async () => {
  const older = planFixture('644701781058', 'cmp-Older',
                            { at: ago(9000), requestId: '644701781058-6666666666666666' });
  const newer = planFixture('644701781058', 'cmp-Newer',
                            { at: ago(60), requestId: '644701781058-7777777777777777' });
  const s3 = fakeS3({ [BUCKET]: [...older.objects, ...newer.objects] },
                    { ...older.bodies, ...newer.bodies });
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans[0].plan_id, '644701781058:cmp-Newer');
});

test('an empty bucket is an empty answer and not an error', async () => {
  const state = await sweep(fakeS3({}), CONFIG, { now: NOW });
  assert.deepEqual(state.counts, { failed: 0, running: 0, awaiting_decision: 0, refused: 0 });
  assert.deepEqual(state.errors, []);
});

// ---- the applier's record ----------------------------------------------------------------------
//
// The hole this closes: the applier deletes its approval marker when it finishes, so an applied
// plan used to be indistinguishable from one nobody had looked at. It matters more now that the
// prefix is per resource and does not go away either - every applied resource would have read as
// forever awaiting a decision.

test('a plan the applier finished with is not awaiting a decision', async () => {
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(60), requestId: '644701781058-aaaaaaaaaaaaaaa2',
                             outcome: {} });
  const s3 = fakeS3({ [BUCKET]: plan.objects }, plan.bodies);
  const state = await sweep(s3, CONFIG, { now: NOW });

  assert.equal(state.plans[0].state, 'applied');
  assert.equal(state.counts.awaiting_decision, 0);
  // The surviving copy of the decision. The marker that carried it has been deleted.
  assert.equal(state.plans[0].outcome.reviewer, 'kim');
  assert.equal(state.plans[0].outcome.applied, true);
});

test('the permission set ARN travels from the outcome to the plan, and only as a string', async () => {
  // The applier reads the document's outputs back from state after the apply - the ARN exists
  // only then - and records them under outcome.outputs. The page deep-links the permission set's
  // console page with it, so it is exposed on the plan; everything else in outputs is not.
  const arn = 'arn:aws:sso:::permissionSet/ssoins-7223da1aa8587c47/ps-7223bc011e9f4d36';
  const plan = planFixture('644701781058', 'ps-DataOps-Analyst',
                           { at: ago(60), requestId: '644701781058-aaaaaaaaaaaaaaa7',
                             outcome: { outputs: { permission_set_arn: arn,
                                                   name_truncated: false } } });
  const s3 = fakeS3({ [BUCKET]: plan.objects }, plan.bodies);
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans[0].outcome.permission_set_arn, arn);

  // An outcome recorded before the applier captured outputs, or with a shape that is not the
  // ARN's, yields null - the Governed link falls back to the console home rather than rendering
  // whatever was in the bucket.
  for (const outputs of [undefined, {}, { permission_set_arn: 42 }, 'not-an-object']) {
    const older = planFixture('644701781058', 'ps-DataOps-Analyst',
                              { at: ago(60), requestId: '644701781058-aaaaaaaaaaaaaaa8',
                                outcome: outputs === undefined ? {} : { outputs } });
    const olderState = await sweep(fakeS3({ [BUCKET]: older.objects }, older.bodies),
                                   CONFIG, { now: NOW });
    assert.equal(olderState.plans[0].outcome.permission_set_arn, null, JSON.stringify(outputs));
  }
});

test('a denial the applier closed is shown as closed, not as applied', async () => {
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(60), requestId: '644701781058-aaaaaaaaaaaaaaa3',
                             outcome: { decision: 'deny', applied: false,
                                        detail: 'denied by kim: too broad' } });
  const s3 = fakeS3({ [BUCKET]: plan.objects }, plan.bodies);
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans[0].state, 'closed');
  assert.equal(state.plans[0].outcome.applied, false);
});

test('an outcome from a plan this one replaced is ignored', async () => {
  // The prefix is overwritten in place, and the applier writes one outcome per apply. A fresh
  // plan sitting beside a previous plan's outcome must not read as already decided - that would
  // hide a plan somebody has to look at.
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(60), requestId: '644701781058-aaaaaaaaaaaaaaa4',
                             outcome: { request_id: '644701781058-0000000000000000' } });
  const s3 = fakeS3({ [BUCKET]: plan.objects }, plan.bodies);
  const state = await sweep(s3, CONFIG, { now: NOW });

  assert.equal(state.plans[0].state, 'awaiting_decision');
  assert.equal(state.plans[0].outcome, null);
  assert.equal(state.counts.awaiting_decision, 1);
});

test('an outcome beats an approval marker that is still sitting there', async () => {
  // Ordering. Between the applier writing the outcome and deleting the marker, both exist - and
  // the outcome is the newer fact.
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(60), requestId: '644701781058-aaaaaaaaaaaaaaa5',
                             outcome: {} });
  const s3 = fakeS3(
    { 'opt-solution-markers': [
        { key: 'applier/644701781058-aaaaaaaaaaaaaaa5.json', lastModified: ago(90) },
      ],
      [BUCKET]: plan.objects },
    { 'opt-solution-markers/applier/644701781058-aaaaaaaaaaaaaaa5.json':
        { request_id: '644701781058-aaaaaaaaaaaaaaa5', decision: 'approve', reviewer: 'kim' },
      ...plan.bodies },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans[0].state, 'applied');
});

// ---- what is and is not a plan key --------------------------------------------------------------

test('a plan id is the governed resource, and it round trips', () => {
  assert.deepEqual(planIdFromKey('644701781058/cmp-WebHosting/plan/tfplan'),
                   { planId: '644701781058:cmp-WebHosting', artifact: 'tfplan' });
  assert.equal(planPrefixFromId('644701781058:cmp-WebHosting'),
               '644701781058/cmp-WebHosting/plan/');
});

test('a key that is not a plan artifact is not one', () => {
  for (const key of [
    '644701781058/cmp-WebHosting/terraform.tfstate',   // the state, in the same prefix
    '644701781058/cmp-WebHosting/plan/',               // folder placeholder
    '644701781058/cmp-WebHosting/plan/a/b',            // nested deeper
    '644701781058/cmp-WebHosting/',
    '644701781058/',
    'plans/644701781058-1111111111111111/tfplan',      // the layout this replaced
    '64470178105/cmp-WebHosting/plan/tfplan',          // 11 digits
  ]) {
    assert.equal(planIdFromKey(key), null, key);
  }
});

test('a plan id that could steer a key is refused', () => {
  // The id arrives in a URL and becomes an S3 key. The IAM policy name character set has no / and
  // no ., so nothing that could traverse is spellable - and the check is here rather than assumed.
  for (const bad of [
    '644701781058:../../etc',
    '644701781058:cmp/WebHosting',
    '644701781058:',
    '64470178105:cmp-X',
    '644701781058-1111111111111111',                   // a request id is not a plan id
    '',
    null,
    undefined,
  ]) {
    assert.equal(planPrefixFromId(bad), null, String(bad));
  }
});

// ---- what is and is not a marker ---------------------------------------------------------------
//
// Creating inspector/ or applier/ as a folder in the S3 console leaves a zero byte object whose
// key IS the prefix, and a listing returns it like any other object. Reading it as JSON failed
// with "Unexpected end of JSON input" and the page reported two things the sweep could not read -
// on a bucket where nothing was wrong.

test('a folder placeholder is not a marker', () => {
  assert.equal(requestIdFromMarkerKey('inspector/', 'inspector/'), null);
  assert.equal(requestIdFromMarkerKey('applier/', 'applier/'), null);
});

test('a key nested deeper than the prefix is not a marker either', () => {
  assert.equal(requestIdFromMarkerKey('inspector/sub/644701781058-aaaa.json', 'inspector/'), null);
});

test('a real marker key yields its request id', () => {
  assert.equal(
    requestIdFromMarkerKey('inspector/644701781058-a1b2c3d4e5f60718.json', 'inspector/'),
    '644701781058-a1b2c3d4e5f60718',
  );
});

test('a folder placeholder is never read, so it produces no error', async () => {
  // The bug exactly: the listing went to the body reader unfiltered, so the reader tried to parse
  // an object the describer would have skipped. Both prefixes, which is why there were two.
  const s3 = fakeS3(
    { 'opt-solution-markers': [
      { key: 'inspector/', size: 0, lastModified: ago(86400) },
      { key: 'applier/', size: 0, lastModified: ago(86400) },
      { key: 'inspector/644701781058-a1b2c3d4e5f60718.json', lastModified: ago(7200) },
    ] },
    { 'opt-solution-markers/inspector/644701781058-a1b2c3d4e5f60718.json':
        { account_id: '644701781058', resource: 'cmp-SolutionTest', kind: 'spec_policy' } },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.deepEqual(state.errors, [], 'a folder placeholder must not read as a failure');
  assert.equal(state.markers.length, 1);
  assert.equal(state.markers[0].resource, 'cmp-SolutionTest');
  assert.equal(state.skipped_keys, 2, 'both placeholders counted, neither reported');
});

test('two accounts with the same policy name stay separate', async () => {
  // What the operator actually did: cmp-SolutionTest in 718100330247 and in 644701781058. The
  // request id carries the account, so the two markers cannot collide.
  const s3 = fakeS3(
    { 'opt-solution-markers': [
      { key: 'inspector/', size: 0, lastModified: ago(86400) },
      { key: 'inspector/718100330247-1111111111111111.json', lastModified: ago(7200) },
      { key: 'inspector/644701781058-2222222222222222.json', lastModified: ago(7200) },
    ] },
    { 'opt-solution-markers/inspector/718100330247-1111111111111111.json':
        { account_id: '718100330247', resource: 'cmp-SolutionTest', kind: 'spec_policy' },
      'opt-solution-markers/inspector/644701781058-2222222222222222.json':
        { account_id: '644701781058', resource: 'cmp-SolutionTest', kind: 'spec_policy' } },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.deepEqual(state.errors, []);
  assert.equal(state.markers.length, 2);
  assert.deepEqual(
    state.markers.map((m) => m.account_id).sort(),
    ['644701781058', '718100330247'],
  );
});

test('a marker whose body is genuinely unreadable is still an error', async () => {
  // The fix must not swallow the case it was meant to report: the key looks like a marker and the
  // object will not parse.
  const s3 = fakeS3(
    { 'opt-solution-markers': [
      { key: 'inspector/644701781058-7777777777777777.json', lastModified: ago(7200) },
    ] },
    { 'opt-solution-markers/inspector/644701781058-7777777777777777.json': 'not json at all' },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /is not JSON/);
  assert.equal(state.markers.length, 1, 'and the marker is still reported as present');
});

// ---- the two values an approval carries --------------------------------------------------------
//
//   tfplan_sha256    the binary the applier runs is the binary that was approved
//   changes_sha256   the plan.txt and plan.json a person read describe that binary
//
// The first is computed here, from bytes this process read. The second is the inspector's, copied
// and never computed: the dashboard is the component that is not trusted, so it must not author a
// value that authorises its own approval.

test('the digest is read from the bucket, not computed here', async () => {
  const DIGEST = 'a'.repeat(64);
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(600), requestId: '644701781058-8888888888888888',
                             digest: DIGEST });
  const s3 = fakeS3({ [BUCKET]: plan.objects }, plan.bodies);

  const detail = await readPlan(s3, CONFIG, '644701781058:cmp-WebHosting');
  assert.equal(detail.changes_sha256, DIGEST, 'the trailing newline must be trimmed');
  // The two values are separate and answer separate questions - one may not stand in for the
  // other. This one is the hash of the plan file itself, computed from the bytes just read.
  assert.notEqual(detail.plan_file_sha256, DIGEST);
  // And the request id comes from request.json, since it is no longer in the key.
  assert.equal(detail.request_id, '644701781058-8888888888888888');
  assert.equal(detail.has_changes, true);
});

test('a plan with no digest cannot be approved', async () => {
  // Plans written before the inspector produced the artifact. Approving one would leave nothing
  // establishing that the plan.txt the approver read describes the file the applier will run.
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(600), requestId: '644701781058-9999999999999999' });
  const s3 = fakeS3(
    { [BUCKET]: plan.objects.filter((o) => !o.key.endsWith('changes.sha256')) },
    plan.bodies,
  );
  const detail = await readPlan(s3, CONFIG, '644701781058:cmp-WebHosting');
  assert.equal(detail.changes_sha256, null);
});

test('a plan whose manifest says there is nothing to do says so', async () => {
  const plan = planFixture('644701781058', 'cmp-WebHosting',
                           { at: ago(60), requestId: '644701781058-aaaaaaaaaaaaaaa1',
                             hasChanges: false });
  const s3 = fakeS3({ [BUCKET]: plan.objects }, plan.bodies);
  const detail = await readPlan(s3, CONFIG, '644701781058:cmp-WebHosting');
  assert.equal(detail.has_changes, false);
});

test('a plan id that is not one reads as no plan at all', async () => {
  const s3 = fakeS3({});
  assert.equal(await readPlan(s3, CONFIG, '../../etc'), null);
  assert.equal(await readPlan(s3, CONFIG, '644701781058-1111111111111111'), null);
});

test('a truncated or malformed digest is treated as absent', () => {
  assert.equal(isDigest('a'.repeat(64)), true);
  assert.equal(isDigest('a'.repeat(63)), false);
  assert.equal(isDigest('a'.repeat(65)), false);
  assert.equal(isDigest('A'.repeat(64)), false, 'uppercase is not what python hexdigest writes');
  assert.equal(isDigest('g'.repeat(64)), false);
  assert.equal(isDigest(''), false);
  assert.equal(isDigest(null), false);
  assert.equal(isDigest(undefined), false);
});

// ---- marker bodies the sweep already holds -------------------------------------------------------
//
// The sweep answers two questions with two costs. Which markers exist is one listing. What each one
// is about was a GetObject per marker, and that is the only reason the body-read cap, the partial
// read warning and the body_read flag exist.
//
// Two of the three writers hand this process the body for free: the listener announces an inspector
// marker with its body, and the applier markers are ones this process wrote itself. So in a healthy
// system the sweep makes no GetObject on the marker bucket at all - and when it misses, it costs a
// call rather than a wrong answer, which is what keeps the announcement from being load-bearing.

const MARKER_BODY = {
  request_id: '644701781058-aaaaaaaaaaaaaaaa',
  account_id: '644701781058',
  resource: 'cmp-WebHosting',
  kind: 'spec_policy',
  first_event_at: ago(120),
  last_event_at: ago(113),
  events: [{ event_name: 'CreatePolicy', event_time: ago(120), detail: { big: 'x'.repeat(200) } }],
};

test('a body already held is not fetched again', async () => {
  const bodies = makeMarkerBodies();
  bodies.put('inspector', '644701781058-aaaaaaaaaaaaaaaa', MARKER_BODY, 'announced');

  const s3 = fakeS3({ 'opt-solution-markers': [
    { key: 'inspector/644701781058-aaaaaaaaaaaaaaaa.json', lastModified: ago(60) },
  ] });
  const state = await sweep(s3, CONFIG, { now: NOW, bodies });

  assert.deepEqual(s3.gets, [], 'the sweep fetched a body it was already given');
  assert.equal(state.bodies.held, 1);
  assert.equal(state.bodies.fetched, 0);
  // And the row is the same one a fetch would have produced.
  assert.equal(state.markers[0].resource, 'cmp-WebHosting');
  assert.equal(state.markers[0].body_read, true);
  assert.equal(state.markers[0].event_count, 1);
});

test('a body that was never announced is fetched, and the answer is the same', async () => {
  // The fallback, and the reason a lost announcement costs a call rather than a wrong answer.
  const s3 = fakeS3(
    { 'opt-solution-markers': [
      { key: 'inspector/644701781058-aaaaaaaaaaaaaaaa.json', lastModified: ago(60) },
    ] },
    { 'opt-solution-markers/inspector/644701781058-aaaaaaaaaaaaaaaa.json': MARKER_BODY },
  );
  const state = await sweep(s3, CONFIG, { now: NOW, bodies: makeMarkerBodies() });

  assert.deepEqual(s3.gets, ['inspector/644701781058-aaaaaaaaaaaaaaaa.json']);
  assert.equal(state.bodies.fetched, 1);
  assert.equal(state.markers[0].resource, 'cmp-WebHosting');
});

test('an applier marker this process wrote is not read back', async () => {
  // It knows what is in it. Reading it back was a round trip to learn something it had just decided.
  const approval = { request_id: '644701781058-bbbbbbbbbbbbbbbb', account_id: '644701781058',
                     resource: 'cmp-WebHosting', decision: 'approve', reviewer: 'kim' };
  const bodies = makeMarkerBodies();
  bodies.put('applier', '644701781058-bbbbbbbbbbbbbbbb', approval, 'written-here');

  const s3 = fakeS3({ 'opt-solution-markers': [
    { key: 'applier/644701781058-bbbbbbbbbbbbbbbb.json', lastModified: ago(60) },
  ] });
  const state = await sweep(s3, CONFIG, { now: NOW, bodies });

  assert.deepEqual(s3.gets, []);
  assert.equal(state.markers[0].reviewer, 'kim');
  assert.equal(state.markers[0].decision, 'approve');
});

test('the fetch cap counts only what was not already held', async () => {
  // The cap exists because fetching bodies in bulk is expensive. Bodies that arrived by
  // announcement cost nothing, so they must not consume it.
  const bodies = makeMarkerBodies();
  const objects = [];
  for (let i = 0; i < 5; i += 1) {
    const id = `644701781058-${String(i).repeat(16)}`;
    objects.push({ key: `inspector/${id}.json`, lastModified: ago(60 + i) });
    if (i < 3) bodies.put('inspector', id, { ...MARKER_BODY, request_id: id }, 'announced');
  }
  const s3 = fakeS3({ 'opt-solution-markers': objects });
  const state = await sweep(s3, CONFIG, { ...{ now: NOW }, bodies });

  assert.equal(state.bodies.held, 3);
  assert.equal(state.bodies.fetched, 2, 'only the two that were never announced');
  assert.equal(s3.gets.length, 2);
});

// ---- a refused inspection ----------------------------------------------------------------------
//
// The silence this closes. A refusal is a COMPLETED run, so the marker is deleted, so the request
// used to vanish: the reason existed in CloudWatch and nowhere a person at this page would ever be.
// The observed case was a spec role carrying twelve managed policies against a limit of ten - no
// plan, no failure, no row, and an administrator whose edit apparently did nothing.

const REFUSAL = '12 managed policies including the baseline, and the limit is 10';

const withRefusal = (fixture, { at, requestId, reason = REFUSAL, kind = 'ps_role' }) => {
  const objects = [...fixture.objects, { key: `${fixture.prefix}refusal.json`, lastModified: at }];
  const bodies = {
    ...fixture.bodies,
    [`${BUCKET}/${fixture.prefix}refusal.json`]: {
      schema: 1, request_id: requestId, account_id: '644701781058', resource: 'ps-Taeyoung',
      kind, reason, refused_at: at,
    },
  };
  return { ...fixture, objects, bodies };
};

test('a refusal newer than the plan is shown, and outranks what the plan was waiting for', async () => {
  // The plan is real and still approvable - but it describes an EARLIER version of the resource,
  // and the last attempt to plan the current one failed. Reporting it as awaiting a decision would
  // answer a question nobody asked while the one that was asked went unmentioned.
  const plan = planFixture('644701781058', 'ps-Taeyoung',
                           { at: ago(600), requestId: '644701781058-aaaaaaaaaaaaaaa1' });
  const withIt = withRefusal(plan, { at: ago(60), requestId: '644701781058-a21abcd0ebbaad7e' });
  const state = await sweep(fakeS3({ [BUCKET]: withIt.objects }, withIt.bodies), CONFIG,
                            { now: NOW });
  const [row] = state.plans;
  assert.equal(row.state, 'refused');
  assert.equal(row.refusal.reason, REFUSAL);
  assert.equal(row.refusal.request_id, '644701781058-a21abcd0ebbaad7e');
  assert.equal(row.refusal.supersedes_plan, true,
               'nothing says the plan on screen is older than the last thing that happened');
  assert.equal(state.counts.refused, 1);
  // The plan itself is still there and still readable - the refusal explains it, it does not
  // replace it.
  assert.equal(row.request_id, '644701781058-aaaaaaaaaaaaaaa1');
  assert.ok(row.plan_bytes !== null);
});

test('a refusal superseded by a later plan is not shown at all', async () => {
  // The inspector holds no delete on this bucket, so a record cannot be removed when the problem
  // is fixed. It does not need to be: a later successful inspection rewrites request.json with its
  // own id, and the ids then agree.
  const plan = planFixture('644701781058', 'ps-Taeyoung',
                           { at: ago(60), requestId: '644701781058-a21abcd0ebbaad7e' });
  const stale = withRefusal(plan, { at: ago(600), requestId: '644701781058-a21abcd0ebbaad7e' });
  const state = await sweep(fakeS3({ [BUCKET]: stale.objects }, stale.bodies), CONFIG,
                            { now: NOW });
  const [row] = state.plans;
  assert.equal(row.refusal, null, 'a fixed resource still reports itself as refused');
  assert.equal(row.state, 'awaiting_decision');
  assert.equal(state.counts.refused, 0);
});

test('a resource whose FIRST inspection was refused is a row, not an incompleteness warning', async () => {
  // The prefix holds nothing but the record. Reporting that as "incomplete" would file the one
  // thing that explains it under the noise everybody learns to ignore.
  const prefix = '644701781058/ps-Taeyoung/plan/';
  const objects = [{ key: `${prefix}refusal.json`, lastModified: ago(60) }];
  const bodies = {
    [`${BUCKET}/${prefix}refusal.json`]: {
      schema: 1, request_id: '644701781058-a21abcd0ebbaad7e', account_id: '644701781058',
      resource: 'ps-Taeyoung', kind: 'ps_role', reason: REFUSAL, refused_at: ago(60),
    },
  };
  const state = await sweep(fakeS3({ [BUCKET]: objects }, bodies), CONFIG, { now: NOW });
  assert.deepEqual(state.errors, [], 'the refusal was reported as an incomplete upload');
  const [row] = state.plans;
  assert.equal(row.state, 'refused');
  assert.equal(row.plan_id, '644701781058:ps-Taeyoung');
  assert.equal(row.account_id, '644701781058');
  assert.equal(row.resource, 'ps-Taeyoung');
  assert.equal(row.refusal.reason, REFUSAL);
  // There has never been a plan here, so nothing is superseded and nothing can be approved.
  assert.equal(row.refusal.supersedes_plan, false);
  assert.equal(row.plan_bytes, null);
  assert.equal(row.assessment, 'unavailable');
});

test('a prefix with neither a plan nor a refusal is still reported as incomplete', async () => {
  // The refusal branch must not swallow the case it was added beside.
  const prefix = '644701781058/ps-Taeyoung/plan/';
  const state = await sweep(
    fakeS3({ [BUCKET]: [{ key: `${prefix}tfplan`, lastModified: ago(60) }] }, {}),
    CONFIG, { now: NOW });
  assert.equal(state.plans.length, 0);
  assert.match(state.errors[0] ?? '', /is incomplete/);
});

// The row says a refusal happened; the PANEL is where somebody reads what it was. The sweep runs on
// an interval, so the detail reads the prefix itself rather than being handed the row's copy - the
// moment this matters most is the one right after an administrator changed the resource and opened
// the plan to find out what happened to it.

test('the panel carries the refusal, read as the prefix is when it opens', async () => {
  const plan = planFixture('644701781058', 'ps-Taeyoung',
                           { at: ago(600), requestId: '644701781058-aaaaaaaaaaaaaaa1' });
  const withIt = withRefusal(plan, { at: ago(60), requestId: '644701781058-a21abcd0ebbaad7e' });
  const detail = await readPlan(fakeS3({ [BUCKET]: withIt.objects }, withIt.bodies), CONFIG,
                                '644701781058:ps-Taeyoung');
  assert.equal(detail.refusal.reason, REFUSAL, 'the reason reaches the page verbatim');
  assert.equal(detail.refusal.supersedes_plan, true);
  // And the plan is still all there. The refusal explains the plan, it does not replace it: this
  // one is real, approvable, and describes an earlier version of the resource.
  assert.equal(detail.plan_stored, true);
  assert.ok(detail.plan_file_sha256);
  assert.equal(detail.request_id, '644701781058-aaaaaaaaaaaaaaa1');
});

test('a resource that never got a plan opens on the reason and nothing else', async () => {
  const prefix = '644701781058/ps-Taeyoung/plan/';
  const objects = [{ key: `${prefix}refusal.json`, lastModified: ago(60) }];
  const bodies = {
    [`${BUCKET}/${prefix}refusal.json`]: {
      schema: 1, request_id: '644701781058-a21abcd0ebbaad7e', account_id: '644701781058',
      resource: 'ps-Taeyoung', kind: 'ps_role', reason: REFUSAL, refused_at: ago(60),
    },
  };
  const detail = await readPlan(fakeS3({ [BUCKET]: objects }, bodies), CONFIG,
                                '644701781058:ps-Taeyoung');
  assert.ok(detail, 'the panel 404s and the reason is unreachable from the row that offers it');
  assert.equal(detail.refusal.reason, REFUSAL);
  assert.equal(detail.refusal.supersedes_plan, false);
  // plan_stored is what tells the page the emptiness below is nothing-was-written rather than
  // reading-failed, and it is what stops a decision form being offered for a plan that is not there.
  assert.equal(detail.plan_stored, false);
  assert.equal(detail.plan_file_sha256, null);
  assert.equal(detail.changes_sha256, null, 'and so it could not be approved even if it were shown');
});

test('a refusal the panel cannot parse leaves the plan readable', async () => {
  // The plan is the thing being decided about. A record that will not parse is a lost explanation,
  // not a reason to withhold the plan it was explaining - which would turn a bad byte in an
  // advisory artifact into an outage on the decision path.
  const plan = planFixture('644701781058', 'ps-Taeyoung',
                           { at: ago(600), requestId: '644701781058-aaaaaaaaaaaaaaa1' });
  const objects = [...plan.objects,
                   { key: `${plan.prefix}refusal.json`, lastModified: ago(60) }];
  const bodies = { ...plan.bodies, [`${BUCKET}/${plan.prefix}refusal.json`]: 'not json at all' };
  const detail = await readPlan(fakeS3({ [BUCKET]: objects }, bodies), CONFIG,
                                '644701781058:ps-Taeyoung');
  assert.equal(detail.refusal, null);
  assert.ok(detail.plan_file_sha256);
});


// ---- the PassRole requests a mirror plan carries ------------------------------------------------

test('the requests are read from the plan outputs, and a value terraform cannot give yet is null',
  () => {
    const plan = {
      output_changes: {
        passrole_requested_by: { actions: ['create'], after: ['bob', 'alice', 'bob'] },
        passrole_services: { actions: ['create'], after: ['lambda.amazonaws.com'] },
        // The ordinary case for a role this plan is creating: terraform says "(known after apply)".
        passrole_target_arn: { actions: ['create'], after: null, after_unknown: true },
      },
    };
    assert.deepEqual(passroleFromPlan(plan), {
      requested_by: ['alice', 'bob'],
    granted_to: [],
    untagged: [],
      services: ['lambda.amazonaws.com'],
      target_arn: null,
    });
  });

test('after_unknown is not read as a value', () => {
  // `true` where an ARN belongs would put the string "true" on screen and, worse, make a caller
  // think the role is known.
  const plan = { output_changes: { passrole_target_arn: { after_unknown: true } } };
  assert.equal(passroleFromPlan(plan).target_arn, null);

  // The case that matters more, because a type check would not stop it: for a LIST output
  // after_unknown is list-shaped too. Read as the value, it would put names on the screen as
  // requests nobody made - and a name on this screen is what an approver ticks.
  assert.deepEqual(
    passroleFromPlan({ output_changes: { passrole_requested_by: { after_unknown: ['alice'] } } }),
    { requested_by: [], granted_to: [], untagged: [], services: [], target_arn: null });
});

test('a plan with no passrole outputs answers empty rather than undefined', () => {
  // Every plan goes through this - a permission set plan has none of these outputs at all - and the
  // page reads .requested_by.length without checking.
  for (const plan of [null, {}, { output_changes: {} }, { output_changes: { other: {} } }]) {
    assert.deepEqual(passroleFromPlan(plan),
      { requested_by: [], granted_to: [], untagged: [], services: [], target_arn: null });
  }
});

test('a non-list output does not become a request', () => {
  const plan = {
    output_changes: {
      passrole_requested_by: { after: 'alice' },
      passrole_services: { after: { not: 'a list' } },
    },
  };
  assert.deepEqual(passroleFromPlan(plan).requested_by, []);
  assert.deepEqual(passroleFromPlan(plan).services, []);
});


test('the row says how many asked, read from the document the sweep already fetches', () => {
  // main.tf.json rather than plan.json: the sweep reads it for every row to get the identity, and
  // the requesters are literal in it - the inspector resolved the tags before generating.
  assert.deepEqual(
    requestersFromConfig({ output: { passrole_requested_by: { value: ['bob', 'alice', 'bob'] } } }),
    ['alice', 'bob']);
  for (const document of [null, {}, { output: {} },
                          { output: { passrole_requested_by: { value: 'alice' } } }]) {
    assert.deepEqual(requestersFromConfig(document), []);
  }
});


test('a row carries the number of people who asked, so the list can offer the way in', async () => {
  const asked = planFixture('644701781058', 'lambda-function1',
                            { at: ago(600), requestId: '644701781058-3333333333333333',
                              requestedBy: ['bob', 'alice'] });
  const quiet = planFixture('644701781058', 'ps-alice',
                            { at: ago(600), requestId: '644701781058-4444444444444444' });
  const s3 = fakeS3({ [BUCKET]: [...asked.objects, ...quiet.objects] },
                    { ...asked.bodies, ...quiet.bodies });
  const state = await sweep(s3, CONFIG, { now: NOW });

  assert.equal(state.plans.find((p) => p.resource === 'lambda-function1').passrole_requests, 2);
  // And nothing on a plan nobody asked about - a way in to an empty screen teaches people to stop
  // clicking, so the row shows none.
  assert.equal(state.plans.find((p) => p.resource === 'ps-alice').passrole_requests, 0);
});


// ---- the inline writer's lock, which was the one marker nobody swept ---------------------------

test('a held inline writer lock is reported, because it blocks a permission set', async () => {
  // The worst state in the system was the only invisible one. The approval went through, the grant
  // went into force, the restriction did not, and every later decision for that permission set was
  // blocked - with nothing on any screen saying so, because outcome.json records that state as
  // `dispatched`. The prefix was simply never listed.
  const key = 'inline_writer/644701781058:644701781058-alice.json';
  const s3 = fakeS3(
    { 'opt-solution-markers': [{ key, lastModified: ago(4000) }] },
    { [`opt-solution-markers/${key}`]: {
      mode: 'deny',
      request_id: '644701781058-5555555555555555',
      account_id: '644701781058',
      resource: 'ps-alice',
      permission_set_name: '644701781058-alice',
    } },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });

  const lock = state.markers.find((m) => m.kind === 'inline_writer');
  assert.ok(lock, 'the inline_writer prefix was not swept');
  assert.equal(lock.state, 'failed');
  assert.equal(lock.blocks_further_writes, true,
    'the row does not say the permission set is blocked');
  // The key is the lock, not a request. The request id is in the body.
  assert.equal(lock.permission_set, '644701781058-alice');
  assert.equal(lock.request_id, '644701781058-5555555555555555');
});

test('a lock whose body will not read still says which permission set it holds', async () => {
  // The key carries the identity even when the body is unreadable, and that is the fact that
  // matters: something has to be cleared, and the reader needs to know what is blocked.
  const key = 'inline_writer/644701781058:644701781058-alice.json';
  const s3 = fakeS3({ 'opt-solution-markers': [{ key, lastModified: ago(4000) }] }, {});
  const state = await sweep(s3, CONFIG, { now: NOW });

  const lock = state.markers.find((m) => m.kind === 'inline_writer');
  assert.equal(lock.permission_set, '644701781058-alice');
  assert.equal(lock.request_id, null, 'a request id was invented from a key that has none');
  assert.equal(lock.blocks_further_writes, true);
});

test('the other three kinds are not locks and do not claim to be', async () => {
  const key = 'applier/644701781058-6666666666666666.json';
  const s3 = fakeS3(
    { 'opt-solution-markers': [{ key, lastModified: ago(4000) }] },
    { [`opt-solution-markers/${key}`]: { account_id: '644701781058', resource: 'ps-alice' } },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  const row = state.markers.find((m) => m.kind === 'applier');
  assert.equal(row.blocks_further_writes, false);
  assert.equal(row.permission_set, null);
  assert.equal(row.request_id, '644701781058-6666666666666666');
});


test('the two lists the request list cannot answer travel with it', () => {
  // granted_to says who HOLDS the grant; untagged says whose tag was removed while their grant
  // stands. Neither is derivable from requested_by - the first is state and the second is a name
  // that is deliberately NOT in it.
  const answer = passroleFromPlan({
    output_changes: {
      passrole_requested_by: { after: ['alice', 'bob'] },
      passrole_granted_to: { after: ['bob', 'carol'] },
      passrole_untagged: { after: ['carol'] },
      passrole_services: { after: ['lambda.amazonaws.com'] },
    },
  });
  assert.deepEqual(answer.requested_by, ['alice', 'bob']);
  assert.deepEqual(answer.granted_to, ['bob', 'carol']);
  assert.deepEqual(answer.untagged, ['carol'], 'the withdrawal is not carried to the page');
  // carol is granted and untagged, and must NOT read as a request - there is nothing to grant.
  assert.ok(!answer.requested_by.includes('carol'));
});

// ---- did the inline writer do what the decision dispatched? -------------------------------------
//
// The gap: an approver confirms PassRole for three people, the applier writes three work orders and
// records `dispatched`, and one writer fails. Every screen said the decision was applied. The
// person who asked never got the grant, the reason was in CloudWatch, and the only trace was a lock
// nobody reads.
//
// `dispatched` means the work order was written. It has never meant that the writer did anything
// with it, and these tests are about keeping those two facts apart.

const LOCK = (user) => `inline_writer/644701781058:644701781058-${user}.json`;
const RESULT = (user) => `inline_result/644701781058:644701781058-${user}.json`;
const SENT = (user, over = {}) => ({
  user_name: user, action: 'grant', permission_set: `644701781058-${user}`,
  key: LOCK(user), retry: false, ...over,
});

test('a written result is the only thing that counts as applied', () => {
  const [alice] = writerVerification(
    [SENT('alice')],
    new Map([[LOCK('alice'), { state: 'written', ok: true, reason: '', finished_at: 'then' }]]),
    new Set(),
  );
  assert.equal(alice.ok, true);
  assert.equal(alice.state, 'written');
  assert.equal(alice.retryable, false, 'a finished writer must not be re-dispatched');
});

test('a missing lock is not proof the grant was written', () => {
  // A refusal releases the lock without writing anything. Reading "no lock" as success would report
  // the exact state this whole panel exists to surface as finished.
  const [alice] = writerVerification([SENT('alice')], new Map(), new Set());
  assert.equal(alice.ok, false);
  assert.equal(alice.state, null);
  assert.equal(alice.locked, false);
  assert.equal(alice.retryable, false, 'nothing establishes the run has stopped');
});

test('a failed writer carries its reason and is the one thing retry is offered on', () => {
  const [alice] = writerVerification(
    [SENT('alice')],
    new Map([[LOCK('alice'), {
      state: 'failed', ok: false, reason: 'terraform apply failed: exit 1',
      finished_at: '2026-08-31T00:00:00Z',
    }]]),
    new Set([LOCK('alice')]),
  );
  assert.equal(alice.ok, false);
  assert.equal(alice.retryable, true);
  assert.equal(alice.locked, true);
  assert.equal(alice.reason, 'terraform apply failed: exit 1',
               'the cause is the whole of what a person gets, so it has to travel');
});

test('a refused writer is retryable too, because its run stopped', () => {
  // Normally moot - a refusal releases the lock - but a release that itself failed leaves a stopped
  // run holding one, and the applier may take that over for the same reason.
  const [alice] = writerVerification(
    [SENT('alice')],
    new Map([[LOCK('alice'), { state: 'refused', ok: false, reason: 'no such permission set' }]]),
    new Set([LOCK('alice')]),
  );
  assert.equal(alice.retryable, true);
  assert.equal(alice.reason, 'no such permission set');
});

test('a lock with no result is never retryable, however long it has been there', () => {
  // The case the gate exists for. A run still going and a task killed before it ran any code leave
  // the identical object, and overwriting it would put a second work order under a live apply.
  const [alice] = writerVerification([SENT('alice')], new Map(), new Set([LOCK('alice')]));
  assert.equal(alice.locked, true);
  assert.equal(alice.state, null);
  assert.equal(alice.retryable, false);
});

test('the count is per person, and one failure does not hide the rest', () => {
  const writers = writerVerification(
    [SENT('alice'), SENT('bob'), SENT('carol', { action: 'revoke' })],
    new Map([
      [LOCK('alice'), { state: 'written', ok: true }],
      [LOCK('bob'), { state: 'failed', ok: false, reason: 'AccessDenied' }],
      [LOCK('carol'), { state: 'written', ok: true }],
    ]),
    new Set([LOCK('bob')]),
  );
  assert.equal(writers.length, 3);
  assert.deepEqual(writers.filter((w) => w.ok).map((w) => w.user_name), ['alice', 'carol']);
  assert.deepEqual(writers.filter((w) => w.retryable).map((w) => w.user_name), ['bob']);
  assert.equal(writers[2].action, 'revoke',
               'a retry repeats the act, so a withdrawal must not read as a grant');
});

test('a result for another permission set is not read as this one', () => {
  // Keyed by the lock, which is keyed by the permission set. Joining on anything looser would let
  // bob's success answer for alice.
  const [alice] = writerVerification(
    [SENT('alice')],
    new Map([[LOCK('bob'), { state: 'written', ok: true }]]),
    new Set(),
  );
  assert.equal(alice.ok, false);
  assert.equal(alice.state, null);
});

test('a dispatch entry that names nobody is dropped rather than rendered', () => {
  const writers = writerVerification(
    [SENT('alice'), { key: LOCK('bob') }, null, { user_name: '  ' }],
    new Map(), new Set(),
  );
  assert.deepEqual(writers.map((w) => w.user_name), ['alice']);
});

test('the plan detail reads the writers for the work orders its outcome recorded', async () => {
  const requestId = '644701781058-cccccccccccccccc';
  const plan = planFixture('644701781058', 'mirror-lambda-Report', {
    at: ago(600), requestId,
    outcome: {
      inline_state: 'dispatched',
      inline_detail: `${LOCK('alice')} ${LOCK('bob')}`,
      passrole_dispatch: [SENT('alice'), SENT('bob')],
      retries: [],
    },
  });
  const s3 = fakeS3(
    { [BUCKET]: plan.objects,
      'opt-solution-markers': [{ key: LOCK('bob'), lastModified: ago(60) }] },
    { ...plan.bodies,
      [`opt-solution-markers/${RESULT('alice')}`]: { state: 'written', ok: true, reason: '' },
      [`opt-solution-markers/${RESULT('bob')}`]: {
        state: 'failed', ok: false, reason: 'terraform apply failed: exit 1',
      } },
  );

  const detail = await readPlan(s3, { ...CONFIG, inlineResultPrefix: 'inline_result/' },
                                '644701781058:mirror-lambda-Report');
  assert.equal(detail.passrole_writers.length, 2);
  const [alice, bob] = detail.passrole_writers;
  assert.equal(alice.ok, true);
  assert.equal(bob.retryable, true);
  assert.equal(bob.locked, true, 'the lock listing has to reach the row');
  assert.equal(bob.reason, 'terraform apply failed: exit 1');
  // And the applier's own word travels beside it, because "dispatched" is what the screen used to
  // stop at.
  assert.equal(detail.outcome.inline_state, 'dispatched');
});

test('a plan that granted nobody reads no result objects at all', async () => {
  const plan = planFixture('644701781058', 'cmp-WebHosting', {
    at: ago(600), requestId: '644701781058-dddddddddddddddd', outcome: {},
  });
  const s3 = fakeS3({ [BUCKET]: plan.objects }, plan.bodies);
  const detail = await readPlan(s3, { ...CONFIG, inlineResultPrefix: 'inline_result/' },
                                '644701781058:cmp-WebHosting');
  assert.deepEqual(detail.passrole_writers, []);
  assert.ok(!s3.gets.some((key) => key.startsWith('inline_result/')),
            'the marker bucket was read for a decision that dispatched nothing');
});

test('a result that cannot be read leaves the row unknown rather than failing the page', async () => {
  const requestId = '644701781058-eeeeeeeeeeeeeeee';
  const plan = planFixture('644701781058', 'mirror-lambda-Report', {
    at: ago(600), requestId, outcome: { passrole_dispatch: [SENT('alice')] },
  });
  const s3 = fakeS3({ [BUCKET]: plan.objects, 'opt-solution-markers': [] }, plan.bodies);
  const detail = await readPlan(s3, { ...CONFIG, inlineResultPrefix: 'inline_result/' },
                                '644701781058:mirror-lambda-Report');
  assert.equal(detail.passrole_writers.length, 1);
  assert.equal(detail.passrole_writers[0].state, null);
  assert.equal(detail.passrole_writers[0].retryable, false);
});

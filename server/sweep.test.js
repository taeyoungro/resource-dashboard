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

import {
  changesFromPlan, identityFromConfig, isDigest, planIdFromKey, planPrefixFromId, readPlan,
  requestIdFromMarkerKey, sweep,
} from './sweep.js';

const CONFIG = {
  region: 'us-east-1',
  markerBucket: 'opt-solution-markers',
  stateBucket: 'opt-org-policy-terraform-state',
  inspectorPrefix: 'inspector/',
  applierPrefix: 'applier/',
  planSuffix: 'plan/',
  markerGraceSeconds: 900,
  maxBodiesPerSweep: 200,
};

const NOW = Date.parse('2026-08-03T12:00:00Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

function fakeS3(objects, bodies = {}) {
  return {
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
                     { at, requestId, hasChanges = true, digest, outcome } = {}) {
  const prefix = `${account}/${resource}/plan/`;
  const names = ['tfplan', 'main.tf.json', 'plan.json', 'plan.txt', 'changes.sha256',
                 'request.json'];
  if (outcome) names.push('outcome.json');
  const objects = names.map((n) => ({ key: `${prefix}${n}`, lastModified: at }));
  const bodies = {
    [`${BUCKET}/${prefix}main.tf.json`]: {
      terraform: { backend: { s3: { bucket: BUCKET,
                                    key: `${account}/${resource}/terraform.tfstate` } } },
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
  assert.deepEqual(state.counts, { failed: 0, running: 0, awaiting_decision: 0 });
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

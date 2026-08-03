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

import { changesFromPlan, identityFromConfig, sweep } from './sweep.js';

const CONFIG = {
  region: 'us-east-1',
  markerBucket: 'opt-solution-markers',
  stateBucket: 'opt-org-policy-terraform-state',
  inspectorPrefix: 'inspector/',
  applierPrefix: 'applier/',
  planPrefix: 'plans/',
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
  const s3 = fakeS3(
    { 'opt-solution-markers': [
        { key: 'applier/644701781058-1111111111111111.json', lastModified: ago(30) },
      ],
      'opt-org-policy-terraform-state': [
        { key: 'plans/644701781058-1111111111111111/tfplan', lastModified: ago(600) },
        { key: 'plans/644701781058-1111111111111111/main.tf.json', lastModified: ago(600) },
        { key: 'plans/644701781058-2222222222222222/tfplan', lastModified: ago(300) },
        { key: 'plans/644701781058-2222222222222222/main.tf.json', lastModified: ago(300) },
      ] },
    { 'opt-solution-markers/applier/644701781058-1111111111111111.json':
        { request_id: '644701781058-1111111111111111', decision: 'approve', reviewer: 'kim' },
      'opt-org-policy-terraform-state/plans/644701781058-1111111111111111/main.tf.json': MAIN_TF,
      'opt-org-policy-terraform-state/plans/644701781058-2222222222222222/main.tf.json': MAIN_TF },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  const byId = Object.fromEntries(state.plans.map((p) => [p.request_id, p]));
  assert.equal(byId['644701781058-1111111111111111'].state, 'decided');
  assert.equal(byId['644701781058-2222222222222222'].state, 'awaiting_decision');
  assert.equal(state.counts.awaiting_decision, 1);
  assert.equal(byId['644701781058-2222222222222222'].resource, 'cmp-WebHosting');
});

test('an incomplete plan prefix is reported rather than silently dropped', async () => {
  const s3 = fakeS3(
    { 'opt-org-policy-terraform-state': [
      { key: 'plans/644701781058-3333333333333333/plan.txt', lastModified: ago(60) },
    ] },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans.length, 0);
  assert.match(state.errors[0], /incomplete/);
});

test('newest plan first', async () => {
  const s3 = fakeS3(
    { 'opt-org-policy-terraform-state': [
      { key: 'plans/644701781058-4444444444444444/tfplan', lastModified: ago(9000) },
      { key: 'plans/644701781058-4444444444444444/main.tf.json', lastModified: ago(9000) },
      { key: 'plans/644701781058-5555555555555555/tfplan', lastModified: ago(60) },
      { key: 'plans/644701781058-5555555555555555/main.tf.json', lastModified: ago(60) },
    ] },
    { 'opt-org-policy-terraform-state/plans/644701781058-4444444444444444/main.tf.json': MAIN_TF,
      'opt-org-policy-terraform-state/plans/644701781058-5555555555555555/main.tf.json': MAIN_TF },
  );
  const state = await sweep(s3, CONFIG, { now: NOW });
  assert.equal(state.plans[0].request_id, '644701781058-5555555555555555');
});

test('an empty bucket is an empty answer and not an error', async () => {
  const state = await sweep(fakeS3({}), CONFIG, { now: NOW });
  assert.deepEqual(state.counts, { failed: 0, running: 0, awaiting_decision: 0 });
  assert.deepEqual(state.errors, []);
});

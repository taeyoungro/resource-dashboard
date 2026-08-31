// What a failed container's report may say, and what re-running it is allowed to touch.
//
// The retry is the only way to run a container again without ecs:RunTask, and that is exactly why
// it is acceptable on a login surface: RunTask carries container overrides, so a role holding it
// runs anything as any role it may pass, while re-putting an object starts a FIXED task definition
// with the overrides its own rule composes.
//
// That argument holds only while the set of objects this can re-put is the set that starts a
// container. Widening it by one key - `plan/*` instead of `plan/assess.json` - hands the web tier
// the objects an approval BINDS to, and a tier that can rewrite those can show one plan and apply
// another. Most of this file is about that one key.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TaskFailureError, makeTaskFailures, parseReport, retryTarget } from './taskFailures.js';

const CONFIG = { markerBucket: 'opt-solution-markers', stateBucket: 'opt-org-policy-terraform-state' };
const ACCOUNT = '644701781058';

const REPORT = {
  schema: 1,
  task_arn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task/opt-solution-cluster/abc123`,
  task_definition_arn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/opt-inspector:41`,
  cluster_arn: `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/opt-solution-cluster`,
  stop_code: 'EssentialContainerExited',
  stopped_reason: 'Essential container in task exited',
  stopped_at: '2026-08-31T10:00:00Z',
  exit_codes: [1],
  marker_bucket: 'opt-solution-markers',
  marker_key: `inspector/${ACCOUNT}-a21abcd0ebbaad7e.json`,
};

const target = (over) => retryTarget(parseReport({ ...REPORT, ...over }), CONFIG);

// ---- the fence ----------------------------------------------------------------------------------

test('the four objects that start a container are the four this may re-put', () => {
  for (const key of [`inspector/${ACCOUNT}-a21abcd0ebbaad7e.json`,
                     `applier/${ACCOUNT}-a21abcd0ebbaad7e.json`,
                     `impact/${ACCOUNT}-a21abcd0ebbaad7e.json`,
                     `inline_writer/${ACCOUNT}:${ACCOUNT}-alice.json`]) {
    assert.deepEqual(target({ marker_key: key }),
                     { bucket: 'opt-solution-markers', key }, key);
  }
  assert.deepEqual(
    target({ marker_bucket: CONFIG.stateBucket, marker_key: `${ACCOUNT}/ps-alice/plan/assess.json` }),
    { bucket: CONFIG.stateBucket, key: `${ACCOUNT}/ps-alice/plan/assess.json` },
  );
});

test('the plan artifacts an approval binds to are refused', () => {
  // THE assertion in this file. assess.json is a manifest that says "assess this plan"; these four
  // are what an approval binds to, and a tier that can rewrite them can show one plan and apply
  // another. `plan/*` in the IAM statement or a loosened pattern here would hand over all of them.
  for (const artifact of ['tfplan', 'plan.json', 'plan.txt', 'changes.sha256', 'main.tf.json',
                          'outcome.json', 'request.json', 'impact.json']) {
    assert.equal(
      target({ marker_bucket: CONFIG.stateBucket, marker_key: `${ACCOUNT}/ps-alice/plan/${artifact}` }),
      null, artifact,
    );
  }
  // And the state itself, which is not under plan/ at all.
  assert.equal(
    target({ marker_bucket: CONFIG.stateBucket, marker_key: `${ACCOUNT}/ps-alice/terraform.tfstate` }),
    null,
  );
});

test('a prefix nothing starts a container from is refused', () => {
  // inline_result/ is written by the inline writer and read here; re-putting one would fire no
  // rule and would overwrite a container's own record of what it did.
  for (const key of [`inline_result/${ACCOUNT}:${ACCOUNT}-alice.json`,
                     `something/${ACCOUNT}-a21abcd0ebbaad7e.json`,
                     `${ACCOUNT}-a21abcd0ebbaad7e.json`]) {
    assert.equal(target({ marker_key: key }), null, key);
  }
});

test('a bucket the report names but this process was not started with is refused', () => {
  // The bucket is compared against the CONFIGURED names rather than accepted. The report arrives
  // over the network from a function whose environment somebody else deploys; these two names are
  // the ones this process was started with.
  assert.equal(target({ marker_bucket: 'somebody-elses-bucket' }), null);
  assert.equal(target({ marker_bucket: '' }), null);
});

test('a key that climbs out of its prefix is refused', () => {
  for (const key of ['inspector/../applier/x.json', 'inspector/..%2Fx.json',
                     `inspector/${ACCOUNT}/nested.json`, 'inspector/.json']) {
    assert.equal(target({ marker_key: key }), null, key);
  }
});

test('a task nobody started from an object has nothing to re-put', () => {
  // Legitimate: a task started by hand carries no overrides. The failure is still worth showing;
  // what it loses is the retry.
  assert.equal(target({ marker_key: null, marker_bucket: null }), null);
});

// ---- the report ---------------------------------------------------------------------------------

test('the three fields a marker cannot say survive the parse', () => {
  const parsed = parseReport(REPORT);
  assert.equal(parsed.stop_code, 'EssentialContainerExited');
  assert.equal(parsed.stopped_reason, 'Essential container in task exited');
  assert.deepEqual(parsed.exit_codes, [1]);
});

test('a task that never ran is a valid report', () => {
  // No exit code exists, and that absence is the diagnosis: TaskFailedToStart is an image that
  // would not pull, no capacity, a subnet with no addresses left.
  const parsed = parseReport({
    ...REPORT, stop_code: 'TaskFailedToStart', exit_codes: [], stopped_reason: 'CannotPullContainerError',
  });
  assert.deepEqual(parsed.exit_codes, []);
  assert.equal(parsed.stop_code, 'TaskFailedToStart');
});

test('a body that is not a report is refused rather than rendered', () => {
  for (const bad of [null, 'string', [], 42]) {
    assert.throws(() => parseReport(bad), TaskFailureError, JSON.stringify(bad));
  }
  assert.throws(() => parseReport({ ...REPORT, task_arn: '' }), TaskFailureError);
  assert.throws(() => parseReport({ ...REPORT, task_arn: 'x'.repeat(600) }), TaskFailureError);
  assert.throws(() => parseReport({ ...REPORT, stop_code: 12 }), TaskFailureError);
});

test('exit codes that are not integers are dropped rather than shown', () => {
  const parsed = parseReport({ ...REPORT, exit_codes: [0, null, '1', 3, {}] });
  assert.deepEqual(parsed.exit_codes, [0, 3]);
});

// ---- the store ----------------------------------------------------------------------------------

test('one request that failed three times is one row with a count', () => {
  // The question a person asks is "what is wrong with this request". Three copies of one answer is
  // noise, and a number climbing is a retry loop somebody is driving by hand - worth seeing before
  // they drive it again.
  const store = makeTaskFailures();
  for (const at of [1, 2, 3]) store.record(parseReport(REPORT), at);
  const rows = store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 3);
  assert.equal(rows[0].first_seen, 1);
  assert.equal(rows[0].last_seen, 3);
});

test('two failures with no marker are two rows, because nothing joins them', () => {
  const store = makeTaskFailures();
  store.record(parseReport({ ...REPORT, marker_key: null, task_arn: 'arn:a' }), 1);
  store.record(parseReport({ ...REPORT, marker_key: null, task_arn: 'arn:b' }), 2);
  assert.equal(store.list().length, 2);
});

test('the newest is first and the oldest falls off the end', () => {
  const store = makeTaskFailures({ limit: 2 });
  for (const n of ['a', 'b', 'c']) {
    store.record(parseReport({ ...REPORT, marker_key: `inspector/${n}.json` }), 1);
  }
  assert.deepEqual(store.list().map((r) => r.marker_key),
                   ['inspector/c.json', 'inspector/b.json']);
});

test('a retry is recorded on the row so it does not get pressed twice', () => {
  const store = makeTaskFailures();
  const recorded = store.record(parseReport(REPORT), 1);
  assert.equal(recorded.retried_at, null);
  const marked = store.retried(recorded.id, 'kim', 99);
  assert.equal(marked.retried_at, 99);
  assert.equal(marked.retried_by, 'kim');
  assert.equal(store.get(recorded.id).retried_by, 'kim');
  assert.equal(store.retried('nothing-like-this', 'kim', 99), null);
});

test('a fresh report about a request already retried keeps that it was', () => {
  // The retry ran, the task failed again, and the row has to say both - otherwise the person who
  // pressed it sees an untouched failure and presses it again.
  const store = makeTaskFailures();
  const first = store.record(parseReport(REPORT), 1);
  store.retried(first.id, 'kim', 2);
  const again = store.record(parseReport(REPORT), 3);
  assert.equal(again.retried_by, 'kim');
  assert.equal(again.attempts, 2);
});

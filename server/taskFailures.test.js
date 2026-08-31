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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('stoppedAt answers when ECS said the task stopped, not when we heard', () => {
  // The two differ whenever delivery was retried or the dashboard restarted, and the question the
  // caller is asking - is this newer than the marker's last write - is about the TASK, not about us.
  const store = makeTaskFailures();
  store.record(parseReport(REPORT), Date.parse('2026-08-31T10:05:00Z'));
  assert.equal(store.stoppedAt(REPORT.marker_key), Date.parse('2026-08-31T10:00:00Z'));

  // No usable stoppedAt in the event: fall back to when this process was told. Losing five minutes
  // of precision is not the same as losing the fact.
  const blind = makeTaskFailures();
  blind.record(parseReport({ ...REPORT, stopped_at: null }), 12345);
  assert.equal(blind.stoppedAt(REPORT.marker_key), 12345);
  const junk = makeTaskFailures();
  junk.record(parseReport({ ...REPORT, stopped_at: 'not a time' }), 999);
  assert.equal(junk.stoppedAt(REPORT.marker_key), 999);
});

test('a marker nothing has been reported about answers null, not zero', () => {
  // Null is "nothing is known"; 0 is a timestamp in 1970 that would beat every marker write and
  // turn every unreported marker into a confirmed failure.
  const store = makeTaskFailures();
  assert.equal(store.stoppedAt('inspector/nothing-like-this.json'), null);
  store.record(parseReport(REPORT), 1);
  assert.equal(store.stoppedAt('inspector/still-not-this.json'), null);
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

// ---- across a restart ---------------------------------------------------------------------------
//
// Every deploy is a restart, and there have been several in a day. Losing the reason on each one
// meant the panel emptied while the markers it explains stayed exactly where they were - a screen
// that says a task did not finish and can no longer say why.
//
// The FACT is not at stake and never was: the marker is in S3 and the sweep finds it. What is
// written here is the sentence beside it.

const scratch = () => mkdtempSync(join(tmpdir(), 'task-failures-'));
const file = (dir) => join(dir, 'task-failures.json');

test('what one process was told, the next one still knows', () => {
  const dir = scratch();
  const first = makeTaskFailures({ dir });
  first.record(parseReport(REPORT), 1000);
  first.retried(REPORT.marker_key, 'kim', 2000);

  const second = makeTaskFailures({ dir });
  const rows = second.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stop_code, 'EssentialContainerExited');
  assert.deepEqual(rows[0].exit_codes, [1]);
  assert.equal(rows[0].retried_by, 'kim', 'who pressed it is the half somebody is answerable for');
  assert.equal(rows[0].retried_at, 2000);
  // And the classifier's input survives, which is the point: without it the marker goes back to
  // being judged by age alone and a container known to be dead reads as running again.
  assert.equal(second.stoppedAt(REPORT.marker_key), Date.parse(REPORT.stopped_at));
});

test('the newest is still first after a restart, and the cap still holds', () => {
  const dir = scratch();
  const first = makeTaskFailures({ dir, limit: 2 });
  for (const [n, at] of [['a', 1], ['b', 2], ['c', 3]]) {
    first.record(parseReport({ ...REPORT, marker_key: `inspector/${n}.json` }), at);
  }
  const second = makeTaskFailures({ dir, limit: 2 });
  assert.deepEqual(second.list().map((r) => r.marker_key),
                   ['inspector/c.json', 'inspector/b.json']);
});

test('with nowhere to write, everything behaves exactly as it did', () => {
  // A developer running this from a checkout, and every test above. The unit is what provisions a
  // directory, so no directory means no file and no attempt at one.
  const store = makeTaskFailures({});
  store.record(parseReport(REPORT), 1);
  assert.equal(store.list().length, 1);
  assert.equal(makeTaskFailures({}).list().length, 0);
});

test('a file this cannot read costs the sentence, never the startup', () => {
  // A truncated write, a half-full disk, a version of this code that wrote a different shape. The
  // dashboard must come up: the markers are the facts and they are in S3, so refusing to boot over
  // a scratch file would trade a lost sentence for a lost screen.
  for (const contents of ['', 'not json at all', '[]', '{"schema":99,"entries":[]}',
                          '{"schema":1,"entries":"nope"}', '{"schema":1,"entries":[null,3,{}]}']) {
    const dir = scratch();
    writeFileSync(file(dir), contents);
    const store = makeTaskFailures({ dir });
    assert.equal(store.list().length, 0, `${contents} should start empty, not throw`);
    // And it recovers: the next report is recorded and saved over the bad file.
    store.record(parseReport(REPORT), 1);
    assert.equal(makeTaskFailures({ dir }).list().length, 1, contents);
  }
});

test('one unreadable row costs that row and not the rest of the file', () => {
  const dir = scratch();
  const good = makeTaskFailures({ dir });
  good.record(parseReport(REPORT), 1);
  const held = JSON.parse(readFileSync(file(dir), 'utf8'));
  // A row with no id, and one with no last_seen. Neither can be placed or ordered.
  held.entries.push({ stop_code: 'OhNo' }, { id: 'x', last_seen: 'yesterday' });
  writeFileSync(file(dir), JSON.stringify(held));
  assert.equal(makeTaskFailures({ dir }).list().length, 1);
});

test('a write that fails does not reach the caller', () => {
  // The report is already in memory and the marker is already in S3. Refusing the notifier over a
  // full disk would turn a lost sentence into a lost fact and fill the dead-letter queue doing it.
  const warnings = [];
  const store = makeTaskFailures({
    dir: join(scratch(), 'no', 'such', 'directory'),
    log: { warn: (...args) => warnings.push(args), info: () => {} },
  });
  const recorded = store.record(parseReport(REPORT), 1);
  assert.equal(recorded.attempts, 1, 'the report was accepted');
  assert.equal(store.list().length, 1);
  assert.ok(warnings.length > 0, 'a disk that cannot be written to is worth saying out loud');
});

test('a file holding more than the limit is trimmed on the way in', () => {
  // Not covered by writing through a capped store: that store trims before it saves, so the file
  // never holds more than the limit and a load that ignored the cap would look correct. A file can
  // be larger than the limit for a real reason - the limit was lowered - and an unbounded load
  // would then quietly restore a list this process has been configured not to keep.
  const dir = scratch();
  writeFileSync(file(dir), JSON.stringify({
    schema: 1,
    entries: [1, 2, 3, 4, 5].map((n) => ({
      id: `inspector/${n}.json`, marker_key: `inspector/${n}.json`,
      task_arn: `arn:${n}`, last_seen: n, first_seen: n, attempts: 1,
    })),
  }));
  const store = makeTaskFailures({ dir, limit: 2 });
  assert.deepEqual(store.list().map((r) => r.marker_key),
                   ['inspector/5.json', 'inspector/4.json']);
});

test('a file written by a version this does not understand is not read', () => {
  // With a real row in it, so the check is doing something. A future version could store a shape
  // these fields do not describe, and half-reading it would put values on the screen that mean
  // something else - worse than the empty list a person can explain.
  const dir = scratch();
  writeFileSync(file(dir), JSON.stringify({
    schema: 99,
    entries: [{ id: 'inspector/future.json', marker_key: 'inspector/future.json',
                task_arn: 'arn:future', last_seen: 1, first_seen: 1, attempts: 1 }],
  }));
  assert.equal(makeTaskFailures({ dir }).list().length, 0);
});

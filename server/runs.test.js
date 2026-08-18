// That a detached run cannot lose an answer, serve a stale one, or take the process down.
//
// The store exists because the analysis used to run inside its own HTTP request and got a 504 for
// it. Moving the work out of the request buys a new set of ways to be wrong - a rejection nobody
// catches, an answer about a replaced assessment, a run that is started twice - and these are them.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DONE, FAILED, RUNNING, asJson, runStore } from './runs.js';

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** Wait for the detached task to settle. It runs on the microtask queue, not on a timer. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 1); });

test('a run finishes and keeps its answer', async () => {
  const runs = runStore();
  runs.start('p1', 'k1', async () => ({ ok: true }));
  await settle();
  const entry = runs.get('p1', 'k1');
  assert.equal(entry.state, DONE);
  assert.deepEqual(entry.answer, { ok: true });
  assert.equal(entry.error, null);
});

test('a task that throws is captured onto the entry and never escapes', async () => {
  // The reason this is not just `task()`. An unhandled rejection in a detached promise takes the
  // process down on modern Node, so a model client that throws in the wrong place would stop the
  // dashboard - including the approval routes, which have nothing to do with the analysis.
  const runs = runStore();
  runs.start('p1', 'k1', async () => { throw new Error('AccessDeniedException'); });
  await settle();
  const entry = runs.get('p1', 'k1');
  assert.equal(entry.state, FAILED);
  assert.match(entry.error, /AccessDenied/);
  assert.equal(entry.answer, null);
});

test('asking again while one is in flight joins it instead of starting a second', async () => {
  // Two runs for one plan would be two bills for one question, and the second answer would
  // overwrite the first for no reason anyone could see.
  const runs = runStore();
  let started = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const task = async () => { started += 1; await held; return { ok: true }; };

  const first = runs.start('p1', 'k1', task);
  await settle();                       // the first task has begun and is now parked on `held`
  const second = runs.start('p1', 'k1', task);

  assert.equal(started, 1, 'the model was asked twice for one question');
  assert.equal(first, second, 'the second ask got its own entry');
  assert.equal(first.state, RUNNING);

  release();
  await settle();
  assert.equal(runs.get('p1', 'k1').state, DONE);
});

test('a run about a replaced assessment is not this plan\'s answer', async () => {
  // The assessment can be rewritten while a run is going. The answer that comes back describes the
  // grant as it WAS, and serving it under the new digest would put a stale verdict on a live plan.
  const runs = runStore();
  runs.start('p1', 'k1', async () => ({ ok: true }));
  await settle();
  assert.ok(runs.get('p1', 'k1'));
  assert.equal(runs.get('p1', 'k2'), null);
  // Asked without a key, it comes back with the key stated - the page compares it itself.
  assert.equal(runs.get('p1', null).key, 'k1');
});

test('starting a run for a new assessment replaces the old one', async () => {
  const runs = runStore();
  runs.start('p1', 'k1', async () => ({ which: 'old' }));
  await settle();
  runs.start('p1', 'k2', async () => ({ which: 'new' }));
  await settle();
  assert.equal(runs.get('p1', 'k2').answer.which, 'new');
  assert.equal(runs.get('p1', 'k1'), null);
});

test('progress is reported while the run goes and frozen once it ends', async () => {
  const runs = runStore();
  let report;
  runs.start('p1', 'k1', async (r) => { report = r; r({ batches: 3, done: 1 }); await settle(); return {}; });
  await settle();
  assert.deepEqual(runs.get('p1', 'k1').progress, { batches: 3, done: 1 });
  await settle();
  assert.equal(runs.get('p1', 'k1').state, DONE);
  // A late report from a task that has already returned must not make a finished run look busy.
  report({ batches: 3, done: 3 });
  assert.deepEqual(runs.get('p1', 'k1').progress, { batches: 3, done: 1 });
});

test('finished runs age out and running ones never do', async () => {
  // A run still burning tokens is the only reference to that work. Evicting it would lose the
  // answer being paid for right now, which is the exact failure the store was written to stop.
  const c = clock();
  const runs = runStore({ now: c.now, ttlMs: 1000, max: 10 });
  runs.start('done', 'k', async () => ({}));
  runs.start('busy', 'k', () => new Promise(() => {}));
  await settle();
  c.advance(5000);
  runs.start('other', 'k', async () => ({}));
  await settle();
  assert.equal(runs.get('done', 'k'), null, 'a finished run outlived its age');
  assert.equal(runs.get('busy', 'k').state, RUNNING, 'a running run was evicted');
});

test('the oldest finished run goes when there are too many', async () => {
  const c = clock();
  const runs = runStore({ now: c.now, ttlMs: 1_000_000, max: 2 });
  for (const id of ['a', 'b', 'c']) {
    runs.start(id, 'k', async () => ({}));
    await settle();
    c.advance(10);
  }
  assert.equal(runs.get('a', 'k'), null);
  assert.ok(runs.get('c', 'k'));
  assert.ok(runs.size() <= 2);
});

test('what the page receives carries no task and no error object', async () => {
  const runs = runStore();
  const entry = runs.start('p1', 'k1', async () => ({ secret: true }));
  const shaped = asJson(entry, 1234);
  assert.deepEqual(Object.keys(shaped).sort(),
                   ['elapsed_ms', 'error', 'progress', 'started_at', 'state']);
  assert.equal(shaped.state, RUNNING);
  assert.equal(shaped.elapsed_ms, 1234);
  assert.match(shaped.started_at, /^\d{4}-\d\d-\d\dT/);
  await settle();
});

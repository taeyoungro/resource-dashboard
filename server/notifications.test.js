// What the listener announces, and what this process refuses to believe about it.
//
// The framing that bounds all of this: an announcement is not a state. Holding the ingest key buys
// noise in a panel and nothing else - no plan appears, none disappears, nothing becomes approved,
// and the next sweep reads the buckets and contradicts anything fabricated. These tests pin the
// validation that keeps even the noise well formed.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeNotifications, NotificationError, parse } from './notifications.js';

const REQUEST = '644701781058-1a2b3c4d5e6f7081';

// What event_pipeline code/listener/listener/notify.py sends. Kept as a literal rather than built
// from a helper, because the point is that this file agrees with THAT one.
const ANNOUNCEMENT = {
  schema: 1,
  kind: 'inspector',
  request_id: REQUEST,
  account_id: '644701781058',
  resource: 'cmp-WebHosting',
  request_kind: 'spec_policy',
  marker: { bucket: 'opt-solution-markers', key: `inspector/${REQUEST}.json` },
  task: { arn: 'arn:aws:ecs:us-east-1:718100330247:task/opt-solution-cluster/abc',
          cluster: 'opt-solution-cluster', family: 'opt-inspector' },
  events: { count: 2, first_at: '2026-08-05T09:00:00Z', last_at: '2026-08-05T09:00:07Z',
            names: ['CreatePolicy', 'TagPolicy'] },
  buffer: { reason: 'quiet', held_seconds: 7.0 },
  dispatched_at: '2026-08-05T09:00:12Z',
};

const NOW = Date.parse('2026-08-05T09:00:13Z');

function withChange(path, value) {
  const body = structuredClone(ANNOUNCEMENT);
  const parts = path.split('.');
  const field = parts.pop();
  let node = body;
  for (const part of parts) node = node[part];
  if (value === undefined) delete node[field];
  else node[field] = value;
  return body;
}

function refused(body) {
  try {
    parse(body);
  } catch (err) {
    assert.ok(err instanceof NotificationError, `threw ${err.name}, not NotificationError`);
    return err.message;
  }
  throw new assert.AssertionError({ message: 'accepted an announcement that should be refused' });
}

test("the listener's announcement parses", () => {
  const entry = parse(ANNOUNCEMENT);
  assert.equal(entry.kind, 'inspector');
  assert.equal(entry.request_id, REQUEST);
  assert.equal(entry.resource, 'cmp-WebHosting');
  assert.equal(entry.event_count, 2);
  assert.deepEqual(entry.event_names, ['CreatePolicy', 'TagPolicy']);
  assert.equal(entry.buffer_reason, 'quiet');
  assert.equal(entry.marker_key, `inspector/${REQUEST}.json`);
});

test('a marker key that does not belong to the request is refused', () => {
  // They come from one writer and cannot differ by accident. The panel's value is that its link
  // goes where the row says it goes.
  const other = '644701781058-9999999999999999';
  assert.match(refused(withChange('marker.key', `inspector/${other}.json`)), /but the request is/);
  assert.match(refused(withChange('marker.key', `applier/${REQUEST}.json`)), /but the request is/);
  assert.match(refused(withChange('marker.key', '../../etc/passwd')), /but the request is/);
});

test('an unknown schema is refused rather than read optimistically', () => {
  for (const schema of [2, 0, '1', undefined, null]) {
    assert.match(refused(withChange('schema', schema)), /schema/);
  }
});

test('a request id that is not one is refused', () => {
  for (const bad of ['64470178105-1a2b3c4d5e6f7081', '644701781058-XYZ', '', undefined,
                     '644701781058-1a2b3c4d5e6f708']) {
    assert.ok(refused(withChange('request_id', bad)));
  }
});

test('a kind nothing here handles is refused', () => {
  assert.match(refused(withChange('kind', 'dashboard')), /kind is/);
  assert.match(refused(withChange('kind', 'INSPECTOR')), /kind is/);
});

test('an account or resource that could not be one is refused', () => {
  assert.ok(refused(withChange('account_id', '12345')));
  assert.ok(refused(withChange('resource', 'has space')));
  assert.ok(refused(withChange('resource', 'x'.repeat(129))));
});

test('the optional fields are optional', () => {
  // The applier and the inline writer will announce too, and neither has a buffer or events.
  const bare = {
    schema: 1, kind: 'inspector', request_id: REQUEST, account_id: '644701781058',
    resource: 'cmp-WebHosting', marker: { key: `inspector/${REQUEST}.json` },
  };
  const entry = parse(bare);
  assert.equal(entry.event_count, 0);
  assert.deepEqual(entry.event_names, []);
  assert.equal(entry.task_arn, null);
  assert.equal(entry.buffer_reason, null);
});

test('a body that is not an object is refused', () => {
  for (const bad of [null, undefined, 'a string', 42, ['a', 'list']]) {
    assert.ok(refused(bad));
  }
});

test('event names are capped and non-strings dropped', () => {
  const many = Array.from({ length: 500 }, (_, i) => `Event${i}`);
  const entry = parse(withChange('events.names', [...many, 42, null, { a: 1 }]));
  assert.equal(entry.event_names.length, 20);
  assert.equal(entry.event_count, 2, 'the count is whatever the listener said, not the cap');
});

// ---- the store ----------------------------------------------------------------------------------

/** The same announcement for a different request. The key has to follow the id or parse refuses. */
function forRequest(requestId) {
  return parse({
    ...ANNOUNCEMENT,
    request_id: requestId,
    marker: { ...ANNOUNCEMENT.marker, key: `inspector/${requestId}.json` },
  });
}

test('newest first', () => {
  const store = makeNotifications();
  store.record(forRequest(REQUEST), NOW);
  store.record(forRequest('644701781058-2222222222222222'), NOW + 1000);

  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].request_id, '644701781058-2222222222222222');
  assert.equal(list[1].request_id, REQUEST);
});

test('the same request announced twice is one row, not two', () => {
  // A redelivered SQS message dispatches the same request again. The deterministic marker key
  // absorbs that everywhere else; here it would otherwise read as two pieces of work.
  const store = makeNotifications();
  store.record(parse(ANNOUNCEMENT), NOW);
  const second = store.record(parse(ANNOUNCEMENT), NOW + 60_000);

  assert.equal(store.size(), 1);
  assert.equal(second.repeats, 1);
  assert.equal(second.first_received_at, new Date(NOW).toISOString());
  assert.equal(second.received_at, new Date(NOW + 60_000).toISOString());
});

test('the list is bounded', () => {
  const store = makeNotifications({ limit: 3 });
  for (let i = 0; i < 10; i += 1) {
    store.record(forRequest(`644701781058-${String(i).padStart(16, '0')}`), NOW + i);
  }
  assert.equal(store.size(), 3);
  assert.equal(store.list()[0].request_id, '644701781058-0000000000000009');
});

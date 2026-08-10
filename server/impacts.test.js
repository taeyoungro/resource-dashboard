// The pushed assessment: what is accepted, what is refused, and what the cache promises.
//
// The push is the delivery path for the assessment and it is still not authoritative. Both halves
// are tested here: it has to accept what the querier sends, and losing it entirely has to be
// survivable - which is why the cache is keyed by request id and bounded.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ImpactError, makeImpacts, parse } from './impacts.js';

const REQUEST = '644701781058-1111111111111111';

const GOOD = {
  schema: 1,
  kind: 'impact',
  request_id: REQUEST,
  account_id: '644701781058',
  resource: 'ps-alice',
  impact_sha256: 'a'.repeat(64),
  assessed_at: '2026-08-09T05:00:01Z',
  plan: { bucket: 'opt-org-policy-terraform-state', prefix: '644701781058/ps-alice/plan/' },
  summary: { resources: 47, sensitive_hits: 3, services: ['s3'] },
  impact: { request_id: REQUEST, allowed_resources: ['arn:aws:s3:::a'] },
  body_omitted: false,
};

function refuses(overrides, why) {
  assert.throws(() => parse({ ...GOOD, ...overrides }), ImpactError, why);
}

test('a well formed push parses into every field', () => {
  const entry = parse(GOOD);
  assert.equal(entry.request_id, REQUEST);
  assert.equal(entry.impact_sha256, 'a'.repeat(64));
  assert.equal(entry.plan.prefix, '644701781058/ps-alice/plan/');
  assert.equal(entry.summary.resources, 47);
  assert.equal(entry.body_omitted, false);
  assert.ok(entry.received_at);
});

test('a schema this server does not know is refused rather than read leniently', () => {
  // Reading it on a best-effort basis would mean the page showing fields that may not mean what
  // they are read as.
  refuses({ schema: 2 }, 'a future schema was accepted');
  refuses({ schema: undefined }, 'a missing schema was accepted');
});

test('a push that is not an impact is refused', () => {
  refuses({ kind: 'inspector' }, 'another kind was accepted');
});

test('the request id has to be one', () => {
  for (const value of ['nope', '644701781058-XYZ', '1111111111111111', '']) {
    refuses({ request_id: value }, `request id ${value} was accepted`);
  }
});

test('the digest has to be one', () => {
  for (const value of ['short', 'g'.repeat(64), 'A'.repeat(64)]) {
    refuses({ impact_sha256: value }, `digest ${value} was accepted`);
  }
});

test('the assessment may be omitted only when the push says so', () => {
  // Over the request body limit the querier sends the summary alone. Absent WITHOUT the flag is a
  // different thing - a truncated push - and reading it as "no impact" would be wrong.
  const omitted = parse({ ...GOOD, impact: null, body_omitted: true });
  assert.equal(omitted.impact, null);
  assert.equal(omitted.body_omitted, true);
  refuses({ impact: null, body_omitted: false }, 'a missing assessment was accepted as complete');
  refuses({ impact: undefined }, 'an absent assessment was accepted without the flag');
});

test('a summary is always required, because it is what a row renders from', () => {
  refuses({ summary: undefined }, 'no summary was accepted');
  refuses({ summary: 'lots' }, 'a string summary was accepted');
});

test('a body that is not an object is refused', () => {
  for (const value of [null, 'a string', 42, ['a', 'list']]) {
    assert.throws(() => parse(value), ImpactError, `${JSON.stringify(value)} was accepted`);
  }
});

test('the cache is keyed by request id, not by plan', () => {
  // A plan prefix is overwritten in place by every inspection, so one plan id has many assessments
  // over its life. Keyed by plan id a stale push would overwrite a fresh one.
  const impacts = makeImpacts({ limit: 10 });
  const first = parse(GOOD);
  const second = parse({ ...GOOD, request_id: '644701781058-2222222222222222' });
  impacts.put(first);
  impacts.put(second);
  assert.equal(impacts.size(), 2);
  assert.equal(impacts.get(REQUEST).request_id, REQUEST);
  assert.equal(impacts.get('644701781058-2222222222222222').request_id,
               '644701781058-2222222222222222');
});

test('a miss is null, which means read the object rather than there is no assessment', () => {
  const impacts = makeImpacts();
  assert.equal(impacts.get('644701781058-3333333333333333'), null);
  assert.equal(impacts.has('644701781058-3333333333333333'), false);
});

test('the oldest entry is evicted, and eviction costs one GetObject', () => {
  const impacts = makeImpacts({ limit: 2 });
  for (const n of [1, 2, 3]) {
    impacts.put(parse({ ...GOOD, request_id: `644701781058-${String(n).repeat(16)}` }));
  }
  assert.equal(impacts.size(), 2);
  assert.equal(impacts.get(`644701781058-${'1'.repeat(16)}`), null, 'the oldest survived');
  assert.ok(impacts.get(`644701781058-${'3'.repeat(16)}`), 'the newest was evicted');
});

test('re-pushing the same request refreshes it rather than growing the cache', () => {
  const impacts = makeImpacts({ limit: 2 });
  impacts.put(parse(GOOD));
  impacts.put(parse({ ...GOOD, impact_sha256: 'b'.repeat(64) }));
  assert.equal(impacts.size(), 1);
  assert.equal(impacts.get(REQUEST).impact_sha256, 'b'.repeat(64));
});

test('summaries carry the counts and never the resource ARNs', () => {
  const impacts = makeImpacts();
  impacts.put(parse(GOOD));
  const rows = impacts.summaries();
  assert.equal(rows[REQUEST].summary.resources, 47);
  assert.equal(rows[REQUEST].impact_sha256, 'a'.repeat(64));
  assert.ok(!JSON.stringify(rows).includes('arn:aws:s3:::a'),
            'the plan list would carry every enumerated ARN');
});

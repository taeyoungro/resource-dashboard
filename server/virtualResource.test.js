// That the two evaluators answer the same question the same way.
//
// The arrangement inlinePreview.test.js already uses, for the same reason. The authority is
// event_pipeline/code/generator/virtual_resource.py; it is Python and this is Node, so what they
// share is the fixture. Every probe in server/fixtures/inline-preview.json carries the verdict the
// PYTHON reached over the document the same case pins the bytes of - so this file re-evaluates the
// same document, over the same resource, and demands the same answer.
//
// Regenerate after changing virtual_resource.py:
//
//     cd event_pipeline && python3 scripts/gen_inline_preview_fixture.py
//     npm run check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { composeInline } from './inlinePreview.js';
import {
  DENIED, NOT_DENIED, UNKNOWN, VirtualResourceError, evaluate, evaluateAll, virtualResource,
  wildcardMatch,
} from './virtualResource.js';

const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/inline-preview.json', import.meta.url), 'utf8'),
);

const nestedOf = (c) => {
  const set = new Set(c.nested_actions ?? []);
  return (action) => set.has(action);
};
const createdOf = (c) => {
  const map = c.created_formats ?? {};
  return (action) => map[action] ?? [];
};

const documentOf = (c) => composeInline(c.restrictions, {
  accountId: c.account_id ?? FIXTURES.account_id,
  fenceServices: c.fence_services ?? [],
  nested: nestedOf(c),
  createdFormats: createdOf(c),
});

test('every probe reaches the verdict the container reached', () => {
  let probes = 0;
  for (const c of FIXTURES.cases) {
    const document = documentOf(c);
    for (const probe of c.virtual ?? []) {
      probes += 1;
      const answer = evaluate(document, probe.action, virtualResource({
        arn: probe.arn, tags: probe.tags ?? {}, requestContext: probe.request_context ?? {},
      }));
      const where = `${c.label} / ${probe.label}`;
      assert.equal(answer.outcome, probe.outcome, where);
      assert.equal(answer.sid, probe.sid ?? null, `${where}: which statement decided`);
      assert.deepEqual(answer.missingKeys, probe.missing_keys ?? [], `${where}: missing keys`);
      assert.deepEqual(answer.considered, probe.considered ?? [], `${where}: statements considered`);
    }
  }
  assert.ok(probes >= 10, `only ${probes} probes - the fixture stopped exercising this`);
});

test('the fixtures exercise every verdict the vocabulary has', () => {
  // A fixture set that only pinned DENIED would pass while UNKNOWN was computed wrongly, and
  // UNKNOWN is the one that is easy to get wrong - it is the common case under a closed default.
  const outcomes = new Set(FIXTURES.cases.flatMap((c) => (c.virtual ?? []).map((p) => p.outcome)));
  assert.deepEqual([...outcomes].sort(), [DENIED, NOT_DENIED, UNKNOWN].sort());
});

test('a missing condition key is a question, and a missing tag is an answer', () => {
  // The distinction the whole evaluator turns on. A virtual resource's tag map DESCRIBES the
  // resource, so an absent tag means untagged; its request context does not, so an absent key
  // means nobody said - and under StringNotEquals that is the difference between "denied" and
  // "cannot say", which is the difference between a useful test and a confident wrong answer.
  const tagDoc = composeInline([{ policy: 'p', intent: 'tag_condition', actions: ['s3:DeleteObject'],
                                  tag_key: 'Environment', tag_values: ['production'],
                                  condition_operator: 'StringNotEquals' }], { accountId: '1' });
  const bare = virtualResource({ arn: 'arn:aws:s3:::b' });
  assert.equal(evaluate(tagDoc, 's3:DeleteObject', bare).outcome, DENIED);

  const keyDoc = composeInline([{ policy: 'p', intent: 'key_condition',
                                  actions: ['lambda:CreateFunctionUrlConfig'],
                                  condition_key: 'lambda:FunctionUrlAuthType',
                                  condition_values: ['AWS_IAM'] }], { accountId: '1' });
  const fn = virtualResource({ arn: 'arn:aws:lambda:us-east-1:1:function:f' });
  const silent = evaluate(keyDoc, 'lambda:CreateFunctionUrlConfig', fn);
  assert.equal(silent.outcome, UNKNOWN);
  assert.deepEqual(silent.missingKeys, ['lambda:FunctionUrlAuthType']);
});

test('an outright deny is not softened by an unanswerable one', () => {
  const document = composeInline([
    { policy: 'p', intent: 'key_condition', actions: ['lambda:CreateFunctionUrlConfig'],
      condition_key: 'lambda:FunctionUrlAuthType', condition_values: ['AWS_IAM'] },
    { policy: 'p', intent: 'deny_action', actions: ['lambda:CreateFunctionUrlConfig'] },
  ], { accountId: '1' });
  const answer = evaluate(document, 'lambda:CreateFunctionUrlConfig',
                          virtualResource({ arn: 'arn:aws:lambda:us-east-1:1:function:f' }));
  assert.equal(answer.outcome, DENIED);
});

test('nothing matched and matched-but-did-not-fire are different answers', () => {
  // A NOT_DENIED is only readable if an approver can tell which of the two it is.
  const document = composeInline([{ policy: 'p', intent: 'tag_condition',
                                    actions: ['s3:DeleteObject'], tag_key: 'env',
                                    tag_values: ['prod'], condition_operator: 'StringEquals' }],
                                 { accountId: '1' });
  const untagged = evaluate(document, 's3:DeleteObject',
                            virtualResource({ arn: 'arn:aws:s3:::b' }));
  assert.equal(untagged.outcome, NOT_DENIED);
  assert.deepEqual(untagged.considered, ['AdminDeny1'], 'the statement that matched is not named');

  const elsewhere = evaluate(document, 's3:GetObject', virtualResource({ arn: 'arn:aws:s3:::b' }));
  assert.deepEqual(elsewhere.considered, [], 'a statement was considered for another action');
});

test('the wildcard matcher is built from * alone and folds only what IAM folds', () => {
  // A policy is caller-controlled text, so anything treating [ ] ? or . as syntax would match
  // names it does not spell.
  assert.ok(wildcardMatch('s3:DeleteObject', 's3:Delete*', { foldCase: true }));
  assert.ok(wildcardMatch('s3:deleteobject', 's3:Delete*', { foldCase: true }));
  assert.ok(!wildcardMatch('s3:GetObject', 's3:Delete*', { foldCase: true }));
  assert.ok(!wildcardMatch('s3:DetObject', 's3:[DG]etObject', { foldCase: true }));
  assert.ok(!wildcardMatch('s3:GetObject', 's3:?etObject', { foldCase: true }));
  // ARNs are case sensitive - two buckets whose names differ only in case are two buckets.
  assert.ok(wildcardMatch('arn:aws:s3:::b/x', 'arn:aws:s3:::b/*', { foldCase: false }));
  assert.ok(!wildcardMatch('arn:aws:s3:::B', 'arn:aws:s3:::b', { foldCase: false }));
  // Interior segments are matched in order and without overlap.
  assert.ok(wildcardMatch('abcdef', 'a*c*f', { foldCase: false }));
  assert.ok(!wildcardMatch('abc', 'a*b*c*d', { foldCase: false }));
  assert.ok(!wildcardMatch('ab', 'a*b*b', { foldCase: false }));
});

test('a pattern is not a resource, and a non-ARN is not one either', () => {
  for (const arn of ['arn:aws:lambda:*:*:function:*', 'not-an-arn', undefined]) {
    assert.throws(() => virtualResource({ arn }), VirtualResourceError, String(arn));
  }
});

test('an operator this evaluator does not implement is refused, never guessed', () => {
  const document = { Version: '2012-10-17', Statement: [{
    Sid: 'AdminDeny1', Effect: 'Deny', Action: 's3:GetObject', Resource: '*',
    Condition: { Null: { 'aws:ResourceTag/env': 'true' } },
  }] };
  assert.throws(
    () => evaluate(document, 's3:GetObject', virtualResource({ arn: 'arn:aws:s3:::b' })),
    /Null/,
  );
});

test('there is no ALLOW, and evaluateAll keeps the order asked', () => {
  const document = composeInline([{ policy: 'p', intent: 'deny_action',
                                    actions: ['s3:DeleteBucket', 's3:PutBucketPolicy'] }],
                                 { accountId: '1' });
  const asked = ['s3:PutBucketPolicy', 's3:GetObject', 's3:DeleteBucket'];
  const out = evaluateAll(document, asked, virtualResource({ arn: 'arn:aws:s3:::b' }));
  assert.deepEqual(out.map((v) => v.action), asked);
  assert.deepEqual(out.map((v) => v.outcome), [DENIED, NOT_DENIED, DENIED]);
  assert.ok(!out.some((v) => v.outcome === 'ALLOW'));
});

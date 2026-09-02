// The findings on their way from the analysis that produced them to the diagram that draws them.
//
// THE DEFECT THIS FILE EXISTS FOR: 정책 기반 분석 produced 14 findings, the screen drew every one
// of them, and clicking a resource in the diagram above said 「아직 분석을 돌리지 않았다」. The
// findings never left the analysis panel, because the only path that reported them was the one the
// rules button does not take. Two things had to be true for that sentence to be wrong, and both
// are pinned here: what one answer holds, and how "nobody asked" is told from "nothing fired".
//
//     node --test server/analysisFindings.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { anyAnswered, everyFinding, findingsOfAnswer } from './analysisFindings.js';

const rule = (id) => ({ id, escalationGrade: 'HIGH' });
const model = (id) => ({ id, escalationGrade: 'HIGH', source: 'model' });

test('a rules-only answer holds its rule findings', () => {
  // The case that was lost. 정책 기반 분석 never starts the model, so this is what its answer looks
  // like for as long as nobody presses the other button - and it is a full answer, not a partial
  // one waiting on something.
  const found = findingsOfAnswer({ rule_findings: [rule('X-2'), rule('E-1')] });
  assert.deepEqual(found.map((f) => f.id), ['X-2', 'E-1']);
});

test('both halves travel, and the model half stays marked as the model half', () => {
  const found = findingsOfAnswer({
    rule_findings: [rule('X-2')],
    analysis: { findings: [model('M-1')] },
  });
  assert.deepEqual(found.map((f) => f.id), ['X-2', 'M-1']);
  // The panel draws the two under separate headings and reads the mark to tell them apart.
  assert.equal(found.find((f) => f.id === 'M-1').source, 'model');
  assert.equal(found.find((f) => f.id === 'X-2').source, undefined);
});

test('a discarded model run contributes nothing, and does not take the rules down with it', () => {
  // That run cited an action granted nowhere, so every verdict in it was thrown away. The reviewer
  // is looking at the rule findings alone, and so is the diagram.
  const found = findingsOfAnswer({
    rule_findings: [rule('X-2')],
    analysis: { discarded: true, findings: [model('M-1')] },
  });
  assert.deepEqual(found.map((f) => f.id), ['X-2']);
});

test('a run still writing its model half already reports the rules it finished', () => {
  // The rules are done before the POST returns; the model takes minutes. Waiting for both would
  // leave the diagram empty for the whole of it, over a screen already listing twelve findings.
  const found = findingsOfAnswer({ rule_findings: [rule('X-2')], run: { state: 'running' } });
  assert.deepEqual(found.map((f) => f.id), ['X-2']);
});

test('no answer is null, and an answer that fired nothing is empty - never the same value', () => {
  // The whole point of the module. Collapse these two and the diagram tells a reader who ran an
  // analysis that they did not, or tells one who did not that the resource is clean.
  assert.equal(findingsOfAnswer(null), null);
  assert.deepEqual(findingsOfAnswer({ rule_findings: [] }), []);
});

test('one finding reported by two scopes is one finding', () => {
  // A scoped run is a filter over the same engine, not a different analysis, so the plan scope and
  // the policy's own scope return the same card. Drawn twice it reads as two paths.
  const one = rule('X-2');
  const all = everyFinding({ __plan__: [one, rule('E-1')], 'arn:...:policy/EC2': [one] });
  assert.deepEqual(all.map((f) => f.id), ['X-2', 'E-1']);
});

test('scopes that have not answered contribute nothing to the list', () => {
  assert.deepEqual(everyFinding({ __plan__: null, p: [rule('X-2')] }).map((f) => f.id), ['X-2']);
  assert.deepEqual(everyFinding({ __plan__: null }), []);
  assert.deepEqual(everyFinding(undefined), []);
});

test('one scope answering is enough to have run an analysis', () => {
  // The panel's sentence is about whether the reader has been told anything at all. Somebody who
  // ran 정책 기반 분석 on the whole plan has run one, whatever the per-policy scopes say.
  assert.equal(anyAnswered({ __plan__: [rule('X-2')], p: null }), true);
  assert.equal(anyAnswered({ __plan__: null, p: null }), false);
});

test('an analysis that fired nothing has still been run', () => {
  // The case a count gets wrong, and the reason anyAnswered is not `everyFinding(...).length > 0`.
  // 33 rules over a policy that trips none of them is real news; 「아직 분석을 돌리지 않았다」 over
  // it is not.
  assert.deepEqual(everyFinding({ __plan__: [] }), []);
  assert.equal(anyAnswered({ __plan__: [] }), true);
});

test('nothing reported at all is nothing asked', () => {
  // The state on arriving at a plan: no scope has written a key yet.
  assert.equal(anyAnswered({}), false);
  assert.equal(anyAnswered(undefined), false);
});

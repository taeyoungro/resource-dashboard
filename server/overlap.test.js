// That the two halves are matched on the same ground, and only on the same ground.
//
// Both directions cost something. Too loose and a real model finding is labelled a duplicate of a
// rule that reached somewhere else, and a reader stops looking at it. Too tight and the page shows
// one path twice under two labels at two grades - which is the failure this module was written for,
// measured at twelve of twenty-one candidates on one assessment.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { overlapCount, withOverlap } from './overlap.js';

const candidate = (over = {}) => ({
  id: 'C1',
  policy_id: 'P1',
  target: { type: 'lambda:function', count: 3 },
  steps: [{ capability: 'modify_code', actions: ['lambda:UpdateFunctionCode'] }],
  also_granted: [{ capability: 'invoke', actions: ['lambda:InvokeFunction'] }],
  ...over,
});

const finding = (over = {}) => ({
  id: 'E-3',
  policyId: 'P1',
  escalationGrade: 'HIGH',
  triggerActions: ['lambda:UpdateFunctionCode'],
  targets: [{ type: 'lambda:function' }],
  ...over,
});

test('a rule on the same policy, type and action covers the candidate', () => {
  const [marked] = withOverlap([candidate()], [finding()]);
  assert.deepEqual(marked.already_found_by, [{
    rule: 'E-3', grade: 'HIGH', shared_actions: ['lambda:UpdateFunctionCode'],
  }]);
});

test('an action the candidate reaches only through also_granted still counts as shared', () => {
  // also_granted is how the candidate says "and this grant carries these too". A rule that fired on
  // one of those has reached the same place, and matching only on steps would call it a new finding.
  const [marked] = withOverlap([candidate()],
                               [finding({ triggerActions: ['lambda:InvokeFunction'] })]);
  assert.deepEqual(marked.already_found_by[0].shared_actions, ['lambda:InvokeFunction']);
});

test('the same actions in another policy are not the same finding', () => {
  // Two policies granting the same action are two separate things to restrict, and an approver
  // editing one has not touched the other.
  const marked = withOverlap([candidate()], [finding({ policyId: 'P2' })]);
  assert.equal(marked[0].already_found_by, undefined);
  assert.equal(overlapCount(marked), 0);
});

test('the same policy reaching another resource type is not the same finding', () => {
  const marked = withOverlap([candidate()], [finding({ targets: [{ type: 'ec2:instance' }] })]);
  assert.equal(marked[0].already_found_by, undefined);
});

test('a candidate about the grant matches only a rule that is also about the grant', () => {
  // A targetless candidate is a statement about what the policy allows rather than about what
  // exists. A rule that named a resource type has said something else, even with the actions equal.
  const grantOnly = candidate({ target: null });
  assert.equal(withOverlap([grantOnly], [finding()])[0].already_found_by, undefined);
  const [matched] = withOverlap([grantOnly], [finding({ targets: [] })]);
  assert.equal(matched.already_found_by[0].rule, 'E-3');
});

test('sharing a policy and a type but no action is not a match', () => {
  const marked = withOverlap([candidate()],
                             [finding({ triggerActions: ['lambda:GetFunction'] })]);
  assert.equal(marked[0].already_found_by, undefined);
});

test('every rule that covers a candidate is carried, with its own grade', () => {
  // The grades are kept separate rather than reconciled here. Two rules disagreeing about one path
  // is a fact about the rules, and averaging it away in this module would hide it from the page.
  const [marked] = withOverlap([candidate()], [
    finding(),
    finding({ id: 'D-3', escalationGrade: 'LOW', triggerActions: ['lambda:InvokeFunction'] }),
  ]);
  assert.deepEqual(marked.already_found_by.map((e) => [e.rule, e.grade]),
                   [['E-3', 'HIGH'], ['D-3', 'LOW']]);
});

test('overlap is marked and never filtered', () => {
  // Deliberate. The rule states the path; the model states whether it is reachable HERE. Dropping
  // the candidate would take the second half of that away, and the count below is what the page
  // says instead - not what it silently removed.
  const list = [candidate(), candidate({ id: 'C2', policy_id: 'P9' })];
  const marked = withOverlap(list, [finding()]);
  assert.equal(marked.length, 2);
  assert.equal(overlapCount(marked), 1);
});

test('a candidate or a finding missing its optional lists does not throw', () => {
  const bare = { id: 'C3', policy_id: 'P1', target: null };
  assert.deepEqual(withOverlap([bare], [{ id: 'R-1', policyId: 'P1' }]), [bare]);
});

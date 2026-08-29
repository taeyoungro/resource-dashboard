// What a bucket policy reading looks like on a card, and in what order.
//
// The mapping is a judgement about meaning, so the tests are about meaning too: which readings are
// allowed to look settled, which are not, and what an approver sees first.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { byOpenGrade, byWeight, openGrade, shapeOf } from './bucketPolicyGrade.js';

const reading = (outcome, sameAccount = false, label = 'mirror-a') =>
  ({ outcome, sameAccount, principal: { label, id: label } });

test('a cross-account allow outranks the same-account one, because it is the half we can act on', () => {
  assert.equal(shapeOf(reading('ALLOWED', false)).grade, 'HIGH');
  // Same account: the identity policy alone would have carried it, so this policy added less. Not
  // "safe" - graded lower, and still above everything that grants nothing.
  assert.equal(shapeOf(reading('ALLOWED', true)).grade, 'MEDIUM');
});

test('an unknown account does not lower the grade of an allow', () => {
  // Not knowing which side of the boundary a principal is on is not evidence that it is the cheap
  // side. The allow is a fact either way; only its sufficiency is unknown.
  assert.equal(shapeOf(reading('ALLOWED', null)).grade, 'HIGH');
});

test('only the cross-account silence is an answer', () => {
  // Both halves are required across accounts and this half is absent, so the policy does not carry
  // it. That is a conclusion and it is allowed to look like one.
  const across = shapeOf(reading('SILENT', false));
  assert.equal(across.status, 'CONFIRMED');
  assert.equal(across.grade, 'NONE');

  // In the bucket's own account an identity policy alone suffices, so the resource policy saying
  // nothing settles nothing. Marking this CONFIRMED would print "nothing here" over "cannot say".
  for (const same of [true, null]) {
    const s = shapeOf(reading('SILENT', same));
    assert.equal(s.status, 'NOT_ASSESSABLE', `silence with sameAccount=${same} claimed to be settled`);
  }
});

test('the three silences do not share a title', () => {
  const titles = [false, true, null].map((same) => shapeOf(reading('SILENT', same)).title);
  assert.equal(new Set(titles).size, 3, `the silences read alike: ${titles.join(' | ')}`);
});

test('a statement this does not interpret is never presented as settled', () => {
  const s = shapeOf(reading('UNREADABLE'));
  assert.equal(s.status, 'NOT_ASSESSABLE');
  // And it sorts above the answers inside its grade - an approver who stops reading at the first
  // "NONE" must not have stopped at something that was never judged.
  assert.ok(s.weight < shapeOf(reading('DENIED')).weight);
  assert.ok(s.weight < shapeOf(reading('SILENT', false)).weight);
});

test('a delegation carries no status badge, because the answer is in a policy this never read', () => {
  assert.equal(shapeOf(reading('DELEGATED')).status, null);
  assert.equal(shapeOf(reading('DELEGATED')).grade, 'MEDIUM');
});

test('an outcome this does not know is not graded as nothing', () => {
  // A new outcome added to the evaluator and not to this table must not arrive on screen looking
  // like a clean bill.
  const s = shapeOf(reading('SOMETHING_NEW'));
  assert.equal(s.status, 'NOT_ASSESSABLE');
});

test('the display order is worst first, which the server order is not', () => {
  // Exactly what readPolicy sends: evaluation precedence, so DENIED leads. That is the order in
  // which outcomes win, and the heading over the list says "worst first".
  const sent = [
    reading('DENIED', false, 'denied'),
    reading('UNREADABLE', false, 'unreadable'),
    reading('ALLOWED', false, 'allowed-across'),
    reading('ALLOWED', true, 'allowed-same'),
    reading('CONDITIONAL', false, 'conditional'),
    reading('DELEGATED', false, 'delegated'),
    reading('SILENT', false, 'silent-across'),
  ];
  const order = [...sent].sort(byWeight).map((r) => r.principal.label);
  assert.deepEqual(order, [
    'allowed-across',   // HIGH
    'allowed-same',     // MEDIUM, settled
    'conditional',      // MEDIUM, unsettled conditions
    'delegated',        // MEDIUM, answered elsewhere
    'unreadable',       // NONE, never judged
    'silent-across',    // NONE, does not reach
    'denied',           // NONE, refused outright
  ]);
  assert.notEqual(order[0], sent[0].principal.label, 'the sort left the server order alone');
});

test('the order is total, so the same list reads the same way twice', () => {
  const a = reading('SILENT', false, 'b-role');
  const b = reading('SILENT', false, 'a-role');
  assert.ok(byWeight(a, b) > 0);
  assert.equal(byWeight(a, a), 0);
});

const open = (anyPrincipal, conditionKeys = []) => ({ anyPrincipal, conditionKeys });

test('any principal with no condition is the loudest thing this panel says', () => {
  assert.equal(openGrade(open(true)).grade, 'CRITICAL');
});

test('a condition on an open statement is not counted as public', () => {
  // Grading an org-scoped "*" the same as an unconditioned one teaches an approver to ignore the
  // colour, which costs more than the one it would catch.
  assert.equal(openGrade(open(true, ['aws:PrincipalOrgID'])).grade, 'HIGH');
  // ...and it is not claimed to be narrow either. Only the key names are read.
  assert.match(openGrade(open(true, ['aws:PrincipalOrgID'])).why, /직접 읽어야/);
});

test('a named outside principal is neither of those', () => {
  assert.equal(openGrade(open(false)).grade, 'MEDIUM');
});

test('open statements sort worst first', () => {
  const sorted = [open(false), open(true, ['aws:SourceVpce']), open(true)].sort(byOpenGrade);
  assert.deepEqual(sorted.map((s) => openGrade(s).grade), ['CRITICAL', 'HIGH', 'MEDIUM']);
});

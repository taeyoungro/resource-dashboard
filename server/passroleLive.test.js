// The rule that decides who holds PassRole right now.
//
// The bug it exists for, in one sequence: tag a role, approve the grant, watch the applier tag the
// mirror role and the inline writer write the statement - and the dashboard still says 요청 and
// 미부여. Attach an unrelated tag and it corrects itself, because that causes a new inspection and
// a new snapshot. Meanwhile the holders table is empty, and that table is the only screen that can
// revoke, so a grant visible in the inline policy and on the mirror role's tag could not be taken
// back at all.
//
// Everything below is about keeping the writer's answer and the snapshot in the right order, and
// about the third case - the writer has no answer - which is where an over-eager fix does damage:
// reading "no answer" as "nothing held" removes live grants from the screen and puts the system
// straight back into the state that made them unrevokable.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dispatchesTouching, liveGrants, mirrorRoleFromConfig, namesMirrorRole, writerVerdict,
} from './passroleLive.js';

const ACCOUNT = '718100330247';
const MIRROR = 'mirror-lambda-TestInspectorRunTask2';
const ARN = `arn:aws:iam::${ACCOUNT}:role/${MIRROR}`;
const LOCK = (user) => `inline_writer/${ACCOUNT}:${ACCOUNT}-${user}.json`;
const SENT = (user) => ({ user_name: user, action: 'grant', key: LOCK(user) });
const WROTE = (...arns) => ({ state: 'written', ok: true, passrole_in_force: arns });

const live = (options) => liveGrants({
  snapshot: [], dispatched: [], withdrawals: [], results: new Map(), mirrorRoleName: MIRROR,
  ...options,
});

// ---- the join --------------------------------------------------------------------------------

test('the mirror role name is literal in the generated document', () => {
  // Which is why the join uses it rather than the plan's passrole_target_arn: that output is
  // "(known after apply)" on a role the same plan is creating, and the sweep reads main.tf.json for
  // every row anyway.
  assert.equal(mirrorRoleFromConfig({ resource: { aws_iam_role: { mirror: { name: MIRROR } } } }),
               MIRROR);
  for (const bad of [null, {}, { resource: {} }, { resource: { aws_iam_role: {} } },
                     { resource: { aws_iam_role: { mirror: { name: '  ' } } } }]) {
    assert.equal(mirrorRoleFromConfig(bad), null);
  }
});

test('a role is named by ARN suffix and not by substring', () => {
  assert.ok(namesMirrorRole([ARN], MIRROR));
  // The failure this shape refuses: mirror-lambda-Report is not mirror-lambda-Reporting, and a
  // prefix or substring match would file one role's grant under the other.
  assert.ok(!namesMirrorRole([`arn:aws:iam::${ACCOUNT}:role/${MIRROR}Extra`], MIRROR));
  assert.ok(!namesMirrorRole([`arn:aws:iam::${ACCOUNT}:role/x-${MIRROR}`], MIRROR));
  assert.ok(!namesMirrorRole([], MIRROR));
  assert.ok(!namesMirrorRole([ARN], null));
  // Another account's role of the same name is a different role, and the whole ARN says so.
  assert.ok(namesMirrorRole([`arn:aws:iam::999999999999:role/${MIRROR}`], MIRROR),
            'the suffix is what is matched - the account is the row, not the role');
});

// ---- the three values --------------------------------------------------------------------------

test('only a run that applied a document has an answer', () => {
  assert.equal(writerVerdict(WROTE(ARN), MIRROR), true);
  assert.equal(writerVerdict(WROTE(), MIRROR), false);
  assert.equal(writerVerdict(WROTE(`arn:aws:iam::${ACCOUNT}:role/mirror-other`), MIRROR), false);
  // A run that did not write records the state and leaves the field null. Reading a missing field
  // as "no roles" is the mistake: it would let a failed run revoke every holder on the screen.
  for (const result of [null, { state: 'failed', passrole_in_force: null },
                        { state: 'refused', passrole_in_force: null },
                        { state: 'written' },
                        { state: 'written', passrole_in_force: null }]) {
    assert.equal(writerVerdict(result, MIRROR), null, JSON.stringify(result));
  }
  // The state is checked as well as the field, and not only as a shortcut to it. This tier does
  // not author the record - it reads an object a container wrote - so a record carrying both a
  // non-written state and a list must be read as having no answer rather than as an answer,
  // whichever half of it is wrong.
  assert.equal(writerVerdict({ state: 'failed', passrole_in_force: [ARN] }, MIRROR), null);
  assert.equal(writerVerdict({ state: 'refused', passrole_in_force: [] }, MIRROR), null);
});

// ---- what the screen ends up with ---------------------------------------------------------------

test('a grant made since the inspection is a holder', () => {
  // The reported symptom exactly: the plan was generated before the grant, so its snapshot is
  // empty, and the writer has since put the statement in force.
  const state = live({
    snapshot: [],
    dispatched: [SENT('Taeyoung')],
    results: new Map([[LOCK('Taeyoung'), WROTE(ARN)]]),
  });
  assert.deepEqual(state.holders, ['Taeyoung']);
  assert.deepEqual(state.confirmed, ['Taeyoung'], 'the panel has to be able to say why');
  assert.deepEqual(state.snapshot, [], 'and what the plan itself said is kept, not overwritten');
});

test('a withdrawal the writer carried out takes the person off, before any new inspection', () => {
  const state = live({
    snapshot: ['Taeyoung'],
    dispatched: [{ user_name: 'Taeyoung', action: 'revoke', key: LOCK('Taeyoung') }],
    results: new Map([[LOCK('Taeyoung'), WROTE()]]),
  });
  assert.deepEqual(state.holders, []);
  assert.deepEqual(state.released, ['Taeyoung']);
});

test('what the work order SAID is not read at all - only what the document says', () => {
  // `action` is the instruction and the document is the outcome, and they can differ: a revocation
  // whose run wrote a document still naming the role did not revoke. Deciding on the instruction
  // would report the intention as the result, which is the failure mode this whole record exists
  // to end.
  const state = live({
    snapshot: ['Taeyoung'],
    dispatched: [{ user_name: 'Taeyoung', action: 'revoke', key: LOCK('Taeyoung') }],
    results: new Map([[LOCK('Taeyoung'), WROTE(ARN)]]),
  });
  assert.deepEqual(state.holders, ['Taeyoung'],
                   'a revocation that did not remove the statement was reported as a revocation');
});

test('a run that could not answer leaves the snapshot standing and says so', () => {
  // Both directions. The dangerous one is the second: an empty list from a failed run would take a
  // live grant off the screen and with it the only way to revoke it.
  const failed = new Map([[LOCK('Taeyoung'), { state: 'failed', passrole_in_force: null }]]);
  assert.deepEqual(live({ snapshot: ['Taeyoung'], dispatched: [SENT('Taeyoung')], results: failed })
                     .holders, ['Taeyoung']);
  assert.deepEqual(live({ snapshot: [], dispatched: [SENT('Taeyoung')], results: failed })
                     .holders, []);
  assert.deepEqual(live({ snapshot: ['Taeyoung'], dispatched: [SENT('Taeyoung')], results: failed })
                     .unknown, ['Taeyoung'],
                   'an approver choosing between 재시도 and 회수 decides on this');
});

test('a holder nobody dispatched about keeps the answer the inspector gave', () => {
  // The grant that predates this record entirely, and the ordinary case: one decision names one
  // person and says nothing about anybody else.
  const state = live({
    snapshot: ['alice', 'bob'],
    dispatched: [SENT('bob')],
    results: new Map([[LOCK('bob'), WROTE(ARN)]]),
  });
  assert.deepEqual(state.holders, ['alice', 'bob']);
  assert.deepEqual(state.confirmed, [], 'bob was already in the snapshot - nothing changed');
});

test('without a mirror role name nothing is joined and the snapshot stands', () => {
  // A plan whose generated document could not be read. Guessing here would be inventing an answer
  // about who can pass a role, and the direction it fails in is the destructive one: with no name
  // to match, every ARN fails the comparison, so every dispatched holder reads as revoked and
  // leaves the screen - which takes the only revocation path with it.
  const state = live({
    snapshot: ['alice', 'bob'],
    dispatched: [SENT('bob')],
    results: new Map([[LOCK('bob'), WROTE(ARN)]]),
    mirrorRoleName: null,
  });
  assert.deepEqual(state.holders, ['alice', 'bob'],
                   'an unreadable document revoked a holder off the screen');
  assert.deepEqual(state.confirmed, []);
  assert.deepEqual(state.released, []);
  assert.deepEqual(state.unknown, []);
});

test('a standalone withdrawal is joined through its own record', () => {
  // It has no plan decision behind it, so it appears in no outcome. passrole.json carries the work
  // orders it wrote, which is the only place they exist.
  const state = live({
    snapshot: ['Taeyoung'],
    withdrawals: [{ users: ['Taeyoung'], dispatched: [{ user_name: 'Taeyoung',
                                                       key: LOCK('Taeyoung') }] }],
    results: new Map([[LOCK('Taeyoung'), WROTE()]]),
  });
  assert.deepEqual(state.holders, []);
  assert.deepEqual(state.released, ['Taeyoung']);
});

test('granted, revoked, granted again ends where the document ends', () => {
  // The result object is overwritten by every run of that permission set, so it describes the
  // permission set as it is now rather than as any one decision left it. Two work orders naming
  // the same person therefore agree, and both read the latest truth.
  const state = live({
    snapshot: [],
    dispatched: [SENT('Taeyoung'),
                 { user_name: 'Taeyoung', action: 'revoke', key: LOCK('Taeyoung') }],
    results: new Map([[LOCK('Taeyoung'), WROTE(ARN)]]),
  });
  assert.deepEqual(state.holders, ['Taeyoung']);
});

test('a dispatch record naming nobody, or no work order, is dropped', () => {
  assert.deepEqual(
    dispatchesTouching([SENT('alice'), { key: LOCK('bob') }, { user_name: 'carol' },
                        { user_name: '  ', key: LOCK('x') }, null], null),
    [{ user_name: 'alice', key: LOCK('alice') }],
  );
});

test('the lists are sorted and disjoint where they have to be', () => {
  const state = live({
    snapshot: ['bob', 'alice'],
    dispatched: [SENT('zoe'), SENT('alice'), SENT('bob')],
    results: new Map([
      [LOCK('zoe'), WROTE(ARN)],
      [LOCK('alice'), WROTE()],
      [LOCK('bob'), { state: 'failed', passrole_in_force: null }],
    ]),
  });
  assert.deepEqual(state.holders, ['bob', 'zoe']);
  assert.deepEqual(state.confirmed, ['zoe']);
  assert.deepEqual(state.released, ['alice']);
  // bob's writer failed and bob was already a holder: nothing changed, and the panel says the
  // change is unverified rather than silently reporting the old answer as current.
  assert.deepEqual(state.unknown, ['bob']);
});

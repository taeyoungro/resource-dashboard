// From a finding card to the restriction set - what the block dialog offers and what 적용 does.
//
// The screen half lives in src/components/BlockPath.tsx and is pinned by riskUi.test.js the way
// every component contract is; what THIS file pins is the data half, because it decides two things
// an approver cannot verify by looking: which actions a card puts on the table, and whether
// applying the dialog can silently double- or under-write the shared restriction array.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alreadyRestricted, blockOffer, mergeBlock } from './blockPath.js';

const RULE_FINDING = {
  id: 'E-3',
  source: undefined,
  policyName: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess',
  triggerActions: ['lambda:UpdateFunctionCode'],
  containment: null,
};

const MODEL_FINDING = {
  id: 'M-1',
  source: 'model',
  policyName: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess',
  triggerActions: ['lambda:UpdateFunctionCode', 'lambda:InvokeFunction', 'iam:PassRole'],
  containment: {
    denyActions: ['lambda:UpdateFunctionCode', 'iam:PassRole'],
    notRestrictable: ['iam:PassRole'],
    breaks: '...',
    blockedElsewhere: false,
  },
};

test('a rule finding offers its trigger actions - what made the card appear is what there is to deny', () => {
  assert.deepEqual(blockOffer(RULE_FINDING), [
    { action: 'lambda:UpdateFunctionCode', protected: false },
  ]);
});

test("a model finding offers the verdict's own cut set, not the wider cited one", () => {
  // containment.denyActions is already the model's answer to "what do I deny to cut this path".
  // Offering triggerActions would put lambda:InvokeFunction on the table when the verdict never
  // asked for it - and denying an invoke the path does not need cut is collateral, not containment.
  const offered = blockOffer(MODEL_FINDING);
  assert.deepEqual(offered.map((o) => o.action), ['lambda:UpdateFunctionCode', 'iam:PassRole']);
});

test('a protected action is offered and marked, never silently dropped', () => {
  // The same rule Containment renders by. A list that quietly shrank reads as a shorter answer,
  // and the administrator cannot tell which they are looking at.
  const offered = blockOffer(MODEL_FINDING);
  assert.deepEqual(offered.find((o) => o.action === 'iam:PassRole'), {
    action: 'iam:PassRole', protected: true,
  });
  // Both sources of protection count: the assessment's set and the finding's own notRestrictable.
  const viaAssessment = blockOffer(RULE_FINDING, ['lambda:UpdateFunctionCode']);
  assert.equal(viaAssessment[0].protected, true);
});

test('duplicates collapse and blanks are dropped, in first-seen order', () => {
  const offered = blockOffer({
    triggerActions: ['a:One', 'a:Two', 'a:One', '', null, 'a:Three'],
  });
  assert.deepEqual(offered.map((o) => o.action), ['a:One', 'a:Two', 'a:Three']);
});

const POLICY = 'arn:aws:iam::aws:policy/AWSLambda_FullAccess';
const FN = 'arn:aws:lambda:us-east-1:718100330247:function:testLambda';

test('적용 replaces a prior decision on the same action under ANY intent, and only that', () => {
  // The editor refuses one action in two sections because two statements about one action are a
  // contradiction the wider one wins. A dialog that appended would manufacture exactly that - so
  // the action being written sheds its previous decision, whatever section held it.
  const existing = [
    { policy: POLICY, intent: 'allow_only', actions: ['lambda:UpdateFunctionCode'], resources: [FN] },
    { policy: POLICY, intent: 'deny_only', actions: ['lambda:DeleteFunction'], resources: [FN] },
    { policy: 'other', intent: 'deny_action', actions: ['lambda:UpdateFunctionCode'] },
  ];
  const merged = mergeBlock(existing, POLICY, [
    { policy: POLICY, intent: 'deny_action', actions: ['lambda:UpdateFunctionCode'] },
  ]);
  assert.deepEqual(merged, [
    // Untouched: a different action under the same policy, and the same action under ANOTHER
    // policy - a restriction is keyed by its own policy, and the other block's decision stands.
    { policy: POLICY, intent: 'deny_only', actions: ['lambda:DeleteFunction'], resources: [FN] },
    { policy: 'other', intent: 'deny_action', actions: ['lambda:UpdateFunctionCode'] },
    { policy: POLICY, intent: 'deny_action', actions: ['lambda:UpdateFunctionCode'] },
  ]);
});

test('적용 with nothing prior simply appends', () => {
  const merged = mergeBlock([], POLICY, [
    { policy: POLICY, intent: 'deny_only', actions: ['lambda:UpdateFunctionCode'], resources: [FN] },
  ]);
  assert.equal(merged.length, 1);
});

test('the card can say which offered actions are already in the document', () => {
  const restrictions = [
    { policy: POLICY, intent: 'deny_action', actions: ['lambda:UpdateFunctionCode'] },
  ];
  assert.deepEqual(alreadyRestricted(RULE_FINDING, restrictions), ['lambda:UpdateFunctionCode']);
  assert.deepEqual(alreadyRestricted(RULE_FINDING, []), []);
  // Another policy's identical action does not count - the finding's policy is the key.
  assert.deepEqual(alreadyRestricted(RULE_FINDING, [
    { policy: 'other', intent: 'deny_action', actions: ['lambda:UpdateFunctionCode'] },
  ]), []);
});

// From a finding card to the restriction set - what the block dialog offers and what 적용 does.
//
// The screen half lives in src/components/BlockPath.tsx and is pinned by riskUi.test.js the way
// every component contract is; what THIS file pins is the data half, because it decides two things
// an approver cannot verify by looking: which actions a card puts on the table, and whether
// applying the dialog can silently double- or under-write the shared restriction array.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { alreadyRestricted, blockOffer, containmentState, mergeBlock } from './blockPath.js';

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

// ---- how much of the path this decision actually cuts -------------------------------------------
//
// Beside 확인/미확인 on the card, and answering a different question. That badge says whether the
// judgement is certain; this one says what has been DONE about it. An approver reads both in the
// same row a moment before pressing 승인.

const RULE = {
  policyName: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
  triggerActions: ['ec2:CreateRoute', 'ec2:AuthorizeSecurityGroupIngress'],
};
const deny = (actions, over = {}) => ({
  policy: RULE.policyName, intent: 'deny_action', actions, ...over,
});

test('nothing written is 차단되지 않음, and that is the default a card opens in', () => {
  assert.equal(containmentState(RULE, []), 'none');
  // A restriction on ANOTHER policy is not one on this path.
  assert.equal(containmentState(RULE, [deny(RULE.triggerActions, { policy: 'other' })]), 'none');
});

test('every action denied OUTRIGHT is 완전 차단됨, and only deny_action counts', () => {
  assert.equal(containmentState(RULE, [deny(RULE.triggerActions)]), 'full');

  // The same actions under any other intent is not the same claim. allow_only and deny_only name a
  // list of ARNs, which is a list of what exists TODAY; the condition intents rest on a tag or a
  // request key whose value somebody may be able to choose. Real controls, different promises.
  for (const intent of ['allow_only', 'deny_only', 'tag_condition', 'key_condition']) {
    assert.equal(
      containmentState(RULE, [deny(RULE.triggerActions, { intent })]), 'partial',
      `${intent} was reported as a complete block`,
    );
  }
});

test('some of the actions, or the wrong intent on some, is 일부 차단됨', () => {
  assert.equal(containmentState(RULE, [deny(['ec2:CreateRoute'])]), 'partial');
  // One denied outright and one only conditionally. The path is not cut.
  assert.equal(containmentState(RULE, [
    deny(['ec2:CreateRoute']),
    deny(['ec2:AuthorizeSecurityGroupIngress'], { intent: 'tag_condition' }),
  ]), 'partial');
});

test('a path holding a protected action is never 완전 차단됨, however much is written', () => {
  // The declaration path stays open by design - restricting one of these locks the user out of the
  // pipeline that governs them. Calling that a complete block would promise an administrator
  // something the restriction cannot deliver, which is the same rule Containment renders by.
  const withProtected = {
    policyName: RULE.policyName,
    triggerActions: [...RULE.triggerActions, 'iam:ListRoles'],
  };
  const all = [deny(withProtected.triggerActions)];
  assert.equal(containmentState(withProtected, all, ['iam:ListRoles']), 'partial');
  // And with nothing protected the very same input IS complete - so the cap is the protection, not
  // an accident of the action count.
  assert.equal(containmentState(withProtected, all, []), 'full');
});

test('a model finding is judged on the actions the verdict named, not the wider cited set', () => {
  // blockOffer seeds from containment.denyActions for a model finding, and this has to agree with
  // it - otherwise the badge would demand actions the dialog never offered and could never go green.
  const model = {
    source: 'model',
    policyName: RULE.policyName,
    triggerActions: ['ec2:CreateRoute', 'ec2:DescribeRouteTables'],
    containment: { denyActions: ['ec2:CreateRoute'], notRestrictable: [] },
  };
  assert.equal(containmentState(model, [deny(['ec2:CreateRoute'])]), 'full');
});

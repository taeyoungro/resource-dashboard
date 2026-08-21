// When a service wildcard is the same statement, and the cases where it is not.
//
// The offer this gates is a widening if it is wrong: `athena:*` where the administrator ticked
// eight of eleven denies three actions they did not choose. So both directions are pinned - the
// folds that must be offered, and every shape that must not be.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reaching, serviceFold } from './serviceFold.js';

const ACC = '718100330247';
const CATALOG = `arn:aws:athena:us-east-1:${ACC}:datacatalog/AwsDataCatalog`;
const WORKGROUP = `arn:aws:athena:us-east-1:${ACC}:workgroup/primary`;

const CATALOG_ACTIONS = ['athena:CreateDataCatalog', 'athena:DeleteDataCatalog',
                         'athena:GetDataCatalog', 'athena:UpdateDataCatalog'];
const WORKGROUP_ACTIONS = ['athena:GetWorkGroup', 'athena:UpdateWorkGroup'];

const GROUPS = [
  { service: 'athena', resource_type: 'athena:datacatalog', actions: CATALOG_ACTIONS,
    resources: [{ arn: CATALOG }] },
  { service: 'athena', resource_type: 'athena:workgroup', actions: WORKGROUP_ACTIONS,
    resources: [{ arn: WORKGROUP }] },
];

// What AmazonAthenaFullAccess grants, expanded - the account-level ones included, because they are
// part of the service and the NotResource form has to account for them.
const GRANTED = [...CATALOG_ACTIONS, ...WORKGROUP_ACTIONS,
                 'athena:ListDataCatalogs', 'athena:ListWorkGroups'];

const fold = (over) => serviceFold({
  actions: CATALOG_ACTIONS, resources: [CATALOG], intent: 'deny_only',
  groups: GROUPS, granted: GRANTED, ...over,
});

test('a Resource statement folds once every action that reaches those ARNs is held', () => {
  // The whole point. IAM applies a statement only when the Action AND the Resource match, so every
  // athena action the wildcard adds either reaches a different type or names no resource - and
  // neither matches a datacatalog ARN.
  const folded = fold();
  assert.equal(folded.wildcard, 'athena:*');
  assert.equal(folded.covers, 4);
  // What joins is shown, not hidden. An administrator agreeing to a wildcard should see it.
  assert.deepEqual(folded.adds,
                   ['athena:GetWorkGroup', 'athena:ListDataCatalogs', 'athena:ListWorkGroups',
                    'athena:UpdateWorkGroup']);
});

test('one action short of the reachable set does not fold', () => {
  // The failure this gate exists for: eight of eleven ticked, and the wildcard denies the other
  // three. That is a widening the administrator did not ask for.
  assert.equal(fold({ actions: CATALOG_ACTIONS.slice(1) }), null);
});

test('the reachable set is the ARNs named, not every group in the assessment', () => {
  // A group whose resources this statement does not name contributes nothing - its actions cannot
  // be denied by a Resource list that does not hold its ARNs. Requiring them would refuse every
  // legitimate fold on a multi-type service.
  assert.deepEqual([...reaching([CATALOG], GROUPS)].sort(), [...CATALOG_ACTIONS].sort());
  assert.deepEqual([...reaching([CATALOG, WORKGROUP], GROUPS)].sort(),
                   [...CATALOG_ACTIONS, ...WORKGROUP_ACTIONS].sort());
  // Naming both ARNs therefore needs both types' actions in hand.
  assert.equal(fold({ resources: [CATALOG, WORKGROUP] }), null);
  assert.ok(fold({ resources: [CATALOG, WORKGROUP],
                   actions: [...CATALOG_ACTIONS, ...WORKGROUP_ACTIONS] }));
});

test('a NotResource statement needs the whole service, not only what reaches the ARNs', () => {
  // Bounded by nothing. athena:* with NotResource denies every athena action everywhere except on
  // the kept list - including the ones that name no resource, which the kept list can never hold.
  assert.equal(fold({ intent: 'allow_only' }), null);
  const whole = fold({ intent: 'allow_only', actions: GRANTED });
  assert.equal(whole.wildcard, 'athena:*');
  // Nothing joins: the fold covers everything the policy grants.
  assert.deepEqual(whole.adds, []);
});

test('a tag condition is never folded', () => {
  // The condition tests a resource's tag. The wildcard reaches actions that carry no resource and
  // therefore no tag, and what a tag condition does to those is not something this can establish.
  assert.equal(fold({ intent: 'tag_condition', actions: GRANTED }), null);
});

test('a list spanning two services has no wildcard that means it', () => {
  assert.equal(fold({ actions: [...CATALOG_ACTIONS, 's3:GetObject'] }), null);
  // And "*" across both is the one that denies the baseline, so it is never a candidate.
  assert.equal(fold({ actions: ['s3:GetObject', 'ec2:StopInstances'] }), null);
});

test('an action list that is already a wildcard is left alone', () => {
  // Folding a fold would hide what it covers behind a shape that looks identical.
  assert.equal(fold({ actions: ['athena:*'] }), null);
  assert.equal(fold({ actions: ['athena:Get*'] }), null);
});

test('nothing to fold is null rather than an empty offer', () => {
  assert.equal(fold({ actions: [] }), null);
  // No group holds these ARNs, so nothing is established about what reaches them.
  assert.equal(fold({ resources: ['arn:aws:athena:us-east-1:1:datacatalog/other'] }), null);
});

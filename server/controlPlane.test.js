// Telling the pipeline's own resources apart from the account's, WITHOUT reading meaning into a
// name. Every match here is against a value this deployment was configured with; the test that
// matters most is the last one, which pins that a plausible-looking name nobody configured is not
// matched.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLES, controlPlane } from './controlPlane.js';

const ACCOUNT = '718100330247';
const CONFIG = {
  markerBucket: 'opt-solution-markers',
  stateBucket: 'opt-org-policy-terraform-state',
  inlineStateBucket: 'opt-inlinepolicy-terraform',
  approvalTable: 'opt-approval-store',
  lockTable: 'opt-tf-state-lock',
  eventQueue: 'opt-iam-event-queue',
  cluster: 'opt-solution-cluster',
  solutionPrefix: 'opt-',
  mirrorPrefix: 'mirror-',
  specPolicyPrefix: 'cmp-',
  controlPlaneArns: [],
};

const arn = {
  approval: `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/opt-approval-store`,
  lock: `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/opt-tf-state-lock`,
  orders: `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/prod-orders`,
  state: 'arn:aws:s3:::opt-org-policy-terraform-state',
  inline: 'arn:aws:s3:::opt-inlinepolicy-terraform',
  queue: `arn:aws:sqs:us-east-1:${ACCOUNT}:opt-iam-event-queue`,
  cluster: `arn:aws:ecs:us-east-1:${ACCOUNT}:cluster/opt-solution-cluster`,
  applierRole: `arn:aws:iam::${ACCOUNT}:role/opt-SolutionApplier`,
  mirrorRole: `arn:aws:iam::${ACCOUNT}:role/mirror-lambda-report`,
  userRole: `arn:aws:iam::${ACCOUNT}:role/lambda-report`,
  instance: `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/i-0e439b855ef55dea0`,
};

test('the resources this deployment is configured with are recognised, by kind', () => {
  const cp = controlPlane(CONFIG);
  assert.equal(cp.classify(arn.approval), ROLES.APPROVAL_STORE);
  assert.equal(cp.classify(arn.lock), ROLES.STATE_LOCK);
  assert.equal(cp.classify(arn.state), ROLES.TERRAFORM_STATE);
  assert.equal(cp.classify(arn.inline), ROLES.INLINE_STATE);
  assert.equal(cp.classify(arn.queue), ROLES.EVENT_QUEUE);
  assert.equal(cp.classify(arn.cluster), ROLES.TASK_CLUSTER);
});

test('names the pipeline issues are its own; names it merely governs are marked apart', () => {
  // opt-* is what the solution creates FOR ITSELF - a write there is a write against the
  // machinery. mirror-*/cmp-* are what it manages ON A USER'S BEHALF, which is a different
  // severity and therefore a different label.
  const cp = controlPlane(CONFIG);
  assert.equal(cp.classify(arn.applierRole), ROLES.PIPELINE_ROLE);
  assert.equal(cp.classify(arn.mirrorRole), ROLES.GOVERNED_ARTIFACT);
});

test('an ordinary workload is not the control plane', () => {
  const cp = controlPlane(CONFIG);
  assert.equal(cp.classify(arn.orders), null);
  assert.equal(cp.classify(arn.userRole), null);
  assert.equal(cp.classify(arn.instance), null);
  assert.equal(cp.classify(''), null);
  assert.equal(cp.classify(null), null);
});

test('a name that merely LOOKS like the pipeline is not matched', () => {
  // The whole point of matching configuration rather than a pattern. A customer table called
  // "approval-store", or one called "opt-approval-store" in a deployment configured with another
  // name, must not be graded as the governance store - the inference would be wrong exactly where
  // it matters, in somebody else's account.
  const renamed = controlPlane({ ...CONFIG, approvalTable: 'acme-approvals' });
  assert.equal(renamed.classify(arn.approval), null,
               'matched a name this deployment was not configured with');
  assert.equal(
    renamed.classify(`arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/acme-approvals`),
    ROLES.APPROVAL_STORE,
  );
  const cp = controlPlane(CONFIG);
  assert.equal(cp.classify(`arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/approval-store`), null);
});

test('an operator can declare what no configuration can name, and it wins', () => {
  // An EC2 instance carries no name this deployment set, so the machines running the listener and
  // the dashboard are declarable only. Taking over one of those takes over the role already
  // attached to it, which is why they are worth naming at all.
  const cp = controlPlane({
    ...CONFIG,
    controlPlaneArns: [`${arn.instance}|listener_host`, arn.orders],
  });
  assert.equal(cp.classify(arn.instance), 'listener_host');
  assert.equal(cp.classify(arn.orders), ROLES.OPERATOR_DECLARED);
  assert.equal(cp.declaredInstances(), 1);
});

test('undeclared instances are reported as undeclared rather than assumed ordinary', () => {
  // The analysis has to be able to say "this account has instances and none was declared, so a
  // role takeover through one of them cannot be ranked" - silence there reads as safety.
  const cp = controlPlane(CONFIG);
  assert.equal(cp.declaredInstances(), 0);
  assert.equal(cp.declaredCount, 0);
});

test('a malformed declaration is ignored rather than matching everything', () => {
  const cp = controlPlane({ ...CONFIG, controlPlaneArns: ['not-an-arn', '', '|label'] });
  assert.equal(cp.declaredCount, 0);
  assert.equal(cp.classify('not-an-arn'), null);
});

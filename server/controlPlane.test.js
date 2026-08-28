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

/** The label alone, for the assertions that are about which resource was recognised. */
function role(cp, value) {
  return cp.classify(value)?.role ?? null;
}

test('the resources this deployment is configured with are recognised, by kind', () => {
  const cp = controlPlane(CONFIG);
  assert.equal(role(cp, arn.approval), ROLES.APPROVAL_STORE);
  assert.equal(role(cp, arn.lock), ROLES.STATE_LOCK);
  assert.equal(role(cp, arn.state), ROLES.TERRAFORM_STATE);
  assert.equal(role(cp, arn.inline), ROLES.INLINE_STATE);
  assert.equal(role(cp, arn.queue), ROLES.EVENT_QUEUE);
  assert.equal(role(cp, arn.cluster), ROLES.TASK_CLUSTER);
  // Every one of these is a configured value, and only a configured or declared basis may move a
  // grade. See findings.js.
  assert.equal(cp.classify(arn.approval).basis, 'configured');
});

test('names the pipeline issues are its own; names it merely governs are marked apart', () => {
  // opt-* is what the solution creates FOR ITSELF - a write there is a write against the
  // machinery. mirror-*/cmp-* are what it manages ON A USER'S BEHALF, which is a different
  // severity and therefore a different label.
  const cp = controlPlane(CONFIG);
  assert.equal(role(cp, arn.applierRole), ROLES.PIPELINE_ROLE);
  assert.equal(role(cp, arn.mirrorRole), ROLES.GOVERNED_ARTIFACT);
});

test('a prefix hit is reported as a prefix hit, so it cannot move a grade', () => {
  // T-4: a grade may not be derived from a name. opt-*/mirror-*/cmp-* are names this pipeline
  // issues, which makes the label worth showing and still makes the match a name match - so the
  // basis says so and findings.js grades on 'configured' and 'declared' only.
  const cp = controlPlane(CONFIG);
  assert.equal(cp.classify(arn.applierRole).basis, 'prefix');
  assert.equal(cp.classify(arn.mirrorRole).basis, 'prefix');
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
  assert.notEqual(role(renamed, arn.approval), ROLES.APPROVAL_STORE,
                  'a name this deployment was not configured with was read as the approval store');
  assert.equal(
    role(renamed, `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/acme-approvals`),
    ROLES.APPROVAL_STORE,
  );
  // It is still a hit, and the difference between the two answers is the whole of T-4. The solution
  // prefix now applies to every service rather than to iam alone - the pipeline writes opt-* names
  // in nine of them - so a table called opt-approval-store IS in the namespace this deployment
  // issues, whatever this deployment calls its own store. What it is not is CONFIGURED, and the
  // basis says which of the two was established: findings.js grades on 'configured' and 'declared',
  // so a name reaches the reader and never the number.
  assert.equal(renamed.classify(arn.approval).basis, 'prefix');
  const cp = controlPlane(CONFIG);
  assert.equal(cp.classify(`arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/approval-store`), null,
               'a name outside the issued namespace was matched anyway');
});

test('the solution prefix is the deployment\'s convention, not IAM\'s', () => {
  // It used to be tested against iam alone, which read the convention as an IAM one. Every name the
  // pipeline writes carries it, and the resources an approver most needs kept apart from a
  // customer's are the ones in the other eight services - the queue that carries every event, the
  // buckets holding terraform state, the stacks that deploy the whole thing.
  const cp = controlPlane(CONFIG);
  for (const [service, name] of [
    ['sqs', 'opt-iam-event-queue'], ['s3', 'opt-org-policy-terraform-state'],
    ['dynamodb', 'opt-tf-state-lock'], ['ecs', 'opt-inspector'],
    ['cloudformation', 'opt-stack-dashboard-host'], ['events', 'opt-IamRoleEvent'],
    ['logs', 'opt-applier'], ['ecr', 'opt-impact'],
  ]) {
    const text = `arn:aws:${service}:us-east-1:${ACCOUNT}:${name}`;
    assert.ok(cp.classify(text), `${service} name in the issued namespace was not recognised`);
  }
  // The other two prefixes stay where they live. mirror-* names roles and cmp-* names customer
  // managed policies; claiming them in another service would assert a namespace nothing issues.
  assert.equal(cp.classify(`arn:aws:s3:us-east-1:${ACCOUNT}:mirror-bucket`), null);
});

test('an operator can declare what no configuration can name, and it wins', () => {
  // An EC2 instance carries no name this deployment set, so the machines running the listener and
  // the dashboard are declarable only. Taking over one of those takes over the role already
  // attached to it, which is why they are worth naming at all.
  const cp = controlPlane({
    ...CONFIG,
    controlPlaneArns: [`${arn.instance}|listener_host`, arn.orders],
  });
  assert.equal(role(cp, arn.instance), 'listener_host');
  assert.equal(cp.classify(arn.instance).basis, 'declared');
  assert.equal(role(cp, arn.orders), ROLES.OPERATOR_DECLARED);
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

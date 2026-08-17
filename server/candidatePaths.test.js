// The candidate graph: what code proposes before a model is asked anything.
//
// The six paths a previous analysis found are the fixture. Each is reproduced here from the digest
// alone, and each test says which property of the graph it depends on - because every one of them
// was lost at least once while this was being built, and always to a reduction that looked safe.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAP, capabilitiesOf } from './capabilities.js';
import { OUTCOME, candidates, citedActions } from './candidatePaths.js';
import { condense } from './riskDigest.js';
import { controlPlane } from './controlPlane.js';

const ACCOUNT = '718100330247';
const CP = controlPlane({
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
});

function arn(service, type, name) {
  return `arn:aws:${service}:us-east-1:${ACCOUNT}:${type}/${name}`;
}

function group(type, actions, resources, over = {}) {
  return {
    service: type.split(':')[0],
    resource_type: type,
    actions,
    scope: '*',
    total: resources.length,
    truncated: false,
    sensitive_hits: 0,
    attribution: 'resource_type',
    resources: resources.map((a) => ({ arn: a, region: 'us-east-1', tags: {}, sensitive: false })),
    ...over,
  };
}

function digestOf(policies, over = {}) {
  return condense({
    schema: 1,
    request_id: `${ACCOUNT}-1111111111111111`,
    account_id: ACCOUNT,
    resource: 'ps-alice',
    kind: 'ps_role',
    protected_actions: [],
    policies,
    action_reference: { services: {} },
    coverage: { complete: true, services_failed: [], truncated_groups: [], policies_unreadable: [] },
    ...over,
  }, { controlPlane: CP, ruleActions: new Set(), rulesSha256: 'r'.repeat(64),
       impactSha256: 'i'.repeat(64) });
}

function policy(name, over = {}) {
  return {
    identifier: `arn:aws:iam::aws:policy/${name}`,
    source: 'aws_managed',
    default_version_id: 'v1',
    is_baseline: false,
    restrictable: true,
    unreadable: null,
    actions_granted: [],
    actions_offerable: [],
    actions_non_restrictable: [],
    affected: [],
    ...over,
  };
}

// ---- the six paths ---------------------------------------------------------------------------

test('AP-1: item writes on the pipeline own store are a control-plane write, not a table write', () => {
  // No shipped rule names dynamodb:PutItem. The finding exists because the capability table knows
  // what an item write IS, and because the store is identified by configuration.
  const acts = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'];
  const d = digestOf([policy('AmazonDynamoDBFullAccess', {
    actions_granted: ['dynamodb:*'], actions_offerable: acts,
    affected: [group('dynamodb:table', acts,
                     [arn('dynamodb', 'table', 'opt-approval-store'),
                      arn('dynamodb', 'table', 'prod-orders')])],
  })]);
  const found = candidates(d).filter((c) => c.outcome === OUTCOME.CONTROL_PLANE_WRITE);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].control_plane.map((h) => h.role), ['approval_store']);
  assert.deepEqual(found[0].steps[0].actions.sort(), acts.slice().sort());
});

test('AP-1 negative: the same actions on an ordinary table propose no control-plane write', () => {
  // The edge is control-plane only, and "control plane" is configuration, not a name. Without
  // this, every table write in the account would rank as governance subversion.
  const acts = ['dynamodb:PutItem'];
  const d = digestOf([policy('AmazonDynamoDBFullAccess', {
    actions_granted: ['dynamodb:*'], actions_offerable: acts,
    affected: [group('dynamodb:table', acts, [arn('dynamodb', 'table', 'prod-orders')])],
  })]);
  assert.equal(candidates(d).filter((c) => c.outcome === OUTCOME.CONTROL_PLANE_WRITE).length, 0);
});

test('AP-2: stop + rewrite what boots + start is one candidate, from ONE unit', () => {
  // The path that needs no iam:PassRole. It only exists if the three stay on one resource type.
  const acts = ['ec2:StopInstances', 'ec2:ModifyInstanceAttribute', 'ec2:StartInstances'];
  const d = digestOf([policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:*'], actions_offerable: acts,
    affected: [group('ec2:instance', acts, [arn('ec2', 'instance', 'i-0aaa')])],
  })]);
  const found = candidates(d).find((c) => c.edge === 'takeover-boot');
  assert.ok(found, 'the boot-rewrite takeover was not proposed');
  assert.equal(found.outcome, OUTCOME.CREDENTIALS_OF);
  assert.equal(found.target.type, 'ec2:instance');
  const cited = found.steps.flatMap((s) => s.actions);
  for (const action of acts) assert.ok(cited.includes(action), action);
});

test('AP-2 negative: the same actions split across two resource types propose no takeover', () => {
  // Stop on an instance and a code rewrite on a function is not a takeover of either.
  const d = digestOf([policy('Custom', {
    actions_granted: ['ec2:StopInstances', 'lambda:UpdateFunctionCode'],
    actions_offerable: ['ec2:StopInstances', 'lambda:UpdateFunctionCode'],
    affected: [group('ec2:instance', ['ec2:StopInstances'], [arn('ec2', 'instance', 'i-0aaa')]),
               group('lambda:function', ['lambda:UpdateFunctionCode'],
                     [arn('lambda', 'function', 'f')])],
  })]);
  assert.equal(candidates(d).filter((c) => c.edge === 'takeover-boot').length, 0);
});

test('AP-3: passing a role and creating the thing to run it is one path across two types', () => {
  // The other scope. Requiring both on one unit would find nothing - iam:PassRole names a role and
  // lambda:CreateFunction names a function.
  const acts = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction'];
  const d = digestOf([policy('AWSLambda_FullAccess', {
    actions_granted: acts, actions_offerable: acts,
    affected: [group('lambda:function', ['lambda:CreateFunction', 'lambda:InvokeFunction'],
                     [arn('lambda', 'function', 'testLambda')])],
  })]);
  const found = candidates(d).find((c) => c.edge === 'pass-and-run');
  assert.ok(found);
  assert.equal(found.outcome, OUTCOME.CODE_EXECUTION_AS);
  assert.ok(found.also_granted.flatMap((s) => s.actions).includes('iam:PassRole'));
});

test('AP-3 with nothing to create yet: the capability is still proposed, with no target', () => {
  // An account with no functions. The create action reaches nothing, appears in no unit, and the
  // path is still real - so the policy-scope pass proposes it with target null.
  const acts = ['iam:PassRole', 'lambda:CreateFunction'];
  const d = digestOf([policy('AWSLambda_FullAccess', {
    actions_granted: acts, actions_offerable: acts, affected: [],
  })]);
  const found = candidates(d).find((c) => c.edge === 'pass-and-run');
  assert.ok(found, 'a capability with no existing target was dropped');
  assert.equal(found.target, null);
});

test('AP-4: a route or an ingress rule is network exposure, and the small unit carries every ARN', () => {
  const d = digestOf([policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:*'],
    actions_offerable: ['ec2:CreateRoute', 'ec2:AuthorizeSecurityGroupIngress'],
    affected: [group('ec2:route-table', ['ec2:CreateRoute'],
                     [arn('ec2', 'route-table', 'rtb-a'), arn('ec2', 'route-table', 'rtb-b')]),
               group('ec2:security-group', ['ec2:AuthorizeSecurityGroupIngress'],
                     [arn('ec2', 'security-group', 'sg-a')])],
  })]);
  const found = candidates(d).filter((c) => c.outcome === OUTCOME.NETWORK_EXPOSURE);
  assert.equal(found.length, 2);
  const routes = found.find((c) => c.target.type === 'ec2:route-table');
  assert.equal(routes.target.count, 2);
  assert.equal(routes.target.sample_complete, true, 'the ARNs an approver needs were sampled out');
});

test('AP-6: reading roles and policies is egress, and the count travels with it', () => {
  const reads = ['iam:GetRole', 'iam:ListRoles', 'iam:GetPolicyVersion'];
  const d = digestOf([policy('AWSLambda_FullAccess', {
    actions_granted: reads, actions_offerable: [], actions_non_restrictable: reads,
    affected: [group('iam:role', reads,
                     Array.from({ length: 108 }, (_, i) => arn('iam', 'role', `r${i}`)))],
  })]);
  const found = candidates(d).find((c) => c.outcome === OUTCOME.DATA_EGRESS
                                          && c.target?.type === 'iam:role');
  assert.ok(found, 'reconnaissance over 108 roles proposed nothing');
  assert.equal(found.target.count, 108);
});

// ---- the properties the paths depend on -------------------------------------------------------

test('a service granted whole is expanded back through the capability table', () => {
  // The fold that makes the digest small removes action names, and the graph has to see through
  // it: 'iam:*' with nothing enumerated still means a policy can be written onto a principal.
  // Without the expansion a service-wide grant would propose nothing, which is the opposite of
  // what it means.
  const d = digestOf([policy('IAMFullAccess-like', {
    actions_granted: ['iam:*'], actions_offerable: ['iam:ListAccountAliases'], affected: [],
  })]);
  const found = candidates(d);
  assert.ok(found.some((c) => c.edge === 'grant-self'), 'a service-wide grant proposed nothing');
  assert.equal(found.find((c) => c.edge === 'grant-self').target, null);
});

test('an edge that acts on an existing thing proposes nothing when nothing exists', () => {
  // The other half of the same rule. Stopping an instance says nothing on an account with no
  // instances, and proposing it would be noise an approver has to clear - while creating a
  // credential is real whether or not anything is enumerated.
  const d = digestOf([policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:*'], actions_offerable: ['ec2:StopInstances'], affected: [],
  })]);
  assert.equal(candidates(d).filter((c) => c.edge === 'takeover-boot').length, 0);
});

test('a unit whose actions may be a union yields a candidate with the reservation attached', () => {
  const acts = ['ec2:StopInstances', 'ec2:ModifyInstanceAttribute'];
  const d = digestOf([policy('Custom', {
    actions_granted: acts, actions_offerable: acts,
    affected: [group('ec2:instance', acts, [arn('ec2', 'instance', 'i-0aaa')],
                     { scope: 'listed' })],
  })]);
  const found = candidates(d).find((c) => c.edge === 'takeover-boot');
  assert.ok(found, 'the candidate was suppressed rather than qualified');
  assert.ok(found.reservations.some((r) => r.includes('may belong to different')),
            'a possible union was presented as established co-location');
});

test('an unreadable policy anywhere puts a reservation on every candidate', () => {
  const d = digestOf([policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:CreateRoute'], actions_offerable: ['ec2:CreateRoute'],
    affected: [group('ec2:route-table', ['ec2:CreateRoute'], [arn('ec2', 'route-table', 'rtb-a')])],
  })], { coverage: { complete: false, services_failed: [], truncated_groups: [],
                     policies_unreadable: ['opt-IICPSPassRoleAllowlist'] } });
  const [found] = candidates(d);
  assert.ok(found.reservations.some((r) => r.includes('could not be read')));
});

test('every action a candidate cites exists in the digest - the hallucination floor', () => {
  const acts = ['ec2:StopInstances', 'ec2:ModifyInstanceAttribute', 'ec2:StartInstances'];
  const d = digestOf([policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:*'], actions_offerable: acts,
    affected: [group('ec2:instance', acts, [arn('ec2', 'instance', 'i-0aaa')])],
  })]);
  const list = candidates(d);
  const known = new Set(d.grants.flatMap((g) => g.risk_actions));
  for (const action of citedActions(list)) {
    // Anything cited is either written in the digest or covered by a service granted whole.
    const service = action.slice(0, action.indexOf(':'));
    const covered = known.has(action)
      || d.grants.some((g) => (g.complete_services ?? []).includes(service));
    assert.ok(covered, `${action} is cited by a candidate and is not in the digest`);
  }
});

test('candidate ids are stable, so an answer can be cached and cited', () => {
  const acts = ['ec2:StopInstances', 'ec2:ModifyInstanceAttribute'];
  const doc = [policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:*'], actions_offerable: acts,
    affected: [group('ec2:instance', acts, [arn('ec2', 'instance', 'i-0aaa')])],
  })];
  assert.equal(JSON.stringify(candidates(digestOf(doc))),
               JSON.stringify(candidates(digestOf(doc))));
});

test('the baseline proposes nothing - it is not restrictable and not a decision', () => {
  const d = digestOf([policy('IAMFullAccess', {
    is_baseline: true, actions_granted: ['iam:*'], actions_offerable: ['iam:CreateRole'],
  })]);
  assert.equal(candidates(d).length, 0);
});

// ---- the capability table ---------------------------------------------------------------------

test('one action can be two capabilities, and that is what AP-2 rests on', () => {
  // ec2:ModifyInstanceAttribute is configuration for most attributes and CODE for exactly one -
  // userData. Collapsing it to a single value turns the sharpest path in the set into "changed
  // some configuration".
  const { caps, source } = capabilitiesOf('ec2:ModifyInstanceAttribute');
  assert.equal(source, 'curated');
  assert.ok(caps.includes(CAP.MODIFY_CONFIG));
  assert.ok(caps.includes(CAP.MODIFY_CODE));
  // Same shape: changing a function's configuration can change its execution role.
  assert.ok(capabilitiesOf('lambda:UpdateFunctionConfiguration').caps.includes(CAP.REPLACE_IDENTITY));
});

test('a credential behind a Get is curated, because the verb would call it a read', () => {
  assert.equal(capabilitiesOf('sts:GetFederationToken').caps[0], CAP.MINT_CREDENTIAL);
  assert.equal(capabilitiesOf('ecr:GetAuthorizationToken').caps[0], CAP.MINT_CREDENTIAL);
  assert.equal(capabilitiesOf('kms:GenerateDataKey').caps[0], CAP.READ_SECRET);
});

test('an action nobody classified is reported as unmapped, never guessed into a bucket', () => {
  const { caps, source } = capabilitiesOf('quantum:EntangleThing');
  assert.deepEqual(caps, [CAP.UNMAPPED]);
  assert.equal(source, 'unmapped');
  // And a verb match says it is a guess.
  assert.equal(capabilitiesOf('quantum:CreateThing').source, 'verb');
});

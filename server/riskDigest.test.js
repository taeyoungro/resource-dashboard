// The condenser, and the six attack paths it may not destroy.
//
// Every test here is a reduction that would have been reasonable and is wrong. The digest exists
// to make a megabyte assessment askable; what makes it correct is the list of things it refuses to
// leave out, and each of those has a path attached to it that a previous analysis actually found.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SENSITIVE_READS, condense, digestBytes, isRiskAction } from './riskDigest.js';
import { controlPlane } from './controlPlane.js';

const ACCOUNT = '718100330247';

const CP_CONFIG = {
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

// Actions the supplied rule file names. The real set is loaded from finding-rules.json; this is
// the subset the paths below need.
const RULES = new Set([
  'iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction', 'lambda:UpdateFunctionCode',
  'ec2:StopInstances', 'ec2:ModifyInstanceAttribute', 'ec2:StartInstances',
  'ec2:CreateRoute', 'ec2:ReplaceRoute', 'ec2:AuthorizeSecurityGroupIngress',
  'iam:GetRole', 'iam:GetPolicyVersion', 'iam:ListAttachedRolePolicies', 'iam:ListRoles',
]);

function unit(type, actions, over = {}) {
  const n = over.total ?? 3;
  return {
    service: type.split(':')[0],
    resource_type: type,
    actions,
    scope: '*',
    total: n,
    truncated: false,
    sensitive_hits: 0,
    attribution: 'resource_type',
    resources: Array.from({ length: n }, (_, i) => ({
      arn: `arn:aws:${type.split(':')[0]}:us-east-1:${ACCOUNT}:${type.split(':')[1]}/r${i}`,
      region: 'us-east-1', tags: { env: 'prod' }, sensitive: false,
    })),
    ...over,
  };
}

function assessment(policies, over = {}) {
  return {
    schema: 1,
    request_id: `${ACCOUNT}-1111111111111111`,
    account_id: ACCOUNT,
    resource: 'ps-alice',
    kind: 'ps_role',
    permission_set_name: `${ACCOUNT}-alice`,
    protected_actions: ['iam:GetRole', 'iam:GetPolicyVersion', 'iam:ListAttachedRolePolicies',
                        'iam:ListRoles', 'iam:CreateRole'],
    policies,
    action_reference: {
      services: {
        ec2: {
          StopInstances: ['Write', ['instance']],
          StartInstances: ['Write', ['instance']],
          ModifyInstanceAttribute: ['Write', ['instance']],
          DescribeInstances: ['List', []],
          GetConsoleOutput: ['Read', ['instance']],
          CreateRoute: ['Write', ['route-table']],
          AuthorizeSecurityGroupIngress: ['Write', ['security-group']],
          // A mutating action no rule names - the instance-profile swap. It is what the fold
          // covers, and what complete_services has to keep reachable without listing it.
          AssociateIamInstanceProfile: ['Write', ['instance']],
          CreateVolume: ['Write', ['volume']],
        },
        lambda: {
          CreateFunction: ['Write', ['function']],
          InvokeFunction: ['Write', ['function']],
          ListFunctions: ['List', []],
        },
        cloudformation: { DescribeStacks: ['Read', ['stack']], ListStackResources: ['List', []] },
        iam: {
          GetRole: ['Read', ['role']], ListRoles: ['List', []],
          GetPolicyVersion: ['Read', ['policy']], ListAttachedRolePolicies: ['List', ['role']],
          PassRole: ['Write', ['role']],
        },
        dynamodb: { PutItem: ['Write', ['table']], UpdateItem: ['Write', ['table']] },
      },
    },
    coverage: { complete: true, services_failed: [], truncated_groups: [], policies_unreadable: [] },
    ...over,
  };
}

function policy(name, over = {}) {
  return {
    identifier: `arn:aws:iam::aws:policy/${name}`,
    source: 'aws_managed',
    default_version_id: 'v7',
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

const build = (doc, over = {}) => condense(doc, {
  controlPlane: controlPlane({ ...CP_CONFIG, ...(over.cp ?? {}) }),
  ruleActions: RULES,
  rulesSha256: 'r'.repeat(64),
  impactSha256: 'i'.repeat(64),
});

// ---- the paths ------------------------------------------------------------------------------

test('AP-2: three actions on ONE resource type stay on one unit, and say the co-location is sound', () => {
  // Stop + ModifyInstanceAttribute + Start on the same instance takes over the role already
  // attached to it - no iam:PassRole needed. It only reads as a path if the three stay together.
  const acts = ['ec2:StopInstances', 'ec2:ModifyInstanceAttribute', 'ec2:StartInstances',
                'ec2:DescribeInstances'];
  const d = build(assessment([policy('AmazonEC2FullAccess', {
    actions_granted: acts, actions_offerable: acts,
    affected: [unit('ec2:instance', acts, { total: 12 })],
  })]));
  const grant = d.grants[0];
  const instances = grant.units.find((u) => u.t === 'ec2:instance');
  for (const action of acts.slice(0, 3)) {
    assert.ok(instances.acts.includes(grant.risk_actions.indexOf(action)), action);
  }
  assert.equal(instances.colocation, 'sound');
  // The passive one is counted, not listed.
  assert.equal(instances.reads, 1);
  assert.ok(!grant.risk_actions.includes('ec2:DescribeInstances'));
});

test('AP-3: a create action survives even though no resource of its type exists', () => {
  // The half a groups-only digest loses. lambda:CreateFunction reaches nothing in an account with
  // no functions, so it appears in NO unit - and it is half of the PassRole escalation.
  const acts = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction'];
  const d = build(assessment([policy('AWSLambda_FullAccess', {
    actions_granted: acts, actions_offerable: acts, affected: [],
  })], {
    passrole_grants: [{ identifier: 'arn:aws:iam::aws:policy/AWSLambda_FullAccess',
                        services: ['lambda.amazonaws.com'], resources: ['*'],
                        unconditioned: false }],
  }));
  for (const action of acts) assert.ok(d.grants[0].risk_actions.includes(action), action);
  assert.equal(d.grants[0].units.length, 0);
  // And the ceiling travels: which roles may be passed is what the grant is worth.
  assert.deepEqual(d.passrole_grants[0].resources, ['*']);
});

test('AP-6: a unit whose actions are ALL passive is still emitted, because the count is the finding', () => {
  // Reconnaissance from names and counts: 108 roles, 44 policies, 15 stacks - and the reads cannot
  // be restricted. Dropping zero-risk units to save bytes is the natural optimisation that kills it.
  const reads = ['iam:GetRole', 'iam:ListRoles', 'iam:GetPolicyVersion',
                 'iam:ListAttachedRolePolicies'];
  const d = build(assessment([policy('AWSLambda_FullAccess', {
    actions_granted: [...reads, 'cloudformation:DescribeStacks'],
    actions_offerable: ['cloudformation:DescribeStacks'],
    actions_non_restrictable: reads,
    affected: [unit('iam:role', reads, { total: 108 }),
               unit('cloudformation:stack', ['cloudformation:DescribeStacks'], { total: 15 })],
  })]));
  const grant = d.grants[0];
  const stacks = grant.units.find((u) => u.t === 'cloudformation:stack');
  assert.ok(stacks, 'the unit was dropped for having no risk action');
  assert.equal(stacks.n, 15);
  assert.equal(grant.units.find((u) => u.t === 'iam:role').n, 108);
  // The declaration path is carried per policy - "you cannot stop this reading" is about ONE
  // policy, and impact.json's global protected_actions list cannot say which.
  assert.deepEqual(grant.non_restrictable, reads);
});

test('a read a rule names is never collapsed, whatever its access level says', () => {
  // AWS calls iam:ListRoles a List and ec2:GetConsoleOutput a Read. One is the recon leg of an
  // escalation and the other returns whatever the boot log printed.
  const levels = new Map([['ec2', new Map([['GetConsoleOutput', 'Read'],
                                           ['DescribeInstances', 'List']])],
                          ['iam', new Map([['ListRoles', 'List']])]]);
  assert.ok(isRiskAction('iam:ListRoles', { levels, ruleActions: RULES }));
  assert.ok(isRiskAction('ec2:GetConsoleOutput', { levels, ruleActions: new Set() }),
            'a sensitive read was collapsed');
  assert.ok(!isRiskAction('ec2:DescribeInstances', { levels, ruleActions: new Set() }));
  assert.ok(SENSITIVE_READS.has('ec2:GetConsoleOutput'));
});

test('an action the reference does not know is kept, never assumed harmless', () => {
  // The clause that is easy to leave out. An action AWS shipped after the table was built cannot
  // be shown to be a read, and dropping it is the one direction of error this pipeline refuses.
  const levels = new Map([['ec2', new Map([['StopInstances', 'Write']])]]);
  assert.ok(isRiskAction('ec2:SomethingBrandNew', { levels, ruleActions: new Set() }));
  assert.ok(isRiskAction('brandnewservice:DoIt', { levels, ruleActions: new Set() }));
});

// ---- the reductions -------------------------------------------------------------------------

test('a service granted whole is folded, and the fold says more than the names it replaces', () => {
  const many = ['ec2:StopInstances', 'ec2:StartInstances', 'ec2:ModifyInstanceAttribute',
                'ec2:CreateRoute', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:GetConsoleOutput',
                'ec2:AssociateIamInstanceProfile', 'ec2:CreateVolume'];
  const d = build(assessment([policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:*'], actions_offerable: many,
    affected: [unit('ec2:instance', many, { total: 12 })],
  })]));
  const grant = d.grants[0];
  assert.deepEqual(grant.complete_services, ['ec2']);
  // Rule-named actions and sensitive reads stay by name - a rule engine matches exact strings.
  for (const action of ['ec2:StopInstances', 'ec2:CreateRoute', 'ec2:GetConsoleOutput']) {
    assert.ok(grant.risk_actions.includes(action), action);
  }
  // An action the CAPABILITY table knows survives the fold even though no rule names it - the
  // instance-profile swap is a path, and a folded name is a chain that cannot be proposed.
  assert.ok(grant.risk_actions.includes('ec2:AssociateIamInstanceProfile'));
  // One that nothing knows is folded away, and complete_services keeps it reachable.
  assert.ok(!grant.risk_actions.includes('ec2:CreateVolume'));
  assert.ok(grant.complete_services.includes('ec2'));
  // The unit counts what the fold covers rather than going quiet about it.
  assert.equal(grant.units[0].folded, 1);
  // And the fold is recorded, not silent.
  assert.ok(d.budget.dropped.some((entry) => entry.what.includes('ec2') && entry.recoverable));
});

test('a unit whose statement named ARNs is marked as a possible union, not as co-located', () => {
  // The producer unions the actions of every statement into one group keyed by resource type. A
  // policy granting Stop on one instance and Modify on another produces a single unit listing
  // both, and reading that as co-location invents a takeover that does not exist.
  const acts = ['ec2:StopInstances', 'ec2:ModifyInstanceAttribute'];
  const d = build(assessment([policy('Custom', {
    actions_granted: acts, actions_offerable: acts,
    affected: [unit('ec2:instance', acts, { scope: 'listed' })],
  })]));
  assert.equal(d.grants[0].units[0].colocation, 'union');
});

test('truncation is null when unknown and never false, and omitted is always null', () => {
  // A false here silently upgrades a finding's status - the rule file downgrades to
  // NOT_ASSESSABLE on a truncated list. And how many resources were dropped does not exist even
  // upstream: the service does not count matches past its ceiling.
  const d = build(assessment([policy('Custom', {
    actions_granted: ['ec2:StopInstances'], actions_offerable: ['ec2:StopInstances'],
    affected: [unit('ec2:instance', ['ec2:StopInstances'], { truncated: undefined }),
               unit('ec2:volume', ['ec2:StopInstances'], { truncated: true })],
  })]));
  const [first, second] = d.grants[0].units;
  assert.equal(first.truncated, null);
  assert.equal(second.truncated, true);
  assert.equal(first.omitted, null);
});

test('the pipeline own resources are marked on the unit and never sampled out', () => {
  const approval = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/opt-approval-store`;
  const tables = unit('dynamodb:table', ['dynamodb:PutItem'], { total: 12 });
  // Put it last, past the sample cap, so only the never-sampled-out rule can save it.
  tables.resources[11] = { arn: approval, region: 'us-east-1', tags: {}, sensitive: false };
  const d = build(assessment([policy('AmazonDynamoDBFullAccess', {
    actions_granted: ['dynamodb:PutItem'], actions_offerable: ['dynamodb:PutItem'],
    affected: [tables],
  })]));
  const u = d.grants[0].units[0];
  assert.ok(u.sample.includes(approval), 'the control-plane resource was sampled out');
  assert.deepEqual(u.cp, [{ arn: approval, role: 'approval_store' }]);
  assert.equal(u.sample_complete, false);
});

test('a small unit carries every ARN and says so', () => {
  // AP-4 is two route tables and one gateway out of a larger account. Completeness is what makes
  // the sample usable as evidence rather than as an illustration.
  const d = build(assessment([policy('AmazonEC2FullAccess', {
    actions_granted: ['ec2:CreateRoute'], actions_offerable: ['ec2:CreateRoute'],
    affected: [unit('ec2:route-table', ['ec2:CreateRoute'], { total: 2 })],
  })]));
  const u = d.grants[0].units[0];
  assert.equal(u.sample.length, 2);
  assert.equal(u.sample_complete, true);
});

test('item writes survive even though no supplied rule names them', () => {
  // The rule file names PutResourcePolicy, ExportTableToPointInTime, GetRecords, DeleteTable and
  // UpdateTimeToLive for dynamodb - and nothing names PutItem or UpdateItem. Forging an approval
  // item and forging a state lock are both item writes, so the "level is not Read/List" clause is
  // the only thing keeping their evidence in the digest. It is load-bearing.
  const acts = ['dynamodb:PutItem', 'dynamodb:UpdateItem'];
  const d = build(assessment([policy('AmazonDynamoDBFullAccess', {
    actions_granted: acts, actions_offerable: acts,
    affected: [unit('dynamodb:table', acts, { total: 6 })],
  })]));
  for (const action of acts) assert.ok(d.grants[0].risk_actions.includes(action), action);
});

// ---- the fields that must not be dropped ------------------------------------------------------

test('what is already denied travels as context, labelled as replaced', () => {
  // A new decision REPLACES these statements, so nothing here may suppress a finding: a path the
  // current restriction blocks reopens the moment the replacement lands.
  const d = build(assessment([policy('Custom')], {
    current_admin_deny: [{ Sid: 'AdminDeny1', Effect: 'Deny', Action: 'ec2:StopInstances' }],
    inline_sha256: 'a'.repeat(64),
  }));
  assert.equal(d.current_restriction.statements.length, 1);
  assert.match(d.current_restriction.note, /replaced on approval/);
});

test('the trust block travels whole - it is the whole of the mirror domain attack surface', () => {
  const trust = { kinds: ['service'], trusts_only_expected_service: false,
                  public_unconditional: [{ principal: '*' }], organization_unresolved: true };
  const d = build(assessment([policy('Custom')], { trust, mirror_role_name: 'mirror-lambda-x' }));
  assert.deepEqual(d.trust, trust);
  assert.equal(d.meta.mirror_role_name, 'mirror-lambda-x');
});

test('the honesty fields are carried whole, and the account-level list only as a count', () => {
  const d = build(assessment([policy('Custom')], {
    coverage: {
      complete: false,
      services_failed: ['kms'],
      truncated_groups: ['p:ec2:ec2:instance'],
      policies_unreadable: ['opt-IICPSPassRoleAllowlist'],
      actions_unbounded: ['*'],
      actions_unresolved: ['ec2:Whatever'],
      actions_account_level: Array.from({ length: 480 }, (_, i) => `svc:Action${i}`),
      reference: null,
      services_enumerated: {
        ec2: { seen: 12, kept: 12, truncated: false, error: null },
        kms: { seen: 0, kept: 0, truncated: false, error: 'AccessDenied' },
        s3: { seen: 1200, kept: 1000, truncated: true, error: null },
      },
    },
  }));
  assert.deepEqual(d.coverage.actions_unbounded, ['*']);
  assert.deepEqual(d.coverage.policies_unreadable, ['opt-IICPSPassRoleAllowlist']);
  assert.equal(d.coverage.actions_account_level, 480);
  // Only the services with something to say are carried; the clean ones are a count.
  assert.deepEqual(Object.keys(d.coverage.services_enumerated).sort(), ['kms', 's3']);
  assert.equal(d.coverage.services_enumerated_clean, 1);
});

test('the control plane block says what it could not have seen', () => {
  // The enumeration is scoped to the assessed account, so a pipeline deployed elsewhere can never
  // appear - and an empty list would read as "nothing of ours is reachable".
  const d = build(assessment([policy('Custom')]));
  assert.match(d.control_plane.note, /absence is not evidence/);
  assert.equal(d.control_plane.declared_instances, 0);
});

test('the digest names what produced it', () => {
  const d = build(assessment([policy('Custom')]));
  assert.equal(d.meta.source_impact_sha256, 'i'.repeat(64));
  assert.equal(d.meta.rules_sha256, 'r'.repeat(64));
  assert.equal(d.digest_version, 1);
});

test('an assessment written before the newer producer fields is tolerated', () => {
  // The stored artifacts predate passrole_grants and actions_non_restrictable. Absent is not the
  // same as empty for the ceiling: resources null means unknown, not '*'.
  const d = build(assessment([policy('Custom', {
    actions_granted: ['ec2:StopInstances'], actions_offerable: ['ec2:StopInstances'],
    actions_non_restrictable: undefined,
  })], { passrole_grants: [{ identifier: 'x', services: ['lambda.amazonaws.com'] }] }));
  assert.deepEqual(d.grants[0].non_restrictable, []);
  assert.equal(d.passrole_grants[0].resources, null);
});

test('the digest is far smaller than the assessment and is deterministic', () => {
  const many = Array.from({ length: 200 }, (_, i) => `ec2:Action${i}`);
  const doc = assessment([policy('AmazonEC2FullAccess', {
    actions_granted: many, actions_offerable: many,
    affected: [unit('ec2:instance', many, { total: 40 }), unit('ec2:volume', many, { total: 40 })],
  })]);
  const a = build(doc);
  const b = build(doc);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'two runs differ');
  assert.ok(digestBytes(a) < Buffer.byteLength(JSON.stringify(doc), 'utf8') / 2);
});

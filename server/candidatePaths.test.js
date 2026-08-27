// The candidate graph: what code proposes before a model is asked anything.
//
// The six paths a previous analysis found are the fixture. Each is reproduced here from the digest
// alone, and each test says which property of the graph it depends on - because every one of them
// was lost at least once while this was being built, and always to a reduction that looked safe.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CAP, capabilitiesOf, referenceIndex } from './capabilities.js';
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
  const reaches = found.filter((c) => c.target);
  assert.equal(reaches.length, 2);
  const routes = reaches.find((c) => c.target.type === 'ec2:route-table');
  assert.equal(routes.target.count, 2);
  assert.equal(routes.target.sample_complete, true, 'the ARNs an approver needs were sampled out');
  // And the capability, beside them rather than instead of them. ec2:* on this account reaches two
  // route tables today; what it will reach is every route table the account ever has, and only the
  // second of those two sentences is still true after the next subnet is created.
  assert.equal(found.filter((c) => !c.target).length, 1,
               'the capability half is missing on an account that has resources');
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

// ---- the empty account: what a grant means before anything exists ------------------------------
//
// The measured blind spot. With nothing enumerated the digest produces no units, so the unit pass
// runs zero times and only the targetless edges speak. Before this, three of them did - mint,
// pass-and-run, grant-self - which left exactly two of seven outcomes reachable and made the whole
// DATA_EGRESS / NETWORK_EXPOSURE / AUDIT_BLIND family invisible on a new account. That is the
// account where a preventive control is most often asked for, and where the grant is least
// examined.

const EMPTY = (actions) => ({
  account_id: ACCOUNT,
  passrole_grants: [],
  grants: [{ p: 'P1', name: 'X', risk_actions: actions, non_restrictable: [], units: [] }],
});

test('opening something to the outside is real with nothing enumerated - reading it is not', () => {
  // The distinction the per-capability field exists for. s3:PutBucketPolicy says "whatever comes
  // to exist can be published" and is true on day one; s3:GetObject needs the object to be there,
  // and proposing it on an empty account would be noise an approver has to clear.
  const opened = candidates(EMPTY(['s3:PutBucketPolicy', 'lambda:CreateFunctionUrlConfig']));
  const exfiltrate = opened.filter((c) => c.edge === 'exfiltrate');
  assert.equal(exfiltrate.length, 1, 'publishing is invisible on an empty account');
  assert.equal(exfiltrate[0].outcome, OUTCOME.DATA_EGRESS);
  assert.equal(exfiltrate[0].target, null);
  assert.deepEqual(exfiltrate[0].steps.map((s) => s.capability), [CAP.SHARE_EXTERNAL]);

  const read = candidates(EMPTY(['s3:GetObject', 'dynamodb:Scan', 'secretsmanager:GetSecretValue']));
  assert.deepEqual(read, [], 'reading a resource that does not exist was proposed as a path');
  // And the mixed grant proposes the publishing half ALONE - not the reads riding along with it.
  const mixed = candidates(EMPTY(['s3:GetObject', 's3:PutBucketPolicy']));
  assert.deepEqual(mixed.flatMap((c) => c.steps.flatMap((s) => s.actions)),
                   ['s3:PutBucketPolicy']);
});

test('a way into the network, and a blinded audit, need no inventory either', () => {
  const network = candidates(EMPTY(['ec2:CreateInternetGateway',
                                    'ec2:AuthorizeSecurityGroupIngress']));
  assert.deepEqual(network.map((c) => c.outcome), [OUTCOME.NETWORK_EXPOSURE]);
  // Every action on this edge BRINGS the path into being, so the whole edge is targetless - no
  // per-capability split, unlike exfiltrate.
  assert.deepEqual(network[0].steps.map((s) => s.capability).sort(),
                   [CAP.NETWORK_INGRESS, CAP.NETWORK_ROUTE].sort());

  const audit = candidates(EMPTY(['cloudtrail:StopLogging', 'config:StopConfigurationRecorder']));
  assert.deepEqual(audit.map((c) => c.outcome), [OUTCOME.AUDIT_BLIND]);
  // This one was never really a unit finding: what it acts on is account-level audit machinery an
  // index of workload resources does not report, so it was invisible on a FULL account too.
  assert.equal(audit[0].target, null);
});

test('an enumerated account gets BOTH answers: the bucket it reaches, and the capability', () => {
  // Two questions about one grant, and they have different lifetimes. "It can publish this bucket"
  // is answered by a restriction naming that ARN; "it can publish whatever bucket comes to exist"
  // survives the next deployment and is what a preventive control is written for.
  //
  // The capability half used to be suppressed the moment a single resource of the type appeared,
  // so it was askable only on an empty account - which made it look like a special case for new
  // accounts rather than the second half of every answer. Both are proposed now and the pair is
  // told apart by `target`, which is also what files each one into its area on the page.
  const bucket = `arn:aws:s3:::opt-solution-markers`;
  const digest = {
    account_id: ACCOUNT,
    passrole_grants: [],
    grants: [{
      p: 'P1', name: 'X', risk_actions: ['s3:PutBucketPolicy'], non_restrictable: [],
      units: [{ t: 's3:bucket', acts: [0], n: 1, sample: [bucket], truncated: false,
                colocation: 'sound', attribution: 'resource_type' }],
    }],
  };
  const found = candidates(digest).filter((c) => c.edge === 'exfiltrate');
  assert.equal(found.length, 2, 'one of the two questions is not being asked');
  const [reach] = found.filter((c) => c.target);
  const [capability] = found.filter((c) => !c.target);
  assert.ok(reach, 'the enumerated answer is gone - a restriction has nothing to be validated against');
  assert.deepEqual(reach.target.sample, [bucket]);
  assert.ok(capability, 'the capability answer is suppressed as soon as one resource exists');
  // And it claims nothing about the inventory, in either direction. The old sentence said "no
  // resource of the relevant type exists yet", which is now false on exactly this account.
  assert.ok(!/exists yet/.test(capability.why), 'the capability sentence asserts an empty account');
  assert.match(capability.why, /do not exist yet/);
});

// ---- writing the tag a control reads ----------------------------------------------------------

test('a tag write is found from the ACCESS LEVEL, never from the verb', () => {
  // The miss that made the whole tag-tamper path unreachable. CAP.TAG existed and was assigned by
  // a verb prefix, and a tag write rarely starts with one - so the four actions that matter most
  // landed in four different buckets and none of them was 'tag'.
  assert.equal(capabilitiesOf('ec2:CreateTags').caps[0], CAP.CREATE);
  assert.equal(capabilitiesOf('s3:PutBucketTagging').caps[0], CAP.MODIFY_CONFIG);
  assert.equal(capabilitiesOf('rds:AddTagsToResource').caps[0], CAP.UNMAPPED);
  // The digest carries what AWS calls Tagging, and the capability map takes them from there.
  const writes = ['ec2:CreateTags', 's3:PutBucketTagging', 'rds:AddTagsToResource'];
  const found = candidates({
    account_id: ACCOUNT,
    passrole_grants: [],
    grants: [{ p: 'P1', name: 'X', risk_actions: writes, tag_writes: writes,
               non_restrictable: [], units: [] }],
  });
  assert.deepEqual(found.map((c) => c.edge), ['retag']);
  assert.equal(found[0].outcome, OUTCOME.TAG_TAMPER);
  assert.deepEqual(found[0].steps[0].actions.sort(), [...writes].sort());
  // Added to what the fallback guessed rather than replacing it - ec2:CreateTags really does
  // create something, and losing that would be a second miss in the other direction.
  const caps = found[0].steps.map((s) => s.capability);
  assert.ok(caps.includes(CAP.TAG));
});

test('a grant with no tag write proposes no retag path', () => {
  const quiet = candidates({
    account_id: ACCOUNT,
    passrole_grants: [],
    grants: [{ p: 'P1', name: 'X', risk_actions: ['s3:PutBucketPolicy'], tag_writes: [],
               non_restrictable: [], units: [] }],
  });
  assert.ok(!quiet.some((c) => c.edge === 'retag'));
  // And a digest written before tag_writes existed says nothing rather than guessing.
  const older = candidates({
    account_id: ACCOUNT,
    passrole_grants: [],
    grants: [{ p: 'P1', name: 'X', risk_actions: ['ec2:CreateTags'], non_restrictable: [],
               units: [] }],
  });
  assert.ok(!older.some((c) => c.edge === 'retag'));
});

// ---- what an action DOES, when nobody wrote it down ---------------------------------------------
//
// The curated table is 136 entries against 12,328 mutating actions and the verb fallback carries
// the rest by reading the first word. Measured over the shipped table, that put 46% of them in a
// bucket no edge consumes - 55% within ec2 - so they produced no candidate and the model, which
// only ever judges candidates, was never asked about them. Not "the model missed it": not asked.

/** A reference lookup of the shape the assessment carries, for the actions a test names. */
const ref = (rows) => referenceIndex({
  action_reference: {
    services: Object.fromEntries(Object.entries(rows).map(([action, row]) => {
      const [service, name] = action.split(':');
      return [service, { [name]: row.level ? [row.level, row.types ?? []] : ['Write', row.types ?? []] }];
    }).reduce((acc, [service, block]) => {
      acc.set(service, { ...(acc.get(service) ?? {}), ...block });
      return acc;
    }, new Map())),
    allow_only: Object.fromEntries([...Object.entries(rows)
      .filter(([, row]) => row.refuse)
      .reduce((acc, [action, row]) => {
        const [service, name] = action.split(':');
        acc.set(service, { ...(acc.get(service) ?? {}), [name]: { refuse: row.refuse } });
        return acc;
      }, new Map())]),
  },
});

test('re-pointing an existing association is its own path, and the table already knew', () => {
  // ec2:ReplaceRouteTableAssociation. A subnet is private because the route table it is associated
  // with has no default route to an internet gateway; re-associate it with one that does and the
  // subnet is public - without creating a route, touching a gateway, or calling any of the four
  // actions X-2 names. The verb table has no 'Replace', so it was UNMAPPED and reached no edge.
  //
  // Nothing new is looked up to find it. projection 6 already marks the action deref:AssociationId
  // - the request names an association id and the object at the other end is resolved from it -
  // which is the same fact that makes allow_only unsafe for it. It was computed for the restriction
  // composer and the risk analysis never read it.
  const reference = ref({
    'ec2:ReplaceRouteTableAssociation': { types: ['route-table', 'subnet'],
                                          refuse: 'deref:AssociationId' },
  });
  const found = candidates(EMPTY(['ec2:ReplaceRouteTableAssociation']), reference);
  assert.equal(found.length, 1, 'the action still produces no candidate at all');
  assert.equal(found[0].edge, 'rebind');
  assert.equal(found[0].outcome, OUTCOME.CONTROL_REBIND);
  assert.deepEqual(found[0].steps[0].actions, ['ec2:ReplaceRouteTableAssociation']);

  // Without the reference it is invisible, which is what this fixes and what a regression looks like.
  assert.deepEqual(candidates(EMPTY(['ec2:ReplaceRouteTableAssociation'])), []);
});

test('a permissions write is found from the access level, not from a curated entry', () => {
  // The same move that fixed the tag-tamper path, applied to the level AWS publishes beside it.
  // 415 actions are labelled Permissions management and 67% of them reached no edge - among them
  // sts:AssumeRoleWithSAML, which mints a credential.
  const onPrincipal = ref({ 'acme:PutRolePolicy': { level: 'Permissions management',
                                                    types: ['role'] } });
  const [grant] = candidates(EMPTY(['acme:PutRolePolicy']), onPrincipal);
  assert.equal(grant.edge, 'grant-self', 'a permissions write onto a principal is not an escalation');

  // On a resource rather than a principal it is the other path: admitting somebody else, not
  // writing permissions onto yourself. The level cannot separate those; the resource types can.
  const onResource = ref({ 'acme:PutVaultPolicy': { level: 'Permissions management',
                                                    types: ['vault'] } });
  const [share] = candidates(EMPTY(['acme:PutVaultPolicy']), onResource);
  assert.equal(share.edge, 'exfiltrate');
  assert.equal(share.outcome, OUTCOME.DATA_EGRESS);
});

test('a curated entry is not widened by the reference', () => {
  // The 136 curated entries are the ones a person decided BECAUSE the published facts do not show
  // them, so a derivation must not change them as a side effect of widening the other 12,192.
  const action = 'ec2:ReplaceIamInstanceProfileAssociation';
  const reference = ref({ [action]: { types: ['instance'], refuse: 'deref:AssociationId' } });
  // Curated as replace-identity, and ALSO marked deref: by the table. If the two were unioned it
  // would produce a second card saying the same thing under a different heading.
  assert.deepEqual(capabilitiesOf(action, reference).caps, [CAP.REPLACE_IDENTITY]);
  assert.equal(capabilitiesOf(action, reference).source, 'curated');

  // A unit, because takeover-identity is a reach over something that exists rather than a
  // capability of the grant - an empty account proposes only the targetless edges.
  const digest = {
    account_id: ACCOUNT,
    passrole_grants: [],
    grants: [{ p: 'P1', name: 'X', risk_actions: [action], non_restrictable: [],
               units: [{ t: 'ec2:instance', acts: [0], n: 1, sample: [arn('ec2', 'instance', 'i-0a')],
                         truncated: false, colocation: 'sound', attribution: 'resource_type' }] }],
  };
  assert.deepEqual(candidates(digest, reference).map((c) => c.edge), ['takeover-identity'],
                   'the curated answer was joined by a derived one, doubling the card');
});

test('reconfiguring the pipeline\'s own resources is a path; reconfiguring anything else is not', () => {
  // modify-config is the verb fallback's largest bucket - 3,434 mutating actions - so an
  // unrestricted edge would put a candidate on nearly every grant and cost more attention than it
  // returns. On a resource this deployment was CONFIGURED with, what gets changed is what decides
  // approvals, and that is a different sentence.
  const digest = {
    account_id: ACCOUNT,
    passrole_grants: [],
    grants: [{
      p: 'P1', name: 'X', risk_actions: ['sqs:SetQueueAttributes2'], non_restrictable: [],
      units: [{ t: 'sqs:queue', acts: [0], n: 1, sample: ['arn:aws:sqs:us-east-1:1:q'],
                truncated: false, colocation: 'sound', attribution: 'resource_type',
                cp: [{ arn: 'arn:aws:sqs:us-east-1:1:q', role: 'event_queue', basis: 'configured' }] }],
    }],
  };
  const [found] = candidates(digest).filter((c) => c.edge === 'reconfigure-control-plane');
  assert.ok(found, 'changing the configuration of the pipeline\'s own queue proposes nothing');
  assert.equal(found.outcome, OUTCOME.CONTROL_PLANE_WRITE);

  // The same action on an ordinary resource does not, or every grant grows a card.
  const ordinary = structuredClone(digest);
  ordinary.grants[0].units[0].cp = [];
  assert.ok(!candidates(ordinary).some((c) => c.edge === 'reconfigure-control-plane'));
});

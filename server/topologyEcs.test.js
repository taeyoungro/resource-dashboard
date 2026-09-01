// The ECS picture. The engine invariants are in topology.test.js; what is here is the two claims
// this picture is arranged around - that a cluster and a VPC do not contain each other, and that
// nothing crosses the border between them.
//
//     node --test server/topologyEcs.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { TOPOLOGIES, facets, scene, sceneSummary } from './topology.js';
import SPEC from './topologyEcs.js';
import { RESOURCE_TYPE_ICONS } from './serviceIcons.js';
import { CONSOLE_LIST_PAGES } from './consoleLinks.js';

const ACCOUNT = '718100330247';
const ARN = 'arn:aws:iam::aws:policy/AmazonECS_FullAccess';
const cluster = (i) => `arn:aws:ecs:ap-northeast-2:${ACCOUNT}:cluster/prod-${i}`;

/** `n` services across three clusters, `inVpc` of which resolved to a VPC. */
function services(n, inVpc, over = {}) {
  return {
    service: 'ecs', resource_type: 'ecs:service', actions: [], scope: '*', total: n,
    truncated: false, sensitive_hits: 0,
    resources: Array.from({ length: n }, (_, i) => ({
      arn: `arn:aws:ecs:ap-northeast-2:${ACCOUNT}:service/prod-${i % 3}/s${i}`,
      region: 'ap-northeast-2', tags: {}, sensitive: false, cluster: cluster(i % 3),
      ...(i < inVpc
        ? { placement: 'vpc', vpc_id: 'vpc-0b2', subnet_ids: ['subnet-9'] }
        : { placement: 'none' }),
    })),
    ...over,
  };
}
const clusters = (n) => ({
  service: 'ecs', resource_type: 'ecs:cluster', actions: [], scope: '*', total: n,
  truncated: false, sensitive_hits: 0,
  resources: Array.from({ length: n }, (_, i) => ({
    arn: cluster(i), region: 'ap-northeast-2', tags: {}, sensitive: false, cluster: cluster(i),
  })),
});
const policyOf = (affected) => ({
  source: 'aws_managed', identifier: ARN, default_version_id: 'v1', is_baseline: false,
  restrictable: true, unreadable: null, actions_granted: ['ecs:*'], affected,
});
const sceneOf = (affected, filter = null) => scene(policyOf(affected), ACCOUNT, filter);

test('AmazonECS_FullAccess draws the ECS picture', () => {
  assert.equal(TOPOLOGIES.ecs, SPEC);
  assert.equal(scene(policyOf([]), ACCOUNT).kind, 'ecs');
});

test('the cluster and the VPC are siblings, neither inside the other', () => {
  // THE CLAIM THIS PICTURE IS ARRANGED AROUND, and getting it wrong in either direction is a false
  // statement about AWS. `Service` has no `vpcId` member and neither does `Task` - a cluster is a
  // REGIONAL logical grouping whose services can run in different VPCs.
  assert.equal(SPEC.frames.find((f) => f.id === 'cluster').parent, 'region');
  assert.equal(SPEC.frames.find((f) => f.id === 'vpc').parent, 'region');
  const s = sceneOf([clusters(3), services(20, 14)]);
  const c = s.frames.find((f) => f.id === 'cluster');
  const v = s.frames.find((f) => f.id === 'vpc');
  assert.ok(c && v, 'the picture is missing a frame');
  const overlap = c.x < v.x + v.w && c.x + c.w > v.x && c.y < v.y + v.h && c.y + c.h > v.y;
  assert.ok(!overlap, 'the cluster and the VPC frames overlap, so one appears to contain the other');
});

test('the cluster frame is dashed', () => {
  // Service-in-cluster IS definitional, but the assessment measured that each service is in *a*
  // cluster and not that they are all in the *same* one. One solid box around them claims the
  // second.
  assert.equal(SPEC.frames.find((f) => f.id === 'cluster').dashed, true);
  assert.equal(SPEC.frames.find((f) => f.id === 'vpc').dashed, true);
});

test('no scene has a straddling slot or an arrow', () => {
  // A plate crossing the cluster|VPC border would say "services live in both" about a population
  // that may be entirely bridge- or host-mode, or largely unmeasured under the budget. Geometry is
  // the loudest sentence in a picture and it cannot be conditioned on a fraction.
  assert.ok(!Object.values(SPEC.rails).some((r) => r.straddle), 'a rail was made to straddle');
  assert.ok(!Object.values(SPEC.rails).some((r) => r.link), 'a rail grew a link');
  for (const affected of [[clusters(3), services(20, 14)], [services(5, 0)], []]) {
    const s = sceneOf(affected);
    assert.equal(s.link, null, 'the picture drew an arrow');
    assert.ok(!s.slots.some((sl) => sl.erase), 'a plate erased a border it was drawn across');
  }
});

test('the VPC frame is absent when no service resolved to one', () => {
  // Asserting a network for an account whose services are all bridge-mode.
  const none = sceneOf([clusters(3), services(20, 0)]);
  assert.ok(!none.frames.some((f) => f.id === 'vpc'), 'an unmeasured VPC frame was drawn');
  const some = sceneOf([clusters(3), services(20, 14)]);
  assert.equal(some.placed, 14);
  assert.equal(some.frames.find((f) => f.id === 'vpc').count, '14개 배치 확인');
});

test('no ec2 type has a slot, and the omitted sentence says why', () => {
  // AmazonECS_FullAccess reaches EC2 resources and they ARE counted - a subnet frame for them
  // reintroduces the which-of-sixteen problem, and an EC2 instance beside the 태스크 plate says the
  // cluster runs on it.
  for (const type of Object.keys(SPEC.slots)) {
    assert.ok(type.startsWith('ecs:'), `${type} is not an ECS type and has a place in this picture`);
  }
  assert.deepEqual([...SPEC.services], ['ecs']);
  const s = sceneOf([clusters(3), {
    service: 'ec2', resource_type: 'ec2:subnet', actions: [], scope: '*', total: 6,
    truncated: false, sensitive_hits: 0, resources: [],
  }]);
  assert.deepEqual(s.omitted, [{ service: 'ec2', total: 6 }]);
  assert.ok(s.rows.every((r) => r.resourceType.startsWith('ecs:')),
            'a non-ECS row reached the table beside the picture');
  assert.match(SPEC.words.omitted, /서비스가 그 안에 있다는 것과/,
               'the sentence does not separate "the service is in it" from "the policy can touch it"');
});

test('the cluster-scoped types are in the cluster frame and the regional ones are not', () => {
  // Evidenced by the action reference's own `made` block, not by memory: task-set's ARN carries
  // cluster/service/id, and task-definition's carries family:revision with NO cluster segment.
  for (const type of ['ecs:service', 'ecs:task', 'ecs:container-instance', 'ecs:task-set']) {
    assert.equal(SPEC.slots[type].rail, 'cluster', `${type} is cluster-scoped`);
  }
  for (const type of ['ecs:task-definition', 'ecs:capacity-provider']) {
    assert.equal(SPEC.slots[type].rail, 'regional', `${type} is region-scoped`);
  }
  assert.equal(SPEC.slots['ecs:cluster'].kind, 'frame', 'the cluster is not its own frame');
  // And a container instance does NOT borrow the EC2 tile: the row's type is
  // ecs:container-instance, and an Amazon EC2 glyph beside it reads as the ec2:instance count this
  // same broad policy also reaches, which is a different resource with a different number.
  assert.equal(SPEC.slots['ecs:container-instance'].icon, null);
});

test('every ECS type is a slot or a refusal in writing', () => {
  const decided = new Set([...Object.keys(SPEC.slots), ...Object.keys(SPEC.noSlot)]);
  assert.equal(decided.size, 13, 'the ECS type list changed and something is undecided');
  assert.equal(Object.keys(SPEC.noSlot).length, 6);
  // And the neighbouring tables cannot know about a type this one does not.
  for (const table of [RESOURCE_TYPE_ICONS, CONSOLE_LIST_PAGES]) {
    for (const type of Object.keys(table)) {
      if (!type.startsWith('ecs:')) continue;
      assert.ok(decided.has(type),
                `${type} is in a neighbouring table and this picture has no decision about it`);
    }
  }
});

test('only ecs:service is placeable, and tasks are deliberately not', () => {
  // Pinned against ECS_PLACEMENT in impact/inventory.py. Tasks are excluded on purpose: the model
  // documents no ARN format for one, and a task's subnet lives in an untyped KeyValuePair bag
  // whose key names appear nowhere in the model - parsing it fails silently to None, which is
  // indistinguishable from "not measured".
  assert.deepEqual([...SPEC.placeable], ['ecs:service']);
  assert.ok(!SPEC.placeable.has('ecs:task'), 'tasks became placeable without the design changing');
  assert.equal(SPEC.multiSubnet, true, 'an awsvpc service runs across up to sixteen subnets');
});

test('the cluster chip reads the cluster name, not the service ARN tail', () => {
  // parseArn reduces a long SERVICE arn to `my-cluster/my-service`, so a chip built from the
  // service ARN would read as neither. The facet is built from Resource.cluster - the clusterArn
  // DescribeServices returned, a typed field - which reduces to the cluster name.
  const f = facets(policyOf([clusters(3), services(20, 14)]));
  assert.equal(f.clusters.length, 3);
  for (const chip of f.clusters) {
    assert.match(chip.id, /^arn:aws:ecs:[^:]+:\d+:cluster\/prod-\d$/,
                 'a cluster chip is not a cluster ARN');
  }
  // And narrowing by one of them keeps only what is in it.
  const one = sceneOf([clusters(3), services(20, 14)], { clusters: [cluster(0)] });
  assert.ok(one.measured < 23 && one.measured > 0, 'the cluster filter narrowed nothing, or all');
});

test('the two dimensions this data cannot serve say why, rather than not appearing', () => {
  // A reader who does not find 시작 유형 has no way to tell "nobody thought of it" from "it would
  // have lied". Both are structural and are named whatever the account holds.
  const f = facets(policyOf([clusters(3), services(20, 14)]));
  const ids = f.unavailable.map((u) => u.id);
  assert.ok(ids.includes('launchType') && ids.includes('securityGroups'));
  const launch = f.unavailable.find((u) => u.id === 'launchType');
  assert.match(launch.why, /용량 공급자 전략/, 'the reason omits the case that makes it unusable');
  assert.match(launch.why, /조용히 통과시키는/, 'the reason does not say what the bad control does');
});

test('the summary names ECS and the caption travels with the crop', () => {
  const s = sceneOf([clusters(3), services(20, 14)]);
  assert.match(sceneSummary(s), /^이 정책이 닿는 ECS 자원/);
  assert.match(sceneSummary(s), /ECS의 일반적인 구성 자리/);
  assert.ok(s.foot.some((l) => l.text === SPEC.words.caption), 'the caption is not in the viewBox');
});

// The ECS picture. Data only - server/topology.js draws it.
//
// THE CLUSTER AND THE VPC ARE SIBLINGS, and getting that wrong in either direction is the failure
// this picture exists to avoid. `Service` has no `vpcId` member and neither does `Task` - verified
// against the model, not remembered - because a cluster is a REGIONAL logical grouping and its
// services can run in different VPCs. So `cluster` inside `vpc` is false, `vpc` inside `cluster` is
// false, and the two stack.
//
// The cluster frame is DASHED even though service-in-cluster is definitional: the assessment
// measured that each service is in *a* cluster, not that they are all in the *same* one, and one
// box drawn around them claims the second.
//
// THERE IS NO STRADDLE AND NO ARROW. A plate crossing the cluster|VPC border would say "services
// live in both" about a population that may be entirely bridge- or host-mode - AWS's own
// DescribeServices example response omits `networkConfiguration` altogether - or, under the call
// budget, largely unmeasured. Geometry is the loudest sentence in a picture and it cannot be
// conditioned on a fraction. The VPC fact goes on the VPC frame's band as a number instead.
//
// There is no 가용 영역, no 서브넷 and no 보안 그룹 frame, for the reasons the Lambda picture gives:
// `AwsVpcConfiguration.subnets` is max 16 and `securityGroups` max 5, so one plate in one box would
// name one of sixteen.
//
// NO ec2:* TYPE HAS A SLOT HERE. AmazonECS_FullAccess reaches EC2 resources and they are counted -
// they appear in `scene.omitted` and in the paragraph under the table - but drawing a subnet frame
// for them reintroduces the which-of-sixteen problem, and drawing an EC2 instance beside a 태스크
// plate says the cluster runs on it. One honest sentence answers the reader's real question; frames
// that cannot be filled do not.

import { captionFor } from './topology.js';

const FRAMES = [
  { id: 'cloud', parent: null, arrange: 'stack', rail: null, type: null, always: true,
    stroke: '#242F3E', width: 2, dashed: false, badge: 'Group-AWS-Cloud.svg' },
  { id: 'region', parent: 'cloud', arrange: 'stack', rail: 'regional', type: null,
    always: true, longNote: true,
    stroke: '#00A4A6', width: 2, dashed: false, badge: 'Group-Region.svg' },
  { id: 'cluster', parent: 'region', arrange: 'stack', rail: 'cluster', type: 'ecs:cluster',
    stroke: null, width: 1.5, dashed: true, badge: null },
  // Beside the cluster, not around it and not inside it. Drawn only when the querier resolved a
  // service's subnets to a VPC, dashed whatever that count is.
  { id: 'vpc', parent: 'region', arrange: 'stack', rail: null, type: null, measure: 'placed',
    stroke: '#8C4FFF', width: 2, dashed: true, badge: 'Group-Virtual-private-cloud-VPC.svg' },
];

const FRAME_LABEL = {
  cloud: 'AWS 클라우드',
  region: '리전',
  cluster: '클러스터',
  vpc: 'VPC',
};

const RAILS = {
  regional: { frame: 'region' },
  cluster: { frame: 'cluster' },
};

/**
 * resource_type -> where it goes and what it is called. Seven drawn; the other six are refused in
 * writing below.
 *
 * The rail is a scope claim and two of them are evidenced by the action reference's own `made`
 * block rather than by memory: `ecs:task-set` is declared as
 * `arn:${Partition}:ecs:*:${Account}:task-set/*` + cluster + service + id, so it is cluster-scoped;
 * `ecs:task-definition` is declared as `task-definition/*:*` - family and revision, NO cluster
 * segment - so it is regional. `ecs:capacity-provider` is regional because a capacity provider is
 * associated with zero or more clusters, and putting it inside THE cluster frame would be a claim.
 *
 * `ecs:container-instance` is `icon: null` and deliberately NOT the EC2 instance glyph. The row's
 * type is `ecs:container-instance`; an Amazon EC2 tile beside the 태스크 plate reads as the
 * `ec2:instance` count this same broad policy also reaches, which is a different resource with a
 * different number.
 *
 * The deck carries exactly seven Res_*_48 glyphs whose id contains Elastic-Container-Service, and
 * five of them are not resources this assessment reaches (three Container tiles, Service Connect,
 * the Copilot CLI). Definition, Capacity and Fargate return zero. So `icon: null` on five slots is
 * a checked absence.
 */
const SLOTS = {
  'ecs:cluster': { kind: 'frame', frame: 'cluster' },

  'ecs:service': { kind: 'node', rail: 'cluster', label: ['서비스'],
    icon: 'Res-Amazon-Elastic-Container-Service-Service.svg' },
  'ecs:task': { kind: 'node', rail: 'cluster', label: ['태스크'],
    icon: 'Res-Amazon-Elastic-Container-Service-Task.svg' },
  'ecs:container-instance': { kind: 'node', rail: 'cluster', label: ['컨테이너 인스턴스'],
    icon: null },
  'ecs:task-set': { kind: 'node', rail: 'cluster', label: ['태스크 세트'], icon: null },

  'ecs:task-definition': { kind: 'node', rail: 'regional', label: ['태스크 정의'], icon: null },
  'ecs:capacity-provider': { kind: 'node', rail: 'regional', label: ['용량 공급자'], icon: null },
};

/**
 * The six ECS types the reference declares that this picture deliberately does not draw, with the
 * reason. A test reads it: every type in the reference must be a slot above or a written decision
 * here, never an omission nobody made. They are still counted, still in the table beside the
 * picture, and still in the foot line - refused a POSITION, not a number.
 */
const NO_SLOT = {
  'ecs:service-deployment':
    '서비스에 일어난 일에 대한 기록이지 어딘가에 놓인 것이 아니다. 클러스터 안에 그리면 변경 이력이 '
    + '지금 돌아가는 것의 자리를 차지한다.',
  'ecs:service-revision':
    '같은 이유다. 서비스의 한 판(版)이지 자원의 위치가 아니다.',
  'ecs:daemon':
    '참조 어휘에는 있으나 이 저장소 어디에도 이 유형의 인덱스 표기가 없고, 어느 범위에 속하는지도 '
    + '모델이 말하지 않는다. 자리를 지어 주는 대신 표에 올린다.',
  'ecs:daemon-deployment': '위와 같다.',
  'ecs:daemon-revision': '위와 같다.',
  'ecs:daemon-task-definition': '위와 같다.',
};

/**
 * The one type the querier can answer placement for, mirroring ECS_PLACEMENT in
 * impact/inventory.py. Pinned against it by a test.
 *
 * Not `ecs:task`, and that is a decision with three reasons behind it - see the §I note in
 * inventory.py: the model documents no ARN format for a task, a task's subnet lives in an untyped
 * KeyValuePair bag whose key names appear nowhere in the model, and a task may be gone before the
 * approver opens the picture. Tasks are drawn in the cluster frame, which is definitional, and the
 * picture makes no network claim about them.
 */
const PLACEABLE = new Set(['ecs:service']);

export const WORDS = {
  subject: 'ECS',
  title: 'ECS',
  home: 'ECS의 일반적인 자리',
  summaryHome: 'ECS의 일반적인 구성 자리',
  caption: captionFor('ECS의 일반적인 자리'),
  omitted: '이 그림의 VPC 테두리는 서비스가 쓰는 VPC다. 이 정책이 닿는 VPC·서브넷·보안 그룹·로드 '
    + '밸런서 자원 자체는 여기에 자리가 없다 — 서비스가 그 안에 있다는 것과 그 자원들을 이 정책이 '
    + '만질 수 있다는 것은 다른 이야기다.',
};

export function noteFor(id) {
  if (id === 'vpc') return '서비스의 awsvpc 네트워크만 해당한다 · 태스크는 조회하지 않는다';
  return null;
}

export default {
  kind: 'ecs',
  sky: 8,
  services: new Set(['ecs']),
  frames: FRAMES,
  frameLabel: FRAME_LABEL,
  rails: RAILS,
  slots: SLOTS,
  noSlot: NO_SLOT,
  placeable: PLACEABLE,
  /** An awsvpc service runs its tasks across up to sixteen subnets. See subnetsOf. */
  multiSubnet: true,
  dimensions: ['accounts', 'regions', 'clusters', 'vpcs', 'subnets'],
  words: WORDS,
  noteFor,
  /**
   * Two dimensions an approver will reasonably ask for and this data cannot serve honestly. Named
   * WITH the reason rather than left off, because a reader who does not find 시작 유형 has no way
   * to tell "nobody thought of it" from "it would have lied".
   */
  unavailable: [
    { id: 'launchType',
      label: '시작 유형',
      why: 'DescribeServices는 서비스에만 시작 유형을 돌려주고, 용량 공급자 전략을 쓰는 서비스에는 '
        + '그것도 없다. 태스크·태스크 정의는 아예 답이 없다 — 한 유형만 좁히고 나머지를 조용히 '
        + '통과시키는 컨트롤이 된다.' },
    { id: 'securityGroups',
      label: '보안 그룹',
      why: 'awsvpc 서비스만 보안 그룹을 지정하고, 서비스 하나가 최대 5개를 쓴다. 인벤토리의 보안 '
        + '그룹 행은 어느 서비스 것인지 말하지 않는다.' },
  ],
};

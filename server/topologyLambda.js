// The Lambda picture. Data only - server/topology.js draws it.
//
// THREE FRAMES, and the two that are missing matter more than the three that are here.
//
// There is NO 가용 영역 frame. `VpcConfigResponse` carries no zone and the lambda service model
// publishes no per-function availability zone anywhere - AWS places the function's network
// interfaces itself and does not say where. A ghost box nothing can ever fill is a box a reader
// spends attention on for nothing.
//
// There is NO 서브넷 frame. `VpcConfigResponse.SubnetIds` is `min 0, max 16`, so a function names
// up to sixteen subnets and one 함수 plate inside one subnet box would name one of them. The
// subnets ARE recorded - they are a filter dimension - but a filter can say "sixteen" and a box
// cannot.
//
// There is NO 보안 그룹 frame. `SecurityGroupIds` is measured too, and `lambda:*` has no
// security-group resource type at all, so the box could never carry a count.
//
// THE VPC FRAME IS DASHED AND IT CARRIES A NUMBER. That combination is the whole design of this
// picture. `ListFunctions` measures, per function, "this one is attached to vpc-0a1b" - a real
// fact, from a real call, that the EC2 picture has no equivalent of. But the drawing has ONE box,
// and if the N functions sit in three VPCs a solid border would assert a containment nobody
// measured. So the measurement goes on the label band as a count and the border stays dashed,
// which is the rule the whole feature rests on: a measurement never changes a border.
//
// AND THE 함수 PLATE IS OUTSIDE THAT BOX, ALWAYS. A function not attached to a VPC is the ordinary
// case and a fact about Lambda, not a gap in the lookup. Drawing the plate inside the VPC frame
// would tell an approver every function this policy reaches is in a VPC, which is the single
// biggest lie this picture could tell. The frame is drawn only when the querier placed something
// into it (`measure: 'placed'`), so an account with no VPC-attached function gets no box at all.

import { captionFor } from './topology.js';

const FRAMES = [
  { id: 'cloud', parent: null, arrange: 'stack', rail: null, type: null, always: true,
    stroke: '#242F3E', width: 2, dashed: false, badge: 'Group-AWS-Cloud.svg' },
  { id: 'region', parent: 'cloud', arrange: 'stack', rail: 'regional', type: null,
    always: true, longNote: true,
    stroke: '#00A4A6', width: 2, dashed: false, badge: 'Group-Region.svg' },
  // Drawn only when `placed > 0`, dashed whatever is inside it, and its band count is the number
  // of functions the querier actually measured into a VPC.
  { id: 'vpc', parent: 'region', arrange: 'stack', rail: null, type: null, measure: 'placed',
    stroke: '#8C4FFF', width: 2, dashed: true, badge: 'Group-Virtual-private-cloud-VPC.svg' },
];

const FRAME_LABEL = {
  cloud: 'AWS 클라우드',
  region: '리전',
  vpc: 'VPC',
};

/** One rail. Every Lambda type is region-scoped, so there is nowhere else for one to go. */
const RAILS = {
  regional: { frame: 'region' },
};

/**
 * resource_type -> where it goes and what it is called. All eleven types the action reference
 * declares for lambda, and every one of them in the SAME rail.
 *
 * That uniformity is a safety property and not laziness. A rail is a placement claim; putting every
 * type in the region rail claims only "this is region-scoped", which is true of all eleven, so a
 * spelling this table gets wrong costs a foot line and never a wrong position. Only
 * `lambda:function` is confirmed against a Resource Explorer document in this repository
 * (server/api.test.js and consoleLinks.js both carry it); the other ten are the reference's own
 * type names put through the same fold the assessment uses, which is checked by a test.
 *
 * `icon: null` on ten of eleven is a MEASURED absence, not an omission. Searching the extracted
 * deck for a Res_*_48 glyph returns exactly one Lambda resource icon - Res_AWS-Lambda_Lambda-
 * Function_48 - and zero for Layer, Alias, Version, Signing and Capacity. Those slots render their
 * plate and their label, which is the same never-guess contract the service table keeps.
 */
const SLOTS = {
  'lambda:function': { kind: 'node', rail: 'regional', label: ['함수'],
    icon: 'Res-AWS-Lambda-Lambda-Function.svg' },
  'lambda:function-alias': { kind: 'node', rail: 'regional', label: ['함수 별칭'], icon: null },
  'lambda:function-version': { kind: 'node', rail: 'regional', label: ['함수 버전'], icon: null },
  'lambda:layer': { kind: 'node', rail: 'regional', label: ['레이어'], icon: null },
  'lambda:layer-version': { kind: 'node', rail: 'regional', label: ['레이어 버전'], icon: null },
  'lambda:event-source-mapping': { kind: 'node', rail: 'regional', label: ['이벤트 소스 매핑'],
    icon: null },
  'lambda:code-signing-config': { kind: 'node', rail: 'regional', label: ['코드 서명 구성'],
    icon: null },
  'lambda:capacity-provider': { kind: 'node', rail: 'regional', label: ['용량 공급자'], icon: null },
  'lambda:durable-execution': { kind: 'node', rail: 'regional', label: ['지속 실행'], icon: null },
  'lambda:microvm-image': { kind: 'node', rail: 'regional', label: ['마이크로VM 이미지'],
    icon: null },
  'lambda:network-connector': { kind: 'node', rail: 'regional', label: ['네트워크 커넥터'],
    icon: null },
};

/** Every reference type is drawn, so there is nothing to refuse in writing. */
const NO_SLOT = {};

/**
 * The one type the querier can answer placement for, mirroring LAMBDA_PLACEMENT in
 * impact/inventory.py. Pinned against it by a test.
 *
 * A layer or an event source mapping has no VPC to be in, so folding them in would count them
 * against the lookup and report a permission failure that never happened.
 */
const PLACEABLE = new Set(['lambda:function']);

export const WORDS = {
  subject: '람다',
  title: '람다',
  home: '람다의 일반적인 자리',
  summaryHome: '람다의 일반적인 구성 자리',
  caption: captionFor('람다의 일반적인 자리'),
  omitted: '이 그림의 VPC 테두리는 함수가 붙은 VPC다. 이 정책이 닿는 VPC·서브넷·보안 그룹 자원 '
    + '자체는 EC2 구성도의 몫이고 여기에는 자리가 없다.',
};

/** What this picture says on its own frames. The engine supplies the account and the region band. */
export function noteFor(id) {
  if (id === 'vpc') return 'VPC에 연결된 함수만 해당한다 · 어느 함수인지는 말하지 않는다';
  return null;
}

export default {
  kind: 'lambda',
  /** No internet glyph above the cloud frame, so no sky. */
  sky: 8,
  services: new Set(['lambda']),
  frames: FRAMES,
  frameLabel: FRAME_LABEL,
  rails: RAILS,
  slots: SLOTS,
  noSlot: NO_SLOT,
  placeable: PLACEABLE,
  /** A function attaches network interfaces in up to sixteen subnets. See subnetsOf. */
  multiSubnet: true,
  dimensions: ['accounts', 'regions', 'vpcs', 'subnets'],
  words: WORDS,
  noteFor,
  /**
   * Nothing static. 런타임, 아키텍처 and 메모리 ARE returned by ListFunctions and are deliberately
   * never read - a dimension the assessment does not record is not a dimension somebody can ask
   * for, and listing it here would advertise data this container refuses to hold.
   */
  unavailable: [],
};

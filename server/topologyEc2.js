// The EC2 picture: which frames it has, where each EC2 resource TYPE sits in them, and what the
// window calls things. Data only - server/topology.js is the engine that draws any of these, and
// this file describes one of the three.
//
// Almost every value here is a literal a reader can check against AWS without running anything.
//
// The tables moved out of the engine unchanged. server/fixtures/ec2Scene.golden.json is what says
// so: it holds the scenes the pre-extraction module drew, and topologyEc2.test.js deepEquals the
// engine's output against them. A refactor of a merged, deploying feature is exactly where a
// coordinate moves and nobody notices until an approver screenshots it.
//
// Korean appears here only as label strings, which is where the engine already put them.
//
// The one import is captionFor, and it is a FUNCTION on purpose. topology.js imports this file, so
// anything read here at module-evaluation time would sit in the engine's temporal dead zone - a
// `const` breaks with ReferenceError, a hoisted function declaration does not. The caption is built
// rather than written out because it is the sentence that travels with a cropped screenshot, and
// three copies of it would be three chances to drift.

import { captionFor } from './topology.js';

/**
 * The skeleton, outermost first. Painter order IS array order, so a frame is drawn before anything
 * it contains.
 *
 * parent is explicit rather than implied by nesting so that re-parenting - moving Amazon EBS under
 * the VPC, inserting a frame between two others - is a one-line edit that the layout walk, the
 * class names and the tests all follow automatically.
 *
 * THE NESTING IS AWS'S SCOPING, and it is the one thing in this picture that is a claim rather than
 * a placement: the legend says a dashed border is "EC2의 일반적인 자리다", which asserts canonicity,
 * so an arrangement AWS does not have is a false statement however clearly it is marked unmeasured.
 * Region ⊃ VPC ⊃ 가용 영역 ⊃ 서브넷: a VPC spans every availability zone in its region, and the
 * SUBNET is the zone-scoped thing. The picture had it the other way round - VPC inside 가용 영역 -
 * which told every reader that a VPC, and everything the policy reaches inside it, sits in one zone.
 *
 * 보안 그룹 is the one frame that is NOT a scoping box: a security group is VPC-scoped and attaches
 * to network interfaces rather than containing anything. It is drawn around what it protects
 * because that is how AWS's own reference architectures draw it, which makes it a drawing
 * convention rather than a scope - and the frame's colour is AWS's convention colour for it, not a
 * danger signal. See the legend, which now says so, and Frame.sensitive, which is where a
 * sensitive count on a frame actually lands.
 *
 * The stroke literals are AWS's own group-badge fills, read out of the extracted files rather than
 * remembered: Group-AWS-Cloud.svg #242F3E, Group-Region.svg #00A4A6,
 * Group-Virtual-private-cloud-VPC.svg #8C4FFF. They live here rather than in styles.css because
 * that file's banner says nothing below it sets a literal colour, and as SVG presentation
 * attributes they stay overridable from CSS if a theme ever wants them.
 *
 * stroke: null means the renderer's class supplies var(--border) - the frames whose family colour
 * this module has no business asserting. The subnet is the one worth naming: AWS's public-subnet
 * badge is green and its private-subnet badge is teal, and the assessment carries nothing that
 * tells them apart, so drawing either would be claiming a routing fact nobody measured.
 */
const FRAMES = [
  { id: 'cloud', parent: null, arrange: 'stack', rail: null, type: null, always: true,
    stroke: '#242F3E', width: 2, dashed: false, badge: 'Group-AWS-Cloud.svg' },
  { id: 'region', parent: 'cloud', arrange: 'stack', rail: 'regional', type: null,
    always: true, longNote: true,
    stroke: '#00A4A6', width: 2, dashed: false, badge: 'Group-Region.svg' },
  { id: 'vpc', parent: 'region', arrange: 'stack', rail: 'network', type: 'ec2:vpc',
    stroke: '#8C4FFF', width: 2, dashed: true, badge: 'Group-Virtual-private-cloud-VPC.svg' },
  { id: 'az', parent: 'vpc', arrange: 'row', rail: null, type: null, ghost: true,
    stroke: null, width: 1.5, dashed: true, badge: null },
  { id: 'subnet', parent: 'az', arrange: 'stack', rail: null, type: 'ec2:subnet',
    stroke: null, width: 1.5, dashed: true, badge: null },
  { id: 'sg', parent: 'subnet', arrange: 'stack', rail: 'compute', type: 'ec2:security-group',
    stroke: '#DD344C', width: 1.5, dashed: true, badge: null },
  { id: 'ebs', parent: 'az', arrange: 'stack', rail: 'storage', type: null, span: 'column',
    stroke: null, width: 1.5, dashed: true, badge: null },
];

/** Frame id -> the Korean name on its label band. Here rather than in the component, beside the
 *  slot labels, so one file answers "what does this picture call things". */
const FRAME_LABEL = {
  cloud: 'AWS 클라우드',
  region: '리전',
  az: '가용 영역',
  vpc: 'VPC',
  subnet: '서브넷',
  sg: '보안 그룹',
  ebs: 'Amazon EBS',
};

/**
 * Rail id -> the frame whose interior it fills.
 *
 * `edge` is the exception and the only straddling rail in any picture: its one slot sits ON the VPC
 * border rather than inside anything, which is what an internet gateway IS. `link` is the far end
 * of the picture's one arrow, and `from` is the y it starts at - just under the 인터넷 glyph the
 * engine's `sky` leaves room for. Both live here rather than in the engine because they are facts
 * about THIS picture; a topology with no straddle names no link and gets no arrow.
 */
const RAILS = {
  regional: { frame: 'region' },
  network: { frame: 'vpc' },
  compute: { frame: 'sg' },
  storage: { frame: 'ebs' },
  edge: {
    frame: 'vpc',
    straddle: true,
    link: { glyph: 'Res-Internet.svg', label: '인터넷', from: 62 },
  },
};

/**
 * resource_type -> where it goes and what it is called.
 *
 *   kind 'frame'  the type IS one of the frames; its count lands on that frame's label band
 *   kind 'node'   the type is a plate in a rail
 *
 * A type's rail is decided by where AWS actually scopes the resource, which is an AWS fact. The
 * icon is a separate question with a separate answer: `icon: null` is honest and common - the deck
 * has no glyph for a key pair, a launch template, a placement group, a dedicated host, an EC2
 * fleet, a reserved instance, a DHCP option set, a prefix list, a security group rule or an
 * egress-only internet gateway, and those slots render their label alone.
 *
 * Only Res_*_48 glyphs, never an Arch_*_64: an Arch icon is an 80x80 opaque coloured tile and one
 * of those among 48px transparent line glyphs makes a node read as more important than its
 * neighbours for no reason a reader could name.
 *
 * A type absent from this table is NOT drawn. It is named in a foot line under the picture and it
 * gets a row in the table beside it - never nudged into a neighbouring frame, because a raw
 * resource_type does not fit a 120px cell and a mis-sized plate is how a drifted type gets a home
 * it did not earn.
 */
const SLOTS = {
  // The three the frames themselves stand for.
  'ec2:vpc': { kind: 'frame', frame: 'vpc' },
  'ec2:subnet': { kind: 'frame', frame: 'subnet' },
  'ec2:security-group': { kind: 'frame', frame: 'sg' },

  // The boundary. Straddles the VPC border, which is what an internet gateway is.
  'ec2:internet-gateway': { kind: 'node', rail: 'edge', label: ['인터넷 게이트웨이'],
    icon: 'Res-Amazon-VPC-Internet-Gateway.svg' },

  // Inside the security group, because that is what a security group is attached to.
  'ec2:instance': { kind: 'node', rail: 'compute', label: ['인스턴스'],
    icon: 'Res-Amazon-EC2-Instance.svg' },
  'ec2:network-interface': { kind: 'node', rail: 'compute', label: ['네트워크 인터페이스'],
    icon: 'Res-Amazon-VPC-Elastic-Network-Interface.svg' },
  'ec2:security-group-rule': { kind: 'node', rail: 'compute', label: ['보안 그룹 규칙'],
    icon: null },

  // VPC-scoped. Res-Amazon-VPC-Router stands for ec2:route-table: the deck has no route-table
  // glyph, and the VPC router is the same product's own glyph for the same function.
  'ec2:route-table': { kind: 'node', rail: 'network', label: ['라우팅 테이블'],
    icon: 'Res-Amazon-VPC-Router.svg' },
  'ec2:natgateway': { kind: 'node', rail: 'network', label: ['NAT 게이트웨이'],
    icon: 'Res-Amazon-VPC-NAT-Gateway.svg' },
  'ec2:network-acl': { kind: 'node', rail: 'network', label: ['네트워크 ACL'],
    icon: 'Res-Amazon-VPC-Network-Access-Control-List.svg' },
  'ec2:vpc-endpoint': { kind: 'node', rail: 'network', label: ['VPC 엔드포인트'],
    icon: 'Res-Amazon-VPC-Endpoints.svg' },
  'ec2:vpc-peering-connection': { kind: 'node', rail: 'network', label: ['VPC 피어링 연결'],
    icon: 'Res-Amazon-VPC-Peering-Connection.svg' },
  'ec2:elastic-ip': { kind: 'node', rail: 'network', label: ['탄력적 IP'],
    icon: 'Res-Amazon-EC2-Elastic-IP-Address.svg' },
  'ec2:vpn-gateway': { kind: 'node', rail: 'network', label: ['가상 프라이빗', '게이트웨이'],
    icon: 'Res-Amazon-VPC-VPN-Gateway.svg' },
  'ec2:vpn-connection': { kind: 'node', rail: 'network', label: ['사이트 간 VPN 연결'],
    icon: 'Res-Amazon-VPC-VPN-Connection.svg' },
  'ec2:egress-only-internet-gateway': { kind: 'node', rail: 'network',
    label: ['송신 전용', '인터넷 게이트웨이'], icon: null },
  'ec2:dhcp-options': { kind: 'node', rail: 'network', label: ['DHCP 옵션 세트'], icon: null },
  'ec2:prefix-list': { kind: 'node', rail: 'network', label: ['접두사 목록'], icon: null },

  // Availability-zone scoped, which is why the Amazon EBS frame sits beside the 서브넷 inside the
  // 가용 영역. A volume is created in one zone and can only attach to an instance in that zone.
  'ec2:volume': { kind: 'node', rail: 'storage', label: ['볼륨'],
    icon: 'Res-Amazon-Elastic-Block-Store-Volume.svg' },

  // Region-scoped: these belong to no VPC and no availability zone.
  //
  // ec2:snapshot is here and NOT in the storage rail beside the volume it was taken from, which is
  // the placement a reader expects and the one AWS does not have: a snapshot is stored in Amazon S3
  // and scoped to the region (arn:aws:ec2:<region>::snapshot/snap-…, no account, no zone), so
  // drawing it inside 가용 영역 said snapshot blast radius is zone-bounded the way a volume's is.
  //
  // ec2:spot-instances-request and ec2:customer-gateway are here for the same reason and were in
  // the two tightest frames in the picture: a spot request is a region-scoped request that has not
  // become an instance yet, and a customer gateway is the AWS-side record of an ON-PREMISES device,
  // which is the one thing in EC2 that is definitionally outside every VPC.
  'ec2:snapshot': { kind: 'node', rail: 'regional', label: ['스냅샷'],
    icon: 'Res-Amazon-Elastic-Block-Store-Snapshot.svg' },
  'ec2:spot-instances-request': { kind: 'node', rail: 'regional', label: ['스팟 인스턴스 요청'],
    icon: 'Res-Amazon-EC2-Spot-Instance.svg' },
  'ec2:customer-gateway': { kind: 'node', rail: 'regional', label: ['고객 게이트웨이'],
    icon: 'Res-Amazon-VPC-Customer-Gateway.svg' },
  'ec2:image': { kind: 'node', rail: 'regional', label: ['AMI'], icon: 'Res-Amazon-EC2-AMI.svg' },
  'ec2:key-pair': { kind: 'node', rail: 'regional', label: ['키 페어'], icon: null },
  'ec2:launch-template': { kind: 'node', rail: 'regional', label: ['시작 템플릿'], icon: null },
  'ec2:placement-group': { kind: 'node', rail: 'regional', label: ['배치 그룹'], icon: null },
  'ec2:capacity-reservation': { kind: 'node', rail: 'regional', label: ['용량 예약'], icon: null },
  'ec2:host': { kind: 'node', rail: 'regional', label: ['전용 호스트'], icon: null },
  'ec2:fleet': { kind: 'node', rail: 'regional', label: ['EC2 플릿'], icon: null },
  'ec2:reserved-instances': { kind: 'node', rail: 'regional', label: ['예약 인스턴스'], icon: null },
  'ec2:transit-gateway': { kind: 'node', rail: 'regional', label: ['전송 게이트웨이'], icon: null },
  'ec2:transit-gateway-attachment': { kind: 'node', rail: 'regional', label: ['전송 GW 연결'],
    icon: 'Res-AWS-Transit-Gateway-Attachment.svg' },
};

/**
 * EC2 types the neighbouring tables know about that this one deliberately does not draw, with the
 * reason. The drift test reads it: a type in RESOURCE_TYPE_ICONS or the console table must be
 * either a slot here or a written decision here, never an omission nobody made.
 */
export const NO_SLOT = {};

/**
 * The EC2 types AWS scopes to a VPC, mirroring PLACEMENT in impact/inventory.py.
 *
 * Here so an unplaced volume is not counted against the placement lookup: a volume has no VPC by
 * definition, and folding it into "rows with no VPC recorded" would report a permission failure
 * that did not happen. The two tables are pinned against each other by a test.
 */
const PLACEABLE = new Set([
  'ec2:vpc', 'ec2:instance', 'ec2:subnet', 'ec2:security-group', 'ec2:network-interface',
  'ec2:natgateway', 'ec2:route-table', 'ec2:network-acl', 'ec2:vpc-endpoint',
  'ec2:internet-gateway',
]);


/**
 * Where the picture is drawn, what it calls itself, and the sentences that go inside the viewBox.
 *
 * Here rather than in the engine because they are what makes this EC2's picture rather than any
 * picture, and because `caption` and `summaryHome` are read by a screenshot and a screen reader -
 * the two channels a reader cannot check against anything else.
 *
 * `subject`, `home` and `summaryHome` reproduce the engine's former literals exactly, so every
 * sentence this diagram has ever put on screen is unchanged by the extraction.
 */
export const WORDS = {
  subject: 'EC2',
  title: 'EC2',
  home: 'EC2의 일반적인 자리',
  summaryHome: 'EC2의 일반적인 구성 자리',
  caption: captionFor('EC2의 일반적인 자리'),
  omitted: '이 정책이 닿지만 EC2 구성도에 자리가 없는 서비스다.',
};

/**
 * The notes on this picture's label bands, or null.
 *
 * A callback rather than a table because two of the three depend on what the scene measured, and a
 * table of strings would have to be built by the engine, which would put EC2's sentences back in
 * the engine. `ctx` carries only what a note can honestly speak about.
 */
export function noteFor(id, ctx) {
  if (id === 'az') return '평가에 없음';
  if (id === 'cloud') return ctx.accountId ? `계정 ${ctx.accountId}` : null;
  return null;
}

export default {
  kind: 'ec2',
  /** Room above the cloud frame for the internet glyph and its label. */
  sky: 72,
  services: new Set(['ec2']),
  frames: FRAMES,
  frameLabel: FRAME_LABEL,
  rails: RAILS,
  slots: SLOTS,
  noSlot: NO_SLOT,
  placeable: PLACEABLE,
  /** An EC2 instance is in ONE subnet. See subnetsOf in the engine. */
  multiSubnet: false,
  dimensions: ['accounts', 'regions', 'vpcs', 'subnets'],
  words: WORDS,
  noteFor,
  /** Dimensions this data cannot serve. Empty since the querier records placement. */
  unavailable: [],
};

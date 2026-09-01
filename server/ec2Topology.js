// The scene behind "구성도 보기": where each EC2 resource TYPE sits in a canonical EC2 picture.
//
// The impact panel answers "what does this policy reach" as a list, and a list of thirty resource
// types with counts beside them is a true answer nobody reads. This builds the same answer as a
// picture - and the whole difficulty of a picture is that it says more than a list does. A list
// that puts 인스턴스 and 볼륨 on consecutive lines has claimed nothing about them. A picture that
// puts an instance inside a security group inside a subnet inside a VPC has claimed four things,
// and this assessment measured none of them.
//
// So: NOTHING HERE DECIDES WHAT A RESOURCE IS CONNECTED TO. What the module places is the TYPE, at
// the position AWS scopes that type to, which is a fact about EC2 rather than a fact about this
// account. The assessment now records which VPC and which subnet a row sits in - the querier looks
// it up - but it still says nothing about which volume is attached to which instance, and a
// per-resource membership is not what a per-type picture draws anyway: the four dimensions below
// are where those two fields do their work, as a filter over the same picture. Every frame that is
// not measured is drawn dashed and says so, the caption inside the viewBox says so, and
// sceneSummary() says so to a screen reader.
//
// The one thing the nesting DOES assert is AWS's own scoping - Region ⊃ VPC ⊃ 가용 영역 ⊃ 서브넷 -
// and that is a claim the legend makes out loud, so it has to be right. See EC2_FRAMES.
//
// The unit of the picture is the type, never the resource. One slot per ImpactGroup: one glyph, the
// Korean type name, the count. Never forty instance icons, never an ARN, never i-0abc… That is a
// truthfulness decision before it is a scale decision - a picture containing no resource identity
// cannot be read as a claim about a particular resource, however far the screenshot travels - and
// it has the happy consequence that the geometry is constant in inventory size. One instance and
// four thousand instances draw the same picture.
//
// It must NOT consult serviceIcons.js. resourceIconPath('ec2', anything) never returns null: it
// falls through to the service icon, so a type with no glyph of its own would render the
// Amazon-EC2 tile. In a list that is a decoration; in a diagram an EC2 tile sitting inside the
// 보안 그룹 frame is a placement claim about key pairs. A type with no glyph in the deck gets
// icon: null and renders its plate and its label - the same never-guess contract the service table
// keeps, rendered rather than described.
//
// Counts come from group.total, which is what the container recorded (assess.py: total is the
// number of rows it kept, capped at 1000 per query) and a floor when `truncated` says the cap was
// hit. Never from group.resources.length here: the two agree today, and reading the field the
// container publishes is what keeps them agreeing if the container ever learns a true count.
//
// WHAT CAN BE FILTERED. Four dimensions, and every one of them is a fact a container recorded.
//
//   account, region   on every row, from the ARN and from Resource Explorer's own Region
//   vpc, subnet       on the EC2 types AWS scopes to one, from vpc_id / subnet_id
//
// The last two arrive because the querier now asks for them. Resource Explorer's Search returns an
// ARN, a type, a region, an owning account and Properties-as-tags, and no EC2 ARN carries a VPC -
// so impact/inventory.py's _with_placement joins the membership on from the EC2 Describe calls,
// one per operation per region that holds a row of the matching type.
//
// A row with no vpc_id is THREE different things and the filter must not flatten them: the type has
// no VPC at all (a volume, a snapshot, an AMI, a key pair - zone- or region-scoped, and the absence
// is a fact about EC2), the resource is genuinely unattached, or the querier could not look it up
// (the permission is optional, and an older assessment predates the field entirely). unplaced()
// counts the rows in that state so the screen can say how much of the picture a VPC filter cannot
// speak for, rather than silently dropping them.
//
// Plain JS with a .d.ts beside it, same arrangement as blockPath.js and for the same reason:
// node --test is the one test runner here and it cannot load TypeScript. Korean appears in this
// file only as label strings, which is where bucketPolicyGrade.js already puts them.

import { parseArn } from './arn.js';

// ---- geometry ---------------------------------------------------------------------------------
//
// Exported so the tests assert against the real numbers rather than against a copy of them, and so
// the component can hold none: Topology.tsx renders three .maps and a conditional, and every
// coordinate in the output was computed here.

export const SCENE_W = 760;
/** Room above the cloud frame for the internet glyph and its label. */
export const SKY = 72;
export const FRAME_PAD = 14;
/** The label band inside a frame: badge, label, count, note. */
export const FRAME_HEAD = 32;
export const RAIL_GAP = 14;
export const SLOT_W = 120;
export const SLOT_H = 104;
export const SLOT_GAP = 12;
export const ICON = 48;
export const BADGE = 20;
/** One slot plus two pads: the EBS frame holds a single column. */
export const EBS_W = 148;
export const FOOT_LINE = 16;
export const FOOT_PAD = 8;
/** Label units that fit SLOT_W - 8 at 11px. See textUnits. */
export const LABEL_BUDGET = 10.1;
/**
 * Label units that fit ONE foot line, from the same measurement.
 *
 * `.topo-foot` and `.topo-slot-label` are both 11px, so LABEL_BUDGET units per (SLOT_W - 8) pixels
 * is the scale, and a foot line drawn at x = FOOT_PAD has SCENE_W - 2 * FOOT_PAD to live in. Not
 * written as a number: deriving it means a change to SCENE_W or FOOT_PAD moves it too.
 */
export const FOOT_BUDGET = (SCENE_W - 2 * FOOT_PAD) * LABEL_BUDGET / (SLOT_W - 8);

// ---- what gets a picture ----------------------------------------------------------------------

/**
 * The policies this module draws. One entry today, on the operator's direction: EC2 first.
 *
 * Widening it is one entry here plus one test - and a second canonical topology, which is the part
 * that is not free. A load balancer or an RDS instance has a place in an EC2 picture only by
 * accident, and a diagram that invents a home for a resource is the exact failure this feature
 * exists to avoid.
 */
export const DIAGRAMMED_POLICIES = new Set(['AmazonEC2FullAccess']);

/**
 * Which topology a policy identifier gets, or null.
 *
 * The identifier is an ARN for an AWS managed policy and a bare name for a customer managed one,
 * so it is reduced the same way policyName() reduces it for display. Exact set membership, never a
 * substring test: MyAmazonEC2FullAccessCopy is a different policy and gets no picture.
 */
export function topologyPolicy(identifier) {
  if (typeof identifier !== 'string' || !identifier) return null;
  const name = parseArn(identifier)?.name ?? identifier;
  return DIAGRAMMED_POLICIES.has(name) ? 'ec2' : null;
}

// ---- the frames -------------------------------------------------------------------------------

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
 * danger signal. See the legend, which now says so, and frame.sensitiveLabel, which is where a
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
export const EC2_FRAMES = [
  { id: 'cloud', parent: null, arrange: 'stack', rail: null, type: null,
    stroke: '#242F3E', width: 2, dashed: false, badge: 'Group-AWS-Cloud.svg' },
  { id: 'region', parent: 'cloud', arrange: 'stack', rail: 'regional', type: null,
    stroke: '#00A4A6', width: 2, dashed: false, badge: 'Group-Region.svg' },
  { id: 'vpc', parent: 'region', arrange: 'stack', rail: 'network', type: 'ec2:vpc',
    stroke: '#8C4FFF', width: 2, dashed: true, badge: 'Group-Virtual-private-cloud-VPC.svg' },
  { id: 'az', parent: 'vpc', arrange: 'row', rail: null, type: null,
    stroke: null, width: 1.5, dashed: true, badge: null },
  { id: 'subnet', parent: 'az', arrange: 'stack', rail: null, type: 'ec2:subnet',
    stroke: null, width: 1.5, dashed: true, badge: null },
  { id: 'sg', parent: 'subnet', arrange: 'stack', rail: 'compute', type: 'ec2:security-group',
    stroke: '#DD344C', width: 1.5, dashed: true, badge: null },
  { id: 'ebs', parent: 'az', arrange: 'stack', rail: 'storage', type: null,
    stroke: null, width: 1.5, dashed: true, badge: null },
];

/** Frame id -> the Korean name on its label band. Here rather than in the component, beside the
 *  slot labels, so one file answers "what does this picture call things". */
export const FRAME_LABEL = {
  cloud: 'AWS 클라우드',
  region: '리전',
  az: '가용 영역',
  vpc: 'VPC',
  subnet: '서브넷',
  sg: '보안 그룹',
  ebs: 'Amazon EBS',
};

/** Rail id -> the frame whose interior it fills. `edge` is the exception and carries no frame: its
 *  one slot straddles the VPC border rather than sitting inside anything. */
export const EC2_RAILS = {
  regional: { frame: 'region' },
  network: { frame: 'vpc' },
  compute: { frame: 'sg' },
  storage: { frame: 'ebs' },
  edge: { frame: 'vpc', straddle: true },
};

// ---- the slot table ---------------------------------------------------------------------------

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
export const EC2_SLOTS = {
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

// ---- measuring text ---------------------------------------------------------------------------

/**
 * Roughly how many "label units" a line of text occupies, where LABEL_BUDGET is what fits a cell.
 *
 * SVG <text> does not wrap and gives no signal when it overflows, so a label longer than its cell
 * hangs out of the VPC frame in production and nothing anywhere says so. A test runs this over
 * every label in EC2_SLOTS, which turns "somebody will notice eventually" into a failing suite the
 * moment a slot with a long Korean name is added.
 *
 * Hangul syllables are full-width and Latin is not, so the two are counted differently. This is an
 * estimate and only has to be good enough to catch a label that is obviously too long.
 */
export function textUnits(line) {
  if (typeof line !== 'string') return 0;
  let units = 0;
  for (const ch of line) {
    if (ch === ' ') units += 0.4;
    else if (/[ᄀ-ᇿ　-〿㄰-㆏가-힯＀-￯]/.test(ch)) units += 1;
    else units += 0.55;
  }
  return units;
}

// ---- the scene --------------------------------------------------------------------------------

/**
 * The region a row is in.
 *
 * Private on purpose. Impact.tsx:933 and ResourceLine.tsx do the same three-step fallback, and
 * unifying the three copies means touching arn.js and rewriting a live GroupBlock call site - a
 * separate change with its own tests, not a rider on a new feature.
 */
function regionOf(resource) {
  return resource?.region || parseArn(resource?.arn ?? '')?.region || 'global';
}

/** The account a row belongs to, from its ARN. Empty when the ARN does not carry one. */
function accountOf(resource) {
  return parseArn(resource?.arn ?? '')?.account || '';
}

/** The VPC a row sits in, as the querier recorded it. Empty when nothing recorded one. */
function vpcOf(resource) {
  const value = resource?.vpc_id;
  return typeof value === 'string' && value ? value : '';
}

/** The subnet a row sits in. Empty for the types AWS does not scope to one. */
function subnetOf(resource) {
  const value = resource?.subnet_id;
  return typeof value === 'string' && value ? value : '';
}

/**
 * The EC2 types AWS scopes to a VPC, mirroring PLACEMENT in impact/inventory.py.
 *
 * Here so an unplaced volume is not counted against the placement lookup: a volume has no VPC by
 * definition, and folding it into "rows with no VPC recorded" would report a permission failure
 * that did not happen. The two tables are pinned against each other by a test.
 */
export const VPC_SCOPED = new Set([
  'ec2:vpc', 'ec2:instance', 'ec2:subnet', 'ec2:security-group', 'ec2:network-interface',
  'ec2:natgateway', 'ec2:route-table', 'ec2:network-acl', 'ec2:vpc-endpoint',
  'ec2:internet-gateway',
]);

/**
 * What the picture can be narrowed by, and what it cannot.
 *
 * accounts and regions are read off the rows the container enumerated, so they are facts about this
 * assessment and the counts beside them are the same counts the picture draws.
 *
 * unavailable names the dimensions somebody will reasonably ask for and this data cannot serve,
 * WITH the reason. It is a field rather than a sentence on the screen because the screen must not
 * be the place that decides which filters are honest: a control that narrows nothing while looking
 * like it narrowed something is worse than no control, and worse still than a control that says
 * why it is not there.
 */
export function facets(policy) {
  if (topologyPolicy(policy?.identifier) === null) return null;
  const accounts = new Map();
  const regions = new Map();
  const vpcs = new Map();
  const subnets = new Map();
  // Rows the placement lookup says nothing about. Counted rather than dropped: a VPC filter cannot
  // speak for them, and how many there are is the difference between "this VPC holds little" and
  // "most of this picture has no VPC recorded".
  let unplaced = 0;
  let placeable = 0;
  for (const group of policy?.affected ?? []) {
    if (group?.service !== 'ec2') continue;
    const scoped = VPC_SCOPED.has(group.resource_type);
    for (const resource of group.resources ?? []) {
      const account = accountOf(resource);
      const region = regionOf(resource);
      if (account) accounts.set(account, (accounts.get(account) ?? 0) + 1);
      regions.set(region, (regions.get(region) ?? 0) + 1);
      if (!scoped) continue;
      placeable += 1;
      const vpc = vpcOf(resource);
      const subnet = subnetOf(resource);
      if (vpc) vpcs.set(vpc, (vpcs.get(vpc) ?? 0) + 1); else unplaced += 1;
      if (subnet) subnets.set(subnet, (subnets.get(subnet) ?? 0) + 1);
    }
  }
  const listed = (map) => [...map.entries()]
    .map(([id, total]) => ({ id, total }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  return {
    accounts: listed(accounts),
    regions: listed(regions),
    vpcs: listed(vpcs),
    subnets: listed(subnets),
    unplaced,
    placeable,
    unavailable: [],
  };
}

/** Whether a row survives the filter. A null or empty list on a dimension means 전체. */
function keeps(filter, resource) {
  if (!filter) return true;
  const { accounts, regions, vpcs, subnets } = filter;
  if (accounts?.length && !accounts.includes(accountOf(resource))) return false;
  if (regions?.length && !regions.includes(regionOf(resource))) return false;
  // A row with no vpc_id does NOT match a chosen VPC. It is not evidence of belonging and it is not
  // evidence of not belonging - it is the absence of a recording - and the honest answer to "show
  // me what is in vpc-0abc" is the rows that say they are, with a count of the rows that say
  // nothing shown beside the picture rather than folded into it.
  if (vpcs?.length && !vpcs.includes(vpcOf(resource))) return false;
  if (subnets?.length && !subnets.includes(subnetOf(resource))) return false;
  return true;
}

/** Whether any dimension of the filter actually narrows anything. */
export function filterActive(filter) {
  if (!filter) return false;
  return ['accounts', 'regions', 'vpcs', 'subnets']
    .some((dimension) => (filter[dimension]?.length ?? 0) > 0);
}

function countLabel(total, truncated) {
  return truncated ? `${total.toLocaleString()}개 이상†` : `${total.toLocaleString()}개`;
}

/** The marks after a count, each standing for a caveat the group carries. */
function marks(group) {
  return (group.scope === '*' ? '*' : '') + (group.attribution === 'service' ? '⚠' : '');
}

/**
 * Whether the assessment actually enumerated EC2, from its own coverage record.
 *
 * The distinction this exists to keep: a policy with no EC2 groups and a policy whose EC2
 * enumeration FAILED are the same document shape - `affected` simply has no ec2 entry - and they
 * are opposite news. assess.py appends the service to `services_failed` and skips it, so the
 * assessment says which happened and the picture has to ask.
 */
export function ec2Enumerated(coverage) {
  if (!coverage) return true;
  if ((coverage.services_failed ?? []).includes('ec2')) return false;
  return !coverage.services_enumerated?.ec2?.error;
}

/**
 * Everything the window draws, or null when this policy gets no picture.
 *
 * `enumerated` false means the EC2 lookup failed, and the empty picture then says SO rather than
 * saying the policy reaches nothing. An empty scene is otherwise indistinguishable from a failed
 * one, and for AmazonEC2FullAccess - ec2:* on everything - "이 정책이 닿는 EC2 자원이 없다" is the
 * most load-bearing false sentence this feature can produce, printed over a picture somebody
 * screenshots. The panel says the same thing in a banner the modal covers.
 *
 * Deterministic: two calls on the same input deepEqual. Nothing in here reads a clock, a random
 * source, or the length of a capped list.
 */
export function ec2Scene(policy, accountId, filter = null, enumerated = true) {
  if (topologyPolicy(policy?.identifier) === null) return null;
  const narrowed = filterActive(filter);

  // ---- pass 1: bucket ---------------------------------------------------------------------
  const frameCount = new Map();      // frame id -> { total, truncated, marks }
  const railSlots = new Map();       // rail id -> [row]
  const unslotted = [];
  const omittedBy = new Map();       // service -> total
  const regions = new Set();
  const rows = [];                   // every group, for the table beside the picture
  let truncated = false;
  let measured = 0;
  let kinds = 0;

  for (const group of policy?.affected ?? []) {
    // Unfiltered, the count is the field the container publishes. Filtered, it is the rows that
    // survive - which is the SAME quantity, because assess.py sets total to the number of rows it
    // kept. Both are floors when `truncated` says the enumeration hit its cap, and the picture
    // marks them the same way, so narrowing the view never changes how sure a number is.
    const kept = (group?.resources ?? []).filter((r) => keeps(filter, r));
    const total = narrowed ? kept.length : (Number(group?.total) || 0);
    if (group?.service !== 'ec2') {
      // An omitted service is counted whole. Its rows are not EC2 rows and the account/region
      // filter is about the picture, not about the footnote that says what the picture leaves out.
      const whole = Number(group?.total) || 0;
      if (whole > 0) omittedBy.set(group.service, (omittedBy.get(group.service) ?? 0) + whole);
      continue;
    }
    if (total === 0) continue;
    if (group.truncated) truncated = true;
    for (const resource of kept) regions.add(regionOf(resource));
    measured += total;
    kinds += 1;

    const slot = EC2_SLOTS[group.resource_type];
    const row = {
      resourceType: group.resource_type,
      total,
      truncated: !!group.truncated,
      scope: group.scope === '*' ? '*' : 'listed',
      attribution: group.attribution ?? null,
      // Filtered, the sensitive count is counted off the SURVIVING rows and not read from
      // sensitive_hits, which counts the whole group. Reading the group's field through a filter
      // produced "인스턴스 1개 · 민감 2개" - more sensitive resources than resources - and painted
      // a red plate in a region that holds no sensitive resource at all.
      sensitive: narrowed ? kept.filter((r) => r?.sensitive).length
        : (Number(group.sensitive_hits) || 0),
      // A frame-kind type is called by its FRAME's name - 보안 그룹, not ec2:security-group - so
      // the row, the drawing and the screen-reader summary all say the same word about it. The
      // table beside the picture prints the raw resource_type in its own column either way.
      label: slot?.kind === 'frame' ? [FRAME_LABEL[slot.frame]]
        : (slot?.label ?? [group.resource_type]),
      icon: slot?.kind === 'node' ? (slot.icon ?? null) : null,
      rail: slot?.kind === 'node' ? slot.rail : null,
      frame: slot?.kind === 'frame' ? slot.frame : (slot ? EC2_RAILS[slot.rail].frame : null),
      countLabel: countLabel(total, !!group.truncated) + marks(group),
    };
    rows.push(row);

    if (!slot) {
      unslotted.push(row);
      continue;
    }
    if (slot.kind === 'frame') {
      frameCount.set(slot.frame, row);
      continue;
    }
    if (!railSlots.has(slot.rail)) railSlots.set(slot.rail, []);
    railSlots.get(slot.rail).push(row);
  }

  // Stable order everywhere: the slot table's own insertion order inside a rail, biggest first in
  // the lists. Two calls must agree, and a reader comparing two screenshots must not see a
  // reshuffle that means nothing.
  const order = Object.keys(EC2_SLOTS);
  for (const list of railSlots.values()) {
    list.sort((a, b) => order.indexOf(a.resourceType) - order.indexOf(b.resourceType));
  }
  const bySize = (a, b) => b.total - a.total || a.resourceType.localeCompare(b.resourceType);
  unslotted.sort(bySize);
  rows.sort((a, b) => b.total - a.total || a.resourceType.localeCompare(b.resourceType));
  const omitted = [...omittedBy.entries()]
    .map(([service, total]) => ({ service, total }))
    .sort((a, b) => b.total - a.total || a.service.localeCompare(b.service));

  // ---- pass 2: which frames are drawn, and how tall ----------------------------------------
  const byId = new Map(EC2_FRAMES.map((f) => [f.id, f]));
  const kidsOf = (id) => EC2_FRAMES.filter((f) => f.parent === id);
  const railOf = (f) => (f.rail ? (railSlots.get(f.rail) ?? []) : []);
  const igw = (railSlots.get('edge') ?? [])[0] ?? null;

  const drawn = (f) => {
    if (f.id === 'cloud' || f.id === 'region') return true;
    // The availability zone is a position, not a measurement - it is drawn whenever anything it
    // would contain is, and it never carries a count.
    if (f.id === 'az') return kidsOf('az').some(drawn);
    if (f.id === 'vpc' && igw) return true;
    return frameCount.has(f.id) || railOf(f).length > 0 || kidsOf(f.id).some(drawn);
  };

  const widthOf = new Map();
  const xOf = new Map();
  const place = (f, x, w) => {
    xOf.set(f.id, x);
    widthOf.set(f.id, w);
    const inner = x + FRAME_PAD;
    const innerW = w - 2 * FRAME_PAD;
    const kids = kidsOf(f.id).filter(drawn);
    if (f.arrange === 'row' && kids.length === 2) {
      // The only row in the picture: the VPC and Amazon EBS side by side. EBS keeps a fixed width
      // because it holds one column; the VPC takes the rest.
      place(kids[0], inner, innerW - EBS_W - RAIL_GAP);
      place(kids[1], inner + (innerW - EBS_W - RAIL_GAP) + RAIL_GAP, EBS_W);
      return;
    }
    for (const kid of kids) place(kid, inner, kid.id === 'ebs' ? EBS_W : innerW);
  };
  place(byId.get('cloud'), 1, SCENE_W - 2);

  const cols = (f) => Math.max(1, Math.floor(
    (widthOf.get(f.id) - 2 * FRAME_PAD + SLOT_GAP) / (SLOT_W + SLOT_GAP),
  ));
  const railH = (n, c) => (n === 0 ? 0 : Math.ceil(n / c) * SLOT_H + (Math.ceil(n / c) - 1) * SLOT_GAP);
  // The straddling slot's box is centred on ONE border, and BOTH halves need room: the half above
  // the border comes out of the parent's label band, the half below out of the straddled frame's
  // own. Reserving only the upper half is what put the gateway plate 20px into the 서브넷 frame on
  // the ordinary case (an account with instances and a gateway), across a network-rail plate when
  // the Amazon EBS frame narrowed the VPC to three columns, and clean through a VPC drawn only
  // because a detached gateway exists - a 46px frame under a 104px plate. The plate erases what it
  // covers, so each of those was a picture with a border rubbed out and a plate lying across it.
  //
  // Read off EC2_RAILS rather than written as 'vpc', so moving the straddle to another border moves
  // its clearance with it.
  const straddled = EC2_RAILS.edge.frame;
  const straddleParent = byId.get(straddled)?.parent ?? null;
  const headOf = (f) => (igw && (f.id === straddled || f.id === straddleParent)
    ? FRAME_HEAD + SLOT_H / 2 : FRAME_HEAD);

  const heightOf = new Map();
  const measure = (f) => {
    const kids = kidsOf(f.id).filter(drawn);
    for (const kid of kids) measure(kid);
    const kidsH = kids.length === 0 ? 0
      : f.arrange === 'row' ? Math.max(...kids.map((k) => heightOf.get(k.id)))
        : kids.reduce((n, k) => n + heightOf.get(k.id), 0) + RAIL_GAP * (kids.length - 1);
    const rail = railH(railOf(f).length, cols(f));
    const contentH = kidsH + (kidsH > 0 && rail > 0 ? RAIL_GAP : 0) + rail;
    heightOf.set(f.id, headOf(f) + contentH + FRAME_PAD);
  };
  measure(byId.get('cloud'));

  // ---- pass 3: place ------------------------------------------------------------------------
  const frames = [];
  const slots = [];
  const regionList = [...regions].sort();

  const noteFor = (f) => {
    if (f.id === 'az') return '평가에 없음';
    if (f.id === 'cloud') return accountId ? `계정 ${accountId}` : null;
    if (f.id === 'region') {
      if (regionList.length === 0) {
        if (!enumerated) return 'EC2 조회가 실패했다 — 없다는 뜻이 아니다';
        return narrowed ? '고른 조건에 맞는 자원이 없다' : '이 정책이 닿는 EC2 자원이 없다';
      }
      const head = regionList.length === 1 ? regionList[0]
        : `${regionList.length}곳 — ${regionList.slice(0, 3).join(', ')}`
          + (regionList.length > 3 ? ` 외 ${regionList.length - 3}곳` : '');
      // The region set is read off the enumerated rows, which the container caps at 1000. When a
      // group was cut, the set of regions is a floor exactly as the counts are.
      return truncated ? `${head} · 잘린 목록에서 읽은 것이다` : head;
    }
    if (f.type && !frameCount.has(f.id)) return '인벤토리에 없음';
    return null;
  };

  /**
   * How much text a frame's label band can hold, in the units textUnits returns.
   *
   * The band is one <text> that does not wrap and gives no signal when it runs past its frame - the
   * same failure the foot line had, and the same reason: nothing in the layout knows how wide the
   * string is. The Amazon EBS frame is 148px, which its own name nearly fills, so the FIRST note
   * written for it hung out across the region border. A note is the droppable part of a band; the
   * frame's name and its count are not, and a note that does not fit belongs in the legend beside
   * the picture, which has room.
   *
   * `.topo-frame-text` is 12px against the 11px LABEL_BUDGET was measured at, so the budget scales
   * by 11/12. The label starts at 34px in when there is a badge, and the band needs a right pad.
   */
  const bandBudget = (f) => (widthOf.get(f.id) - (f.badge ? 34 : 10) - FRAME_PAD)
    * (LABEL_BUDGET / (SLOT_W - 8)) * (11 / 12);
  const bandText = (f, count, sensitive) => `${FRAME_LABEL[f.id]}`
    + (count ? `  ${count.countLabel}` : '') + (sensitive > 0 ? `  민감 ${sensitive}개` : '');

  const walk = (f, y) => {
    const x = xOf.get(f.id);
    const w = widthOf.get(f.id);
    const h = heightOf.get(f.id);
    const count = frameCount.get(f.id) ?? null;
    const sensitive = count?.sensitive ?? 0;
    const raw = noteFor(f);
    // Dropped rather than clipped when it does not fit. Every note this module writes is also said
    // somewhere with room - the region list in the frame's title, the rest in the legend.
    const note = raw && textUnits(`${bandText(f, count, sensitive)}  ${raw}`) <= bandBudget(f)
      ? raw : null;
    frames.push({
      id: f.id,
      x, y, w, h,
      stroke: f.stroke,
      width: f.width,
      dashed: f.dashed,
      badge: f.badge,
      label: FRAME_LABEL[f.id],
      count: count ? count.countLabel : null,
      note,
      // The one frame that is a position rather than a measurement. The renderer fades it, so the
      // field carries the intention its name always claimed instead of being read by one assertion.
      ghost: f.id === 'az',
      // A COUNT, not a flag, and rendered on the label band rather than as a border colour. The
      // legend promised 빨간 테두리 for sensitive resources while the 보안 그룹 border was red
      // unconditionally and no frame ever turned red for being sensitive - false in both
      // directions, and the sensitive thread is the one the panel force-opens the block for.
      sensitive,
      title: f.id === 'region' && regionList.length > 3 ? regionList.join(', ') : null,
    });

    const kids = kidsOf(f.id).filter(drawn);
    const top = y + headOf(f);
    if (f.arrange === 'row') {
      for (const kid of kids) walk(kid, top);
    } else {
      let cursor = top;
      for (const kid of kids) {
        walk(kid, cursor);
        cursor += heightOf.get(kid.id) + RAIL_GAP;
      }
    }
    const kidsH = kids.length === 0 ? 0
      : f.arrange === 'row' ? Math.max(...kids.map((k) => heightOf.get(k.id)))
        : kids.reduce((n, k) => n + heightOf.get(k.id), 0) + RAIL_GAP * (kids.length - 1);

    const rail = railOf(f);
    if (rail.length > 0) {
      const c = cols(f);
      const y0 = top + kidsH + (kidsH > 0 ? RAIL_GAP : 0);
      rail.forEach((row, i) => {
        slots.push({
          key: row.resourceType,
          resourceType: row.resourceType,
          x: x + FRAME_PAD + (i % c) * (SLOT_W + SLOT_GAP),
          y: y0 + Math.floor(i / c) * (SLOT_H + SLOT_GAP),
          w: SLOT_W,
          h: SLOT_H,
          icon: row.icon,
          label: row.label,
          count: row.countLabel,
          sensitive: row.sensitive > 0,
          erase: false,
          title: `${row.resourceType} — ${row.label.join(' ')} ${row.countLabel}`
            + (row.sensitive > 0 ? `, 민감 ${row.sensitive}` : ''),
        });
      });
    }
  };
  walk(byId.get('cloud'), SKY);

  // The one slot that is not inside anything. Its vertical centre sits exactly on the VPC border,
  // which is what an internet gateway is; `erase` tells the renderer to knock the border out from
  // under it so position itself is the statement and no arrow has to say "this is the boundary".
  let link = null;
  if (igw) {
    const vpc = frames.find((f) => f.id === 'vpc');
    const x = vpc.x + vpc.w - FRAME_PAD - SLOT_W;
    const y = vpc.y - SLOT_H / 2;
    slots.push({
      key: 'ec2:internet-gateway',
      resourceType: 'ec2:internet-gateway',
      x, y, w: SLOT_W, h: SLOT_H,
      icon: igw.icon,
      label: igw.label,
      count: igw.countLabel,
      sensitive: igw.sensitive > 0,
      erase: true,
      title: `${igw.resourceType} — ${igw.label.join(' ')} ${igw.countLabel}`,
    });
    const cx = x + SLOT_W / 2;
    link = { cx, glyph: 'Res-Internet.svg', label: '인터넷', from: 62, to: y };
  }

  // ---- the foot lines, inside the viewBox ---------------------------------------------------
  const cloud = frames.find((f) => f.id === 'cloud');
  const foot = [];
  if (unslotted.length > 0) {
    // Named until the line fits, and `외 N종` absorbs whatever that drops. This is the one line in
    // the picture whose length is unbounded by anything the repository controls - it prints raw
    // resource_type strings, and three real Resource Explorer EC2 types
    // (ec2:network-insights-access-scope-analysis and its kind) run past 760px on their own. SVG
    // <text> does not wrap and the outer <svg> is exactly SCENE_W wide, so the overflow was clipped
    // silently, and what got cut was the `외 N종` - the accounting this line exists to give.
    const line = (names, n) => `그림에 자리가 없는 유형: ${names.join(' · ')}`
      + (unslotted.length > n ? ` 외 ${unslotted.length - n}종` : '');
    const named = (r) => `${r.resourceType} ${r.total.toLocaleString()}개`;
    let n = Math.min(3, unslotted.length);
    let text = line(unslotted.slice(0, n).map(named), n);
    while (textUnits(text) > FOOT_BUDGET && n > 1) {
      n -= 1;
      text = line(unslotted.slice(0, n).map(named), n);
    }
    // One name can be longer than the whole line on its own, and then there is nothing left to
    // drop. Resource Explorer's longest real EC2 type fits, but "the values are short in practice"
    // is the reasoning that clipped this line in the first place, so the name is cut instead - in
    // the LINE only. scene.unslotted and the table beside the picture keep the true type, which is
    // what the reader checks the picture against.
    let cut = unslotted[0].resourceType;
    while (textUnits(text) > FOOT_BUDGET && cut.length > 8) {
      cut = cut.slice(0, -2);
      text = line([`${cut}… ${unslotted[0].total.toLocaleString()}개`], 1);
    }
    foot.push(text);
  }
  if (omitted.length > 0) {
    const total = omitted.reduce((n, o) => n + o.total, 0);
    // "표 아래에" and not "아래 표에": the table beside the picture is EC2-only by construction, so
    // the line that survives a crop must not send the reader to a table that cannot hold what it
    // promises. The omitted services are listed in their own paragraph after it.
    foot.push(`그림 밖 서비스 ${omitted.length}종 · 자원 ${total.toLocaleString()}개 — 표 아래에 적었다.`);
  }
  foot.push(CAPTION);

  const footTop = SKY + cloud.h + FOOT_PAD;
  const footLines = foot.map((text, i) => ({ text, y: footTop + 12 + i * FOOT_LINE }));

  return {
    width: SCENE_W,
    height: footTop + foot.length * FOOT_LINE + FOOT_PAD,
    frames,
    slots,
    link,
    foot: footLines,
    rows,
    unslotted,
    omitted,
    regions: regionList,
    truncated,
    measured,
    kinds,
    empty: kinds === 0,
    /** Whether a filter narrowed this scene. The screen says so; an empty picture that is empty
     *  BECAUSE of a filter must not read as "this policy reaches nothing". */
    narrowed,
    /** Whether the assessment enumerated EC2 at all. False makes an empty picture a statement
     *  about the LOOKUP and not about the policy - see ec2Enumerated. */
    enumerated,
  };
}

/**
 * The caption, drawn INSIDE the viewBox.
 *
 * The no-identities rule is a strong screenshot defence and not a complete one - a 보안 그룹 frame
 * with 인스턴스 40개 in it still travels - and a caveat in the dialog body does not travel with a
 * cropped image. This one does.
 */
export const CAPTION =
  '이 그림은 자원 유형을 EC2의 일반적인 자리에 놓은 것이다. 테두리의 포함 관계는 측정한 것이 아니다.';

/**
 * The <desc>: what a screen reader is told the picture shows.
 *
 * Pure, so the text a non-sighted approver gets is unit-tested rather than hoped for. It ends on
 * the same caveat the caption carries, because that is the sentence that must not be the one thing
 * a reader misses.
 */
export function sceneSummary(scene) {
  if (!scene) return '';
  // An empty picture has THREE causes and they are not the same news. "This policy reaches nothing"
  // is a fact about the policy; "the filter matched nothing" is a fact about the filter; "the
  // lookup failed" is a fact about the assessment, and reading either of the last two as the first
  // would tell an approver a policy is harmless.
  if (scene.empty) {
    if (!scene.enumerated) {
      return '이 평가는 EC2 자원 조회에 실패해서 그릴 것이 없다. 이 정책이 닿는 자원이 없다는 '
        + '뜻이 아니다. 계정과 리전 테두리만 그렸다.';
    }
    return scene.narrowed
      ? '고른 계정과 리전에 이 정책이 닿는 EC2 자원이 없다. 계정과 리전 테두리만 그렸다.'
      : '이 정책이 닿는 EC2 자원이 인벤토리에 없다. 계정과 리전 테두리만 그렸다.';
  }
  const placed = [
    ...scene.frames.filter((f) => f.count).map((f) => `${f.label} ${f.count}`),
    ...scene.slots.map((s) => `${s.label.join(' ')} ${s.count}`),
  ].join(', ');
  // A truncated enumeration makes BOTH numbers floors, and the sighted reader is told so twice -
  // by the † on every count and by the region band. This is the one channel that gets no picture,
  // so it must not be the one that states the floor as a total.
  const floor = scene.truncated ? ' 이상' : '';
  const region = scene.regions.length === 1
    ? `리전은 ${scene.regions[0]} 한 곳이다`
    : `리전은 ${scene.regions.length}곳이고 개수는 그것을 합친 수다`;
  return `이 정책이 닿는 EC2 자원 ${scene.kinds}종 ${scene.measured.toLocaleString()}개${floor}를 `
    + `EC2의 일반적인 구성 자리에 놓은 그림이다. ${region}`
    + (scene.truncated ? ' — 잘린 목록에서 읽은 하한이다' : '') + '. '
    // Empty when every type this policy reaches is one the picture has no slot for: the sentence
    // then said "…자리에 놓은 그림이다" about nothing placed, and left a stray ". ." behind it.
    + (placed ? `${placed}. ` : '')
    + (scene.unslotted.length > 0 ? `그림에 자리가 없는 유형 ${scene.unslotted.length}종. ` : '')
    + (scene.omitted.length > 0 ? `그림 밖 서비스 ${scene.omitted.length}종. ` : '')
    + '테두리의 포함 관계는 측정한 것이 아니다.';
}

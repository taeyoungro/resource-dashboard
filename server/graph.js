// The relationship picture behind "구성도 보기": one node per RESOURCE, one line per CONNECTION.
//
// topology.js draws types - "인스턴스 40개" as one plate - and that picture claims nothing about
// which instance is where or what it is attached to. This one claims exactly that, and it may,
// because the querier now READS it: every line here is a (relation, target) pair
// impact/inventory.py lifted off a Describe answer as a first-class field (Resource.links), and
// every container is a vpc_id / subnet_id / zone the same lookup recorded. Nothing in this file
// decides what is connected to what. It draws what was measured and counts what was not.
//
// So the grammar flips from the type picture. Here a SOLID border is the ordinary case - a VPC, a
// zone, a subnet the querier placed rows into - and the only dashed things are a subnet the
// assessment holds no row for (resources say they are in it; the subnet itself was not reached)
// and an implicit route-table association (a subnet with no explicit association uses the VPC's
// main table; AWS marks the main table, and this file derives the edge and says it derived it).
//
// SCALE IS THE PRICE. The type picture was constant in inventory size; this one grows with it, and
// a policy like AmazonEC2FullAccess on a busy account reaches thousands of rows. Two answers:
// the same filter the type picture has (account, region, VPC, subnet) narrows the population, and
// past NODE_BUDGET / EDGE_BUDGET the picture stops and SAYS how much it left out, per container.
// It never silently draws a prefix.
//
// Identity is on the picture on purpose - the operator asked for the connections, and a
// connection between two anonymous plates is not one. Every node carries its id; its Name tag when
// it has one; its ARN in the hover title. That reverses the type picture's screenshot defence, and
// the caption inside the viewBox says what the picture is instead.
//
// Plain JS with a .d.ts beside it, like topology.js and for the same reason.

import { parseArn } from './arn.js';
import { TOPOLOGIES, filterActive, keeps, specOf } from './topology.js';

// ---- geometry ---------------------------------------------------------------------------------

export const GRAPH_W = 1400;
export const NODE_W = 116;
export const NODE_H = 76;
export const NODE_GAP = 10;
export const PAD = 12;
/** The label band of a container. */
export const HEAD = 26;
export const ROW_GAP = 12;
export const G_ICON = 28;
/** How far from a plate's corner a line may leave it: a line into a corner reads as a line into
 *  the neighbour. */
export const ANCHOR_INSET = 10;
/** How close a line may pass to a plate it does not end at before it counts as grazing it. */
export const GRAZE = 6;
export const G_FOOT_LINE = 16;
export const G_FOOT_PAD = 8;

/** Past these the picture stops adding and says so. Both are counts of what is DRAWN. */
export const NODE_BUDGET = 400;
export const EDGE_BUDGET = 700;
/** Instance cards per subnet before the subnet folds the rest into one plate. */
export const CARDS_PER_SUBNET = 60;

// ---- what an edge is --------------------------------------------------------------------------

/**
 * Relation -> how the picture draws it. `kind` is the class the renderer styles; `from` says which
 * end the recorded row is on, so "instance links volume" and "volume links instance" (both are
 * recorded, from two Describes) become ONE edge, deduplicated by (kind, a, b).
 *
 * `image` and `security_group` are the two that can flood a picture - every instance has one AMI
 * and one to five groups - so they are the first to go under EDGE_BUDGET, in this order.
 */
export const RELATIONS = {
  network_interface: { kind: 'interface', label: '네트워크 인터페이스' },
  instance: { kind: 'interface', label: '인스턴스에 붙음', reverse: true },
  volume: { kind: 'volume', label: '볼륨' },
  security_group: { kind: 'security', label: '보안 그룹' },
  subnet: { kind: 'association', label: '서브넷에 연결' },
  main: { kind: 'association', label: '기본 라우팅 테이블', implicit: true },
  default: { kind: 'association', label: '기본 네트워크 ACL', vpcFlag: true },
  route_table: { kind: 'association', label: '라우팅 테이블' },
  internet_gateway: { kind: 'route', label: '인터넷 게이트웨이로 가는 경로' },
  nat_gateway: { kind: 'route', label: 'NAT 게이트웨이로 가는 경로' },
  image: { kind: 'image', label: 'AMI' },
};

/** The order edges are dropped in when the budget is hit: least load-bearing first. */
const DROP_ORDER = ['image', 'security', 'route', 'association', 'interface', 'volume'];

// ---- reading rows -----------------------------------------------------------------------------

/** The id a link targets: the ARN's last path segment. i-…, eni-…, subnet-…, vol-…. */
export function idOf(arn) {
  if (typeof arn !== 'string') return '';
  const rest = arn.split(':').slice(5).join(':');
  const tail = rest.slice(rest.lastIndexOf('/') + 1);
  return tail || rest;
}

function regionOf(resource) {
  return resource?.region || parseArn(resource?.arn ?? '')?.region || 'global';
}
function vpcOf(r) { return typeof r?.vpc_id === 'string' && r.vpc_id ? r.vpc_id : ''; }
function subnetOf(r) { return typeof r?.subnet_id === 'string' && r.subnet_id ? r.subnet_id : ''; }
function zoneOf(r) { return typeof r?.zone === 'string' && r.zone ? r.zone : ''; }
function nameOf(r) {
  const tag = r?.tags?.Name;
  return typeof tag === 'string' && tag.trim() ? tag.trim() : '';
}

/** `i-0123456789abcdef0` -> `i-01234…def0`. Whole ids up to 15 characters are kept. */
export function shortId(id) {
  if (typeof id !== 'string') return '';
  if (id.length <= 15) return id;
  return `${id.slice(0, 9)}…${id.slice(-4)}`;
}

/** A Name tag cut to what fits a node, with an ellipsis that says it was cut. */
export function shortName(name) {
  if (name.length <= 14) return name;
  return `${name.slice(0, 13)}…`;
}

// ---- the scene --------------------------------------------------------------------------------

/**
 * Everything the relationship window draws, or null when this policy gets no picture.
 *
 * Only the EC2 picture today: it is the one whose querier records links. The gate is the same
 * one topology.js uses, so the two views open on exactly the same policies.
 *
 * Deterministic: two calls on the same input deepEqual. Every list is sorted by id before layout.
 */
export function relationScene(policy, accountId, filter = null, enumerated = true) {
  const spec = specOf(policy);
  if (!spec || spec.kind !== 'ec2') return null;
  const narrowed = filterActive(filter);

  // ---- 1. rows -> nodes --------------------------------------------------------------------
  const nodes = new Map();          // id -> node
  const byType = new Map();         // resource_type -> [id]
  const regions = new Set();
  let linkedRows = 0;
  let placedRows = 0;
  let kinds = 0;
  let measured = 0;
  const omittedServices = new Map();
  for (const group of policy?.affected ?? []) {
    if (!spec.services.has(group?.service)) {
      const whole = Number(group?.total) || 0;
      if (whole > 0) omittedServices.set(group.service, (omittedServices.get(group.service) ?? 0) + whole);
      continue;
    }
    const type = group.resource_type;
    const kept = (group?.resources ?? []).filter((r) => keeps(filter, r));
    if (kept.length === 0) continue;
    kinds += 1;
    measured += narrowed ? kept.length : (Number(group?.total) || 0);
    for (const r of kept) {
      const id = idOf(r.arn);
      if (!id || nodes.has(id)) continue;
      regions.add(regionOf(r));
      const links = r?.links && typeof r.links === 'object' ? r.links : {};
      if (Object.keys(links).length > 0) linkedRows += 1;
      if (vpcOf(r) || subnetOf(r) || zoneOf(r)) placedRows += 1;
      const slot = spec.slots[type];
      nodes.set(id, {
        id,
        resourceType: type,
        typeLabel: slot?.kind === 'frame' ? spec.frameLabel[slot.frame]
          : (slot?.label?.join(' ') ?? type),
        icon: slot?.kind === 'node' ? (slot.icon ?? null) : null,
        name: nameOf(r),
        arn: r.arn,
        region: regionOf(r),
        vpc: vpcOf(r),
        subnet: subnetOf(r),
        zone: zoneOf(r),
        sensitive: !!r.sensitive,
        links,
      });
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(id);
    }
  }
  for (const list of byType.values()) list.sort();
  const ids = [...nodes.keys()].sort();

  // ---- 2. containers, measured off the rows ------------------------------------------------
  // A VPC container per vpc id any row names; a zone per (vpc, zone); a subnet per subnet id.
  // The container's row - the ec2:vpc / ec2:subnet resource itself - may or may not be in the
  // assessment: a subnet named by an instance but not reached by the policy still gets a frame,
  // drawn dashed and labelled 평가에 없음, because its instances are inside SOMETHING.
  const vpcIds = new Set();
  const subnetInfo = new Map();     // subnet id -> { vpc, zone, present }
  for (const id of ids) {
    const n = nodes.get(id);
    if (n.resourceType === 'ec2:vpc') vpcIds.add(id);
    if (n.vpc) vpcIds.add(n.vpc);
    if (n.resourceType === 'ec2:subnet') {
      subnetInfo.set(id, { vpc: n.vpc, zone: n.zone, present: true });
    }
  }
  for (const id of ids) {
    const n = nodes.get(id);
    if (!n.subnet) continue;
    const info = subnetInfo.get(n.subnet) ?? { vpc: '', zone: '', present: false };
    if (!info.vpc && n.vpc) info.vpc = n.vpc;
    if (!info.zone && n.zone) info.zone = n.zone;
    subnetInfo.set(n.subnet, info);
    if (info.vpc) vpcIds.add(info.vpc);
  }

  // ---- 3. where each node goes -------------------------------------------------------------
  // Containment is what the row SAYS. A subnet-scoped row goes in its subnet; a VPC-scoped row
  // with no subnet goes in the VPC band; a row with a zone and no VPC (a volume) goes beside the
  // instance it is attached to when that instance is drawn, else in the region band with its
  // zone in the label; a row with neither goes in the region band.
  const attachedTo = new Map();      // volume id -> instance id, from either side's links
  for (const id of ids) {
    const n = nodes.get(id);
    if (n.resourceType === 'ec2:instance') {
      for (const v of n.links.volume ?? []) if (nodes.has(v)) attachedTo.set(v, id);
    }
    if (n.resourceType === 'ec2:volume') {
      for (const i of n.links.instance ?? []) if (nodes.has(i)) attachedTo.set(id, i);
    }
  }
  const eniOf = new Map();           // instance id -> [eni ids], from either side
  for (const id of ids) {
    const n = nodes.get(id);
    if (n.resourceType === 'ec2:instance') {
      for (const e of n.links.network_interface ?? []) {
        if (!nodes.has(e)) continue;
        if (!eniOf.has(id)) eniOf.set(id, new Set());
        eniOf.get(id).add(e);
      }
    }
    if (n.resourceType === 'ec2:network-interface') {
      for (const i of n.links.instance ?? []) {
        if (!nodes.has(i)) continue;
        if (!eniOf.has(i)) eniOf.set(i, new Set());
        eniOf.get(i).add(id);
      }
    }
  }
  const claimed = new Set();         // ids drawn inside an instance card
  for (const [, set] of eniOf) for (const e of set) claimed.add(e);
  for (const [v] of attachedTo) claimed.add(v);

  const BAND_TYPES = new Set(['ec2:security-group', 'ec2:route-table', 'ec2:network-acl',
                              'ec2:vpc-endpoint', 'ec2:internet-gateway', 'ec2:vpc']);
  const placeOf = (n) => {
    if (n.resourceType === 'ec2:vpc') return null;                 // the container itself
    if (n.resourceType === 'ec2:subnet') return null;              // the container itself
    if (n.resourceType === 'ec2:internet-gateway') return n.vpc ? { edge: n.vpc } : { region: true };
    if (claimed.has(n.id)) return { card: true };
    if (n.subnet && subnetInfo.has(n.subnet)) return { subnet: n.subnet };
    if (n.vpc && (BAND_TYPES.has(n.resourceType) || !n.subnet)) return { vpcBand: n.vpc };
    return { region: true };
  };

  // ---- 4. layout -----------------------------------------------------------------------------
  const containers = [];
  const placedNodes = [];
  const overflow = [];               // { container, count } for what the budget left out
  let drawnNodes = 0;
  const budgetLeft = () => drawnNodes < NODE_BUDGET;

  const innerW = GRAPH_W - 2;
  const regionX = 1 + PAD;
  const regionW = innerW - 2 * PAD;
  let y = PAD;                       // running y inside the region

  const cloud = { id: 'cloud', kind: 'cloud', label: 'AWS 클라우드',
                  note: accountId ? `계정 ${accountId}` : null, x: 1, y: 8, w: innerW, h: 0,
                  stroke: '#242F3E', dashed: false, badge: 'Group-AWS-Cloud.svg', measured: true };
  const regionList = [...regions].sort();
  const regionNote = regionList.length === 0
    ? (!enumerated ? 'EC2 조회가 실패했다 — 없다는 뜻이 아니다'
      : narrowed ? '고른 조건에 맞는 자원이 없다' : '이 정책이 닿는 EC2 자원이 없다')
    : regionList.length === 1 ? regionList[0]
      : `${regionList.length}곳 — ${regionList.slice(0, 3).join(', ')}`
        + (regionList.length > 3 ? ` 외 ${regionList.length - 3}곳` : '');
  const region = { id: 'region', kind: 'region', label: '리전', note: regionNote,
                   x: cloud.x + PAD, y: cloud.y + HEAD + 4, w: innerW - 2 * PAD, h: 0,
                   stroke: '#00A4A6', dashed: false, badge: 'Group-Region.svg', measured: true };
  containers.push(cloud, region);
  y = region.y + HEAD;

  /** Lay a list of "cards" (each {ids, w, h, place(x,y)}) into rows inside width w. */
  const flow = (cards, x0, y0, w) => {
    let cx = x0;
    let cy = y0;
    let rowH = 0;
    for (const card of cards) {
      if (cx + card.w > x0 + w && cx > x0) {
        cx = x0;
        cy += rowH + NODE_GAP;
        rowH = 0;
      }
      card.place(cx, cy);
      cx += card.w + NODE_GAP;
      rowH = Math.max(rowH, card.h);
    }
    return cards.length === 0 ? 0 : (cy - y0) + rowH;
  };
  const nodeCard = (id, extra = {}) => ({
    ids: [id], w: NODE_W, h: NODE_H,
    place: (x, yy) => { emit(id, x, yy, extra); },
  });
  const emit = (id, x, yy, extra = {}) => {
    const n = nodes.get(id);
    placedNodes.push({
      id, resourceType: n.resourceType, typeLabel: n.typeLabel, icon: n.icon,
      label: n.name ? shortName(n.name) : shortId(id),
      // The zone is worth a line only where nothing around the node says it - the region band. A
      // volume drawn beside its instance is in that instance's zone, and the subnet frame says so.
      sub: n.name ? shortId(id) : (extra.zoneSub && n.zone ? n.zone : n.typeLabel),
      x, y: yy, w: extra.w ?? NODE_W, h: extra.h ?? NODE_H, sensitive: n.sensitive, arn: n.arn,
      title: `${n.typeLabel} ${id}${n.name ? ` (${n.name})` : ''}` + (n.zone ? ` · ${n.zone}` : '')
        + `\n${n.arn}`,
      erase: !!extra.erase,
      // A box rather than a plate: an instance, drawn as a frame with its interfaces inside.
      box: !!extra.box,
      holds: extra.holds ?? 0,
      note: extra.note ?? null,
    });
    drawnNodes += 1;
  };
  const overflowCard = (containerId, count) => ({
    ids: [], w: NODE_W, h: NODE_H,
    place: (x, yy) => {
      overflow.push({ container: containerId, count, x, y: yy, w: NODE_W, h: NODE_H,
                      label: `외 ${count.toLocaleString()}개` });
    },
  });
  /**
   * An instance and everything drawn with it. The instance is a BOX holding its interfaces: an
   * interface's Attachment.InstanceId is a recorded membership, and a border is what this picture
   * says a recorded membership with - so the interfaces sit inside, in rows that wrap to the width
   * the box is given, and no line is drawn to them. Volumes hang below the box, left-aligned: a
   * disk is attached, not contained, and its line is the one an approver most wants to see.
   *
   * An instance whose interfaces are not in the assessment - the policy does not reach them, or
   * the assessment predates the links - is a box of plate height holding one sentence, so it
   * cannot be read as an instance with no interface.
   */
  const instanceCard = (id, innerW, extra = {}) => {
    const enis = [...(eniOf.get(id) ?? [])].sort();
    const vols = ids.filter((v) => attachedTo.get(v) === id);
    const cols = Math.max(1, Math.min(enis.length,
      Math.floor((innerW - 2 * PAD + NODE_GAP) / (NODE_W + NODE_GAP))));
    const rows = Math.ceil(enis.length / cols);
    const boxW = cols * NODE_W + (cols - 1) * NODE_GAP + 2 * PAD;
    const boxH = enis.length > 0 ? HEAD + PAD + rows * NODE_H + (rows - 1) * NODE_GAP + PAD : NODE_H;
    return {
      ids: [id, ...enis, ...vols],
      w: boxW,
      h: boxH + vols.length * (NODE_H + NODE_GAP),
      place: (x, yy) => {
        emit(id, x, yy, { ...extra, box: true, w: boxW, h: boxH, holds: enis.length,
                          note: enis.length > 0 ? null : '네트워크 인터페이스가 이 평가에 없다' });
        enis.forEach((e, i) => emit(e, x + PAD + (i % cols) * (NODE_W + NODE_GAP),
                                    yy + HEAD + PAD + Math.floor(i / cols) * (NODE_H + NODE_GAP)));
        vols.forEach((v, i) => emit(v, x, yy + boxH + NODE_GAP + i * (NODE_H + NODE_GAP)));
      },
    };
  };
  /** The card for a row, once the width it may take is known. */
  const cardFor = (id, innerW, extra = {}) => (nodes.get(id).resourceType === 'ec2:instance'
    ? instanceCard(id, innerW, extra) : nodeCard(id, extra));

  // Members per subnet, per VPC band, per region band. Cards are made at layout time, when the
  // width a container offers is known - an instance box wraps its interfaces to that width.
  const subnetMembers = new Map();   // subnet id -> [id]
  const bandMembers = new Map();     // vpc id -> [id]
  const regionMembers = [];
  const edgeNodes = new Map();       // vpc id -> igw id (straddles the VPC top border)
  const push = (map, key, id) => { if (!map.has(key)) map.set(key, []); map.get(key).push(id); };
  for (const id of ids) {
    const n = nodes.get(id);
    const at = placeOf(n);
    if (at === null || at.card) continue;
    if (at.edge) { if (!edgeNodes.has(at.edge)) edgeNodes.set(at.edge, id); else regionMembers.push(id); continue; }
    if (at.subnet) push(subnetMembers, at.subnet, id);
    else if (at.vpcBand) push(bandMembers, at.vpcBand, id);
    else regionMembers.push(id);
  }

  // Order inside a subnet: instances first (they are the hubs), then everything else, each by id.
  const isInstance = (id) => (nodes.get(id).resourceType === 'ec2:instance' ? 0 : 1);
  for (const [, members] of subnetMembers) {
    members.sort((a, b) => isInstance(a) - isInstance(b) || a.localeCompare(b));
  }
  // Order inside a VPC band: security groups, route tables, ACLs, endpoints, the rest.
  const BAND_ORDER = ['ec2:security-group', 'ec2:route-table', 'ec2:network-acl', 'ec2:vpc-endpoint'];
  for (const [, members] of bandMembers) {
    members.sort((a, b) => {
      const ai = BAND_ORDER.indexOf(nodes.get(a).resourceType);
      const bi = BAND_ORDER.indexOf(nodes.get(b).resourceType);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    });
  }

  /** Cut a card list to what the budget allows, folding the rest into one overflow plate. */
  const budgeted = (cards, containerId, cap = Infinity) => {
    const out = [];
    let dropped = 0;
    for (const card of cards) {
      if (out.length < cap && drawnNodes + tally(out) + card.ids.length <= NODE_BUDGET) out.push(card);
      else dropped += Math.max(1, card.ids.length);
    }
    if (dropped > 0) out.push(overflowCard(containerId, dropped));
    return out;
  };
  const tally = (cards) => cards.reduce((n, c) => n + c.ids.length, 0);

  // VPCs, in id order, stacked down the region.
  const vpcList = [...vpcIds].sort();
  for (const vpcId of vpcList) {
    const vpcRow = nodes.get(vpcId);
    const vpcTop = y + (edgeNodes.has(vpcId) ? NODE_H / 2 : 0);
    const vpc = { id: `vpc:${vpcId}`, kind: 'vpc',
                  label: vpcRow?.name ? `VPC ${shortName(vpcRow.name)}` : 'VPC',
                  note: vpcRow ? vpcId : `${vpcId} · 평가에 없음`,
                  x: regionX, y: vpcTop, w: regionW, h: 0,
                  stroke: '#8C4FFF', dashed: !vpcRow, badge: 'Group-Virtual-private-cloud-VPC.svg',
                  measured: true, title: vpcRow?.arn ?? null };
    containers.push(vpc);
    let cy = vpc.y + HEAD + (edgeNodes.has(vpcId) ? NODE_H / 2 : 0);

    // The VPC band: groups, tables, ACLs, endpoints.
    const band = budgeted((bandMembers.get(vpcId) ?? []).map((id) => cardFor(id, vpc.w - 2 * PAD)), vpc.id);
    const bandH = flow(band, vpc.x + PAD, cy, vpc.w - 2 * PAD);
    if (bandH > 0) cy += bandH + ROW_GAP;

    // Zones side by side, each a stack of subnets.
    const zoneIds = [...new Set([...subnetInfo.entries()]
      .filter(([, i]) => i.vpc === vpcId).map(([, i]) => i.zone || '?'))].sort();
    const zoneW = zoneIds.length > 0
      ? (vpc.w - 2 * PAD - NODE_GAP * (zoneIds.length - 1)) / zoneIds.length : 0;
    let zonesH = 0;
    zoneIds.forEach((zone, zi) => {
      const zx = vpc.x + PAD + zi * (zoneW + NODE_GAP);
      const az = { id: `az:${vpcId}:${zone}`, kind: 'az', label: '가용 영역',
                   note: zone === '?' ? '영역을 읽지 못했다' : zone,
                   x: zx, y: cy, w: zoneW, h: 0, stroke: null, dashed: zone === '?',
                   badge: null, measured: zone !== '?' };
      containers.push(az);
      let sy = az.y + HEAD;
      const subnetsHere = [...subnetInfo.entries()]
        .filter(([, i]) => i.vpc === vpcId && (i.zone || '?') === zone).map(([id]) => id).sort();
      for (const subnetId of subnetsHere) {
        const info = subnetInfo.get(subnetId);
        const subnetRow = nodes.get(subnetId);
        const sub = { id: `subnet:${subnetId}`, kind: 'subnet',
                      label: subnetRow?.name ? `서브넷 ${shortName(subnetRow.name)}` : '서브넷',
                      note: info.present ? subnetId : `${subnetId} · 평가에 없음`,
                      x: az.x + PAD, y: sy, w: az.w - 2 * PAD, h: 0, stroke: null,
                      dashed: !info.present, badge: null, measured: true,
                      title: subnetRow?.arn ?? null };
        containers.push(sub);
        const cards = budgeted((subnetMembers.get(subnetId) ?? []).map((id) => cardFor(id, sub.w - 2 * PAD)),
                               sub.id, CARDS_PER_SUBNET);
        const contentH = flow(cards, sub.x + PAD, sub.y + HEAD, sub.w - 2 * PAD);
        sub.h = HEAD + contentH + PAD;
        sy += sub.h + ROW_GAP;
      }
      az.h = (sy - ROW_GAP) - az.y + PAD;
      zonesH = Math.max(zonesH, az.h);
    });
    if (zoneIds.length > 0) cy += zonesH + ROW_GAP;
    vpc.h = (cy - ROW_GAP) - vpc.y + PAD;
    if (bandH === 0 && zoneIds.length === 0) vpc.h = HEAD + PAD;
    y = vpc.y + vpc.h + ROW_GAP;
  }

  // The internet gateways: one per VPC, straddling its top border at the right. Before the region
  // band, so one whose VPC was not drawn can still fall into it.
  for (const [vpcId, igwId] of edgeNodes) {
    const vpc = containers.find((c) => c.id === `vpc:${vpcId}`);
    if (!vpc) { regionMembers.push(igwId); continue; }
    emit(igwId, vpc.x + vpc.w - PAD - NODE_W, vpc.y - NODE_H / 2, { erase: true });
  }

  // The region band: what is in no VPC.
  const regionBand = budgeted(regionMembers.map((id) => cardFor(id, regionW, { zoneSub: true })), 'region');
  const bandH = flow(regionBand, regionX, y, regionW);
  if (bandH > 0) y += bandH + ROW_GAP;
  region.h = (y - ROW_GAP) - region.y + PAD;
  if (vpcList.length === 0 && bandH === 0) region.h = HEAD + PAD;
  cloud.h = region.y + region.h + PAD - cloud.y;

  // ---- 5. edges ------------------------------------------------------------------------------
  const drawn = new Map(placedNodes.map((n) => [n.id, n]));
  const containerOf = new Map(containers.map((c) => [c.id, c]));
  const edgeKeys = new Set();
  const edges = [];
  const dangling = {};                                  // relation -> count
  const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  /** Whether the segment p-q passes through box r. The box is shrunk by one pixel, so a line
   *  running along a border, or starting on one, is not "through". Liang-Barsky. */
  const crosses = (p, q, r) => {
    const x0 = r.x + 1; const y0 = r.y + 1; const x1 = r.x + r.w - 1; const y1 = r.y + r.h - 1;
    const dx = q.x - p.x; const dy = q.y - p.y;
    let t0 = 0; let t1 = 1;
    for (const [den, num] of [[-dx, p.x - x0], [dx, x1 - p.x], [-dy, p.y - y0], [dy, y1 - p.y]]) {
      if (den === 0) { if (num < 0) return false; continue; }
      const t = num / den;
      if (den < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return t0 < t1;
  };
  /** The places a line may leave a box: on each side, the point nearest the other end and the
   *  side's middle. The middle is there so a shallow line to a far plate one row up can leave from
   *  the top centre and clear the neighbour's top edge, instead of skimming along it. */
  const sideAnchors = (box, toward) => {
    const ax = clamp(toward.x, box.x + ANCHOR_INSET, box.x + box.w - ANCHOR_INSET);
    const ay = clamp(toward.y, box.y + ANCHOR_INSET, box.y + box.h - ANCHOR_INSET);
    const mx = box.x + box.w / 2;
    const my = box.y + box.h / 2;
    return [{ x: ax, y: box.y }, { x: ax, y: box.y + box.h }, { x: box.x, y: ay }, { x: box.x + box.w, y: ay },
            { x: mx, y: box.y }, { x: mx, y: box.y + box.h }, { x: box.x, y: my }, { x: box.x + box.w, y: my }];
  };
  /** A box grown by a margin, for counting the lines that graze a plate without crossing it. */
  const grown = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
  /**
   * Where a line runs. A line is a claim about its two ends and nothing else, and the centre-to-
   * centre segment this started with made claims it did not mean: it ran under the plate beside
   * its end and came out the far side, so a group line from one interface read as a group line
   * from the instance next to it, and the route from the main table to the internet gateway
   * surfaced from under the ACL two plates along. So:
   *   - a line leaves a plate by a side, at the point on that side nearest the other end, and
   *     never back through its own plate;
   *   - of the candidate pairs, the one crossing the fewest OTHER plates wins, then the one
   *     grazing the fewest, then the shortest, so a line skirts what it can skirt;
   *   - two plates at the same level with something between them are joined over the top, through
   *     the gap above the row, in three straight pieces - every straight line between them runs
   *     under whatever sits between; two in the same column with something between, around the
   *     left, likewise;
   *   - what cannot be avoided is drawn anyway, and the rings the renderer puts on both ends are
   *     what says where a line really stops.
   */
  const plates = [...placedNodes, ...overflow];
  const route = (a, b, aIsPlate, bIsPlate) => {
    const ca = centre(a); const cb = centre(b);
    const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);   // negative: same row
    const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);   // negative: overlapping
    if (aIsPlate && bIsPlate && gapY <= HEAD && gapX > NODE_GAP + 2) {
      let ya; let yb; let corridorY;
      if (gapY < 0) {                     // the same row: over both tops
        ya = a.y; yb = b.y; corridorY = Math.min(a.y, b.y) - NODE_GAP / 2;
      } else if (a.y > b.y) {             // b just above a (the internet gateway on the border)
        ya = a.y; yb = b.y + b.h; corridorY = (yb + ya) / 2;
      } else {                            // a just above b
        ya = a.y + a.h; yb = b.y; corridorY = (ya + yb) / 2;
      }
      return [{ x: ca.x, y: ya }, { x: ca.x, y: corridorY }, { x: cb.x, y: corridorY }, { x: cb.x, y: yb }];
    }
    if (aIsPlate && bIsPlate && gapX < 0 && gapY > NODE_GAP + 2) {
      // The same column with something between - an instance and its second volume, stacked
      // under the first. Around the left, through the gap beside the column, for the same reason.
      const corridorX = Math.min(a.x, b.x) - NODE_GAP / 2;
      return [{ x: a.x, y: ca.y }, { x: corridorX, y: ca.y }, { x: corridorX, y: cb.y }, { x: b.x, y: cb.y }];
    }
    const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    const hi = { x: Math.max(a.x + a.w, b.x + b.w), y: Math.max(a.y + a.h, b.y + b.h) };
    const others = plates.filter((r) => r !== a && r !== b
      && r.x < hi.x + GRAZE && r.x + r.w > lo.x - GRAZE && r.y < hi.y + GRAZE && r.y + r.h > lo.y - GRAZE);
    let best = null;
    for (const p of sideAnchors(a, cb)) {
      for (const q of sideAnchors(b, ca)) {
        if (crosses(p, q, a) || crosses(p, q, b)) continue;     // back through its own plate
        const hits = others.reduce((n, r) => n + (crosses(p, q, r) ? 1 : 0), 0);
        const grazes = others.reduce((n, r) => n + (crosses(p, q, grown(r, GRAZE)) ? 1 : 0), 0);
        const score = hits * 100000 + grazes * 1000 + Math.hypot(q.x - p.x, q.y - p.y);
        if (!best || score < best.score) best = { p, q, score };
      }
    }
    return best ? [best.p, best.q] : [ca, cb];
  };
  const addEdge = (kind, a, b, relation, implicit = false) => {
    const key = `${kind}|${[a, b].sort().join('|')}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ kind, from: a, to: b, relation, implicit });
  };

  // Explicit links, both directions folded to one edge. Targets that are containers (subnets,
  // VPCs) resolve to the container; targets that are neither drawn nor a container are dangling.
  //
  // An interface drawn INSIDE its instance's box is a special case twice over. No line joins the
  // two - the border says it. And a group line does not go to the interface but to the instance
  // that holds it: that is where a reader looks for "what groups does this instance have", and the
  // instance's own SecurityGroups field is its primary interface's groups anyway, so both records
  // fold into one line per (instance, group).
  const boxedIn = new Map();                            // interface id -> instance id it is drawn in
  for (const n of placedNodes) {
    if (!n.box) continue;
    for (const e of eniOf.get(n.id) ?? []) if (drawn.has(e)) boxedIn.set(e, n.id);
  }
  const explicitRtb = new Map();                        // subnet id -> Set(rtb id)
  const mainRtb = new Map();                            // vpc id -> rtb id
  for (const n of placedNodes) {
    const src = nodes.get(n.id);
    for (const [relation, targets] of Object.entries(src.links)) {
      const rel = RELATIONS[relation];
      if (!rel) continue;
      // A volume's `instance` link is the SAME fact as the instance's `volume` link, seen from the
      // disk; it is a volume edge, and the (kind, pair) key below folds the two into one line.
      const kind = relation === 'instance' && src.resourceType === 'ec2:volume' ? 'volume' : rel.kind;
      for (const target of targets) {
        if (relation === 'main') { mainRtb.set(target, n.id); continue; }
        if (relation === 'default') continue;             // a flag; the ACL's own label says it
        if (relation === 'network_interface' && boxedIn.get(target) === n.id) continue;
        if (relation === 'instance' && boxedIn.get(n.id) === target) continue;
        if (relation === 'security_group' && boxedIn.has(n.id) && drawn.has(target)) {
          addEdge('security', boxedIn.get(n.id), target, relation);
          continue;
        }
        if (drawn.has(target)) { addEdge(kind, n.id, target, relation); continue; }
        if (relation === 'subnet' && containerOf.has(`subnet:${target}`)) {
          addEdge('association', n.id, `subnet:${target}`, relation);
          if (src.resourceType === 'ec2:route-table') {
            if (!explicitRtb.has(target)) explicitRtb.set(target, new Set());
            explicitRtb.get(target).add(n.id);
          }
          continue;
        }
        bump(dangling, relation);
      }
    }
  }
  // Implicit main-table associations: a subnet with no explicit route-table association uses the
  // VPC's main table. Derived here, drawn dashed, and said to be derived.
  let implicitEdges = 0;
  for (const [subnetId, info] of subnetInfo) {
    if (!containerOf.has(`subnet:${subnetId}`)) continue;
    if (explicitRtb.has(subnetId)) continue;
    const rtb = mainRtb.get(info.vpc);
    if (rtb && drawn.has(rtb)) { addEdge('association', rtb, `subnet:${subnetId}`, 'main', true); implicitEdges += 1; }
  }

  // Geometry, then the budget: drop the least load-bearing kinds first, whole kinds at a time.
  const boxOf = (id) => drawn.get(id) ?? containerOf.get(id);
  /** What a hover on the line says: the kind, then both ends - a plate by the first line of its
   *  own title (type, id, name, zone; not the ARN), a container by its label and its id. */
  const endLabel = (id) => (drawn.has(id) ? drawn.get(id).title.split('\n')[0]
    : `${containerOf.get(id).label} ${containerOf.get(id).note ?? ''}`.trim());
  for (const e of edges) {
    const a = boxOf(e.from);
    const b = boxOf(e.to);
    e.points = route(a, b, drawn.has(e.from), drawn.has(e.to))
      .map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
    e.x1 = e.points[0].x; e.y1 = e.points[0].y;
    e.x2 = e.points[e.points.length - 1].x; e.y2 = e.points[e.points.length - 1].y;
    e.title = `${KIND_LABEL[e.kind]}${e.implicit ? ' (기본 라우팅 테이블에서 도출)' : ''}: `
      + `${endLabel(e.from)} — ${endLabel(e.to)}`;
  }
  const droppedEdges = {};
  let kept = edges;
  for (const kind of DROP_ORDER) {
    if (kept.length <= EDGE_BUDGET) break;
    const stay = kept.filter((e) => e.kind !== kind);
    const gone = kept.length - stay.length;
    if (gone > 0) { droppedEdges[kind] = gone; kept = stay; }
  }
  kept.sort((a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // ---- 6. the foot lines and the accounting -------------------------------------------------
  const omittedNodes = overflow.reduce((n, o) => n + o.count, 0);
  const danglingTotal = Object.values(dangling).reduce((n, v) => n + v, 0);
  const foot = [];
  if (omittedNodes > 0) {
    foot.push(`그리지 못한 자원 ${omittedNodes.toLocaleString()}개 — 한 그림에 ${NODE_BUDGET}개까지만 놓는다. `
      + '계정·리전·VPC·서브넷으로 좁히면 나머지가 보인다.');
  }
  const droppedTotal = Object.values(droppedEdges).reduce((n, v) => n + v, 0);
  if (droppedTotal > 0) {
    foot.push(`그리지 못한 연결 ${droppedTotal.toLocaleString()}개 — 한 그림에 선을 ${EDGE_BUDGET}개까지만 긋는다. `
      + `뺀 종류: ${Object.keys(droppedEdges).map((k) => KIND_LABEL[k]).join(', ')}.`);
  }
  if (danglingTotal > 0) {
    foot.push(`그림 밖으로 나가는 연결 ${danglingTotal.toLocaleString()}개 — 상대 자원이 이 평가에 없다 `
      + '(정책이 닿지 않거나 목록이 잘렸다).');
  }
  if (omittedServices.size > 0) {
    const total = [...omittedServices.values()].reduce((n, v) => n + v, 0);
    foot.push(`그림 밖 서비스 ${omittedServices.size}종 · 자원 ${total.toLocaleString()}개 — 표 아래에 적었다.`);
  }
  foot.push(GRAPH_CAPTION);
  const footTop = cloud.y + cloud.h + G_FOOT_PAD;
  const footLines = foot.map((text, i) => ({ text, y: footTop + 12 + i * G_FOOT_LINE }));

  // The table beside the picture: one row per drawn node.
  const rows = placedNodes.map((n) => ({
    id: n.id,
    resourceType: n.resourceType,
    typeLabel: n.typeLabel,
    name: nodes.get(n.id).name,
    where: nodes.get(n.id).subnet || nodes.get(n.id).vpc || nodes.get(n.id).zone || '',
    degree: kept.filter((e) => e.from === n.id || e.to === n.id).length,
    sensitive: n.sensitive,
  })).sort((a, b) => a.resourceType.localeCompare(b.resourceType) || a.id.localeCompare(b.id));

  return {
    width: GRAPH_W,
    height: footTop + foot.length * G_FOOT_LINE + G_FOOT_PAD,
    containers,
    nodes: placedNodes,
    overflow,
    edges: kept,
    foot: footLines,
    rows,
    omitted: [...omittedServices.entries()].map(([service, total]) => ({ service, total }))
      .sort((a, b) => b.total - a.total || a.service.localeCompare(b.service)),
    regions: regionList,
    counts: {
      nodes: placedNodes.length,
      edges: kept.length,
      implicitEdges,
      omittedNodes,
      droppedEdges,
      /** The sum of droppedEdges, so the closed-state line can say 이상 without a reduce of its own. */
      droppedEdgeTotal: droppedTotal,
      dangling,
      linkedRows,
      placedRows,
      totalRows: ids.length,
      /** Rows that became a BORDER rather than a plate - the ec2:vpc and ec2:subnet rows. The
       *  accounting is nodes + omittedNodes + containerRows === totalRows, and a test says so. */
      containerRows: ids.filter((id) => placeOf(nodes.get(id)) === null).length,
    },
    kinds,
    measured,
    empty: ids.length === 0,
    narrowed,
    enumerated,
    /** Whether this assessment carries enough for a relationship picture at all: a row placed
     *  somewhere or a link recorded. An older assessment has neither, and its graph would be one
     *  region band of unconnected plates - the type picture says more about that document. */
    informative: linkedRows > 0 || placedRows > 0,
  };
}

export const KIND_LABEL = {
  // An instance's own interfaces are drawn inside it, so this line is the other attachments: a NAT
  // gateway's, an endpoint's.
  interface: '네트워크 인터페이스 부착',
  volume: '인스턴스—볼륨',
  security: '보안 그룹 소속',
  association: '서브넷 연결(라우팅 테이블·ACL·엔드포인트)',
  route: '라우팅 테이블의 경로',
  image: 'AMI',
};

/** Drawn INSIDE the viewBox, so a cropped screenshot keeps it. */
export const GRAPH_CAPTION =
  '이 그림은 조회기가 읽은 연결을 그린 것이다. 실선 테두리는 측정한 포함 관계이고, 점선 연결은 기본 라우팅 테이블에서 도출한 것이다.';

/** The <desc>: what a screen reader is told. Pure, so it is tested rather than hoped for. */
export function graphSummary(scene) {
  if (!scene) return '';
  if (scene.empty) {
    if (!scene.enumerated) {
      return '이 평가는 EC2 자원 조회에 실패해서 그릴 것이 없다. 이 정책이 닿는 자원이 없다는 뜻이 아니다.';
    }
    return scene.narrowed ? '고른 조건에 맞는 EC2 자원이 없다.' : '이 정책이 닿는 EC2 자원이 인벤토리에 없다.';
  }
  const c = scene.counts;
  const vpcs = scene.containers.filter((x) => x.kind === 'vpc').length;
  const subnets = scene.containers.filter((x) => x.kind === 'subnet').length;
  const kinds = Object.entries(scene.edges.reduce((o, e) => { o[e.kind] = (o[e.kind] ?? 0) + 1; return o; }, {}))
    .map(([k, n]) => `${KIND_LABEL[k]} ${n}`).join(', ');
  return `이 정책이 닿는 EC2 자원 ${c.nodes.toLocaleString()}개를 VPC ${vpcs}개와 서브넷 ${subnets}개 안에 `
    + `놓고 연결 ${c.edges.toLocaleString()}개를 그린 그림이다`
    + (kinds ? ` — ${kinds}` : '') + '. '
    + (c.implicitEdges > 0 ? `그중 ${c.implicitEdges}개는 기본 라우팅 테이블에서 도출했다. ` : '')
    + (c.omittedNodes > 0 ? `자원 ${c.omittedNodes.toLocaleString()}개는 그리지 못했다. ` : '')
    + '테두리는 조회기가 기록한 소속이다.';
}

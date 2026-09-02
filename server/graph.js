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
export function relationScene(policy, accountId, filter = null, enumerated = true, options = {}) {
  const spec = specOf(policy);
  if (!spec || spec.kind !== 'ec2') return null;
  const narrowed = filterActive(filter);
  /** The instances whose box is open, showing the interfaces inside it. Closed by default: a
   *  reader clicks an instance to see its interfaces; the group lines and the volumes are the
   *  same either way. */
  const expanded = new Set(options?.expanded ?? []);

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

  // Public or private, decided the way AWS decides it: a subnet is public when the route table it
  // is associated with - its explicit one, else the VPC's main table - has a route to an internet
  // gateway. Read off EVERY route-table row, filtered or not: narrowing the picture to one subnet
  // must not turn its colour off. No table in the assessment means no colour, and the legend
  // says so.
  const tableOf = new Map();            // subnet id -> route table id, the explicit association
  const mainTableOf = new Map();        // vpc id -> its main route table id
  const toInternet = new Set();         // route table ids with a route to an internet gateway
  for (const group of policy?.affected ?? []) {
    if (group?.resource_type !== 'ec2:route-table') continue;
    for (const r of group.resources ?? []) {
      const id = idOf(r?.arn ?? '');
      const links = r?.links && typeof r.links === 'object' ? r.links : {};
      for (const s of links.subnet ?? []) tableOf.set(s, id);
      for (const v of links.main ?? []) mainTableOf.set(v, id);
      if ((links.internet_gateway ?? []).length > 0) toInternet.add(id);
    }
  }
  const tintOf = (subnetId, vpcId) => {
    const table = tableOf.get(subnetId) ?? mainTableOf.get(vpcId);
    if (!table) return null;
    return toInternet.has(table) ? 'public' : 'private';
  };

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
      // A box rather than a plate: an instance, drawn as a frame with its interfaces inside when
      // open and folded into it when closed.
      box: !!extra.box,
      holds: extra.holds ?? 0,
      open: !!extra.open,
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
  const foldedNodes = [];            // { id, in }: interfaces inside a closed box, not drawn
  const instanceCard = (id, innerW, extra = {}) => {
    const enis = [...(eniOf.get(id) ?? [])].sort();
    const vols = ids.filter((v) => attachedTo.get(v) === id);
    const open = enis.length > 0 && expanded.has(id);
    const cols = Math.max(1, Math.min(enis.length,
      Math.floor((innerW - 2 * PAD + NODE_GAP) / (NODE_W + NODE_GAP))));
    const rows = Math.ceil(enis.length / cols);
    const boxW = open ? cols * NODE_W + (cols - 1) * NODE_GAP + 2 * PAD : NODE_W + 2 * PAD;
    const boxH = open ? HEAD + PAD + rows * NODE_H + (rows - 1) * NODE_GAP + PAD : NODE_H;
    // Short enough for a closed box's one line; the box's aria-label says it in full.
    const note = enis.length === 0 ? '인터페이스 · 평가에 없음'
      : open ? null : `인터페이스 ${enis.length}개 · 펼치기`;
    return {
      ids: [id, ...enis, ...vols],
      w: boxW,
      h: boxH + vols.length * (NODE_H + NODE_GAP),
      place: (x, yy) => {
        emit(id, x, yy, { ...extra, box: true, w: boxW, h: boxH, holds: enis.length, open, note });
        if (open) {
          enis.forEach((e, i) => emit(e, x + PAD + (i % cols) * (NODE_W + NODE_GAP),
                                      yy + HEAD + PAD + Math.floor(i / cols) * (NODE_H + NODE_GAP)));
        } else {
          // Folded into the box: placed, in the sense that the budget and the table count it,
          // and not drawn.
          for (const e of enis) { foldedNodes.push({ id: e, in: id }); drawnNodes += 1; }
        }
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

  // VPCs, in id order, stacked down the region. Inside each, the shape of the reference picture:
  // the internet gateway on the top border in the middle; the route tables, network ACLs and
  // endpoints in a column down the middle, where their lines go left and right to the subnets;
  // the zones on either side of that column, as many on the left as on the right; and the
  // security groups and the rest in two half-bands above the zones, dealt left and right in
  // turn, so the middle stays open for the line from a table up to the gateway.
  const CENTRE_TYPES = new Set(['ec2:route-table', 'ec2:network-acl', 'ec2:vpc-endpoint']);
  const CENTRE_ORDER = ['ec2:route-table', 'ec2:network-acl', 'ec2:vpc-endpoint'];
  const vpcList = [...vpcIds].sort();
  for (const vpcId of vpcList) {
    const vpcRow = nodes.get(vpcId);
    const hasGateway = edgeNodes.has(vpcId);
    const vpcTop = y + (hasGateway ? NODE_H / 2 : 0);
    const vpc = { id: `vpc:${vpcId}`, kind: 'vpc',
                  label: vpcRow?.name ? `VPC ${shortName(vpcRow.name)}` : 'VPC',
                  note: vpcRow ? vpcId : `${vpcId} · 평가에 없음`,
                  x: regionX, y: vpcTop, w: regionW, h: 0,
                  stroke: '#8C4FFF', dashed: !vpcRow, badge: 'Group-Virtual-private-cloud-VPC.svg',
                  measured: true, title: vpcRow?.arn ?? null };
    containers.push(vpc);
    const top = vpc.y + HEAD + (hasGateway ? NODE_H / 2 : 0);
    const members = bandMembers.get(vpcId) ?? [];
    // The middle column: tables first, the one with a route to the internet first of those, so the
    // public table sits nearest the gateway it routes to.
    const centreIds = members.filter((id) => CENTRE_TYPES.has(nodes.get(id).resourceType))
      .sort((p, q) => CENTRE_ORDER.indexOf(nodes.get(p).resourceType) - CENTRE_ORDER.indexOf(nodes.get(q).resourceType)
        || (toInternet.has(q) ? 1 : 0) - (toInternet.has(p) ? 1 : 0) || p.localeCompare(q));
    const bandIds = members.filter((id) => !CENTRE_TYPES.has(nodes.get(id).resourceType));
    const zoneIds = [...new Set([...subnetInfo.entries()]
      .filter(([, i]) => i.vpc === vpcId).map(([, i]) => i.zone || '?'))].sort();
    const centreW = centreIds.length > 0 ? NODE_W + 2 * PAD : 0;
    const centreX = vpc.x + vpc.w / 2 - centreW / 2;
    // The two halves either side of the middle column; one whole when there is no column.
    const halves = centreW > 0
      ? [[vpc.x + PAD, centreX - NODE_GAP], [centreX + centreW + NODE_GAP, vpc.x + vpc.w - PAD]]
      : [[vpc.x + PAD, vpc.x + vpc.w - PAD]];
    let bottom = top;
    if (centreW > 0) {
      const column = budgeted(centreIds.map((id) => cardFor(id, NODE_W)), vpc.id);
      let cy = top;
      for (const card of column) { card.place(centreX + PAD, cy); cy += card.h + NODE_GAP; }
      bottom = Math.max(bottom, cy - NODE_GAP);
    }
    // The band, dealt into the halves in turn.
    const bandCards = budgeted(bandIds.map((id) => cardFor(id, halves[0][1] - halves[0][0])), vpc.id);
    let bandBottom = top;
    halves.forEach(([x0, x1], half) => {
      const mine = bandCards.filter((_, i) => i % halves.length === half);
      const h = flow(mine, x0, top, x1 - x0);
      if (h > 0) bandBottom = Math.max(bandBottom, top + h);
    });
    const zonesTop = bandBottom > top ? bandBottom + ROW_GAP : top;
    // The zones, dealt into the halves: the first half takes the first half of them, rounded up.
    const split = halves.length === 2 ? Math.ceil(zoneIds.length / 2) : zoneIds.length;
    const zoneGroups = halves.length === 2 ? [zoneIds.slice(0, split), zoneIds.slice(split)] : [zoneIds];
    let zonesBottom = zonesTop;
    zoneGroups.forEach((group, half) => {
      if (group.length === 0) return;
      const [x0, x1] = halves[half];
      const zoneW = (x1 - x0 - NODE_GAP * (group.length - 1)) / group.length;
      group.forEach((zone, zi) => {
        const zx = x0 + zi * (zoneW + NODE_GAP);
        const az = { id: `az:${vpcId}:${zone}`, kind: 'az', label: '가용 영역',
                     note: zone === '?' ? '영역을 읽지 못했다' : zone,
                     x: zx, y: zonesTop, w: zoneW, h: 0, stroke: null, dashed: zone === '?',
                     badge: null, measured: zone !== '?' };
        containers.push(az);
        let sy = az.y + HEAD;
        const subnetsHere = [...subnetInfo.entries()]
          .filter(([, i]) => i.vpc === vpcId && (i.zone || '?') === zone).map(([id]) => id).sort();
        for (const subnetId of subnetsHere) {
          const info = subnetInfo.get(subnetId);
          const subnetRow = nodes.get(subnetId);
          const tint = tintOf(subnetId, vpcId);
          const sub = { id: `subnet:${subnetId}`, kind: 'subnet',
                        label: subnetRow?.name ? `서브넷 ${shortName(subnetRow.name)}` : '서브넷',
                        note: (info.present ? subnetId : `${subnetId} · 평가에 없음`)
                          + (tint === 'public' ? ' · 퍼블릭' : tint === 'private' ? ' · 프라이빗' : ''),
                        x: az.x + PAD, y: sy, w: az.w - 2 * PAD, h: 0, stroke: null,
                        dashed: !info.present, badge: null, measured: true,
                        title: subnetRow?.arn ?? null, tint };
          containers.push(sub);
          const cards = budgeted((subnetMembers.get(subnetId) ?? []).map((id) => cardFor(id, sub.w - 2 * PAD)),
                                 sub.id, CARDS_PER_SUBNET);
          const contentH = flow(cards, sub.x + PAD, sub.y + HEAD, sub.w - 2 * PAD);
          sub.h = HEAD + contentH + PAD;
          sy += sub.h + ROW_GAP;
        }
        az.h = (sy - ROW_GAP) - az.y + PAD;
        zonesBottom = Math.max(zonesBottom, az.y + az.h);
      });
    });
    bottom = Math.max(bottom, zonesBottom);
    vpc.h = bottom === top ? HEAD + PAD : bottom - vpc.y + PAD;
    y = vpc.y + vpc.h + ROW_GAP;
  }

  // The internet gateways: one per VPC, straddling its top border in the middle, above the
  // column of tables. Before the region band, so one whose VPC was not drawn can still fall into
  // it.
  for (const [vpcId, igwId] of edgeNodes) {
    const vpc = containers.find((c) => c.id === `vpc:${vpcId}`);
    if (!vpc) { regionMembers.push(igwId); continue; }
    emit(igwId, vpc.x + vpc.w / 2 - NODE_W / 2, vpc.y - NODE_H / 2, { erase: true });
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
   *  side's middle, each tagged with its side. Two per side because a line to a far box reads
   *  better leaving from the middle than out of a corner. */
  const sideAnchors = (box, toward) => {
    const ax = clamp(toward.x, box.x + ANCHOR_INSET, box.x + box.w - ANCHOR_INSET);
    const ay = clamp(toward.y, box.y + ANCHOR_INSET, box.y + box.h - ANCHOR_INSET);
    const mx = box.x + box.w / 2;
    const my = box.y + box.h / 2;
    return [
      { side: 'top', x: ax, y: box.y }, { side: 'top', x: mx, y: box.y },
      { side: 'bottom', x: ax, y: box.y + box.h }, { side: 'bottom', x: mx, y: box.y + box.h },
      { side: 'left', x: box.x, y: ay }, { side: 'left', x: box.x, y: my },
      { side: 'right', x: box.x + box.w, y: ay }, { side: 'right', x: box.x + box.w, y: my },
    ];
  };
  /** A box grown by a margin, for counting the lines that graze a plate without crossing it. */
  const grown = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
  const plates = [...placedNodes, ...overflow];
  const vertical = (side) => side === 'top' || side === 'bottom';
  /**
   * The free band nearest the middle of [lo, hi] on one axis - clear of plates, of container
   * borders and of the label band under a container's top border - among those whose extent on
   * the other axis meets `span`. Where nothing is free, the middle: what cannot be avoided is
   * drawn anyway, and the rings on both ends say where a line really stops.
   */
  const corridor = (axis, lo, hi, span, a, b) => {
    if (hi - lo < 2) return (lo + hi) / 2;
    const blocks = [];
    for (const r of plates) {
      if (r === a || r === b) continue;
      const [rs, re] = axis === 'y' ? [r.x, r.x + r.w] : [r.y, r.y + r.h];
      if (rs >= span[1] || re <= span[0]) continue;
      blocks.push(axis === 'y' ? [r.y - GRAZE, r.y + r.h + GRAZE] : [r.x - GRAZE, r.x + r.w + GRAZE]);
    }
    for (const c of containers) {
      const [cs, ce] = axis === 'y' ? [c.x, c.x + c.w] : [c.y, c.y + c.h];
      if (cs >= span[1] || ce <= span[0]) continue;
      if (axis === 'y') {
        blocks.push([c.y - 3, c.y + HEAD], [c.y + c.h - 3, c.y + c.h + 3]);
      } else {
        blocks.push([c.x - 3, c.x + 3], [c.x + c.w - 3, c.x + c.w + 3]);
      }
    }
    blocks.sort((u, v) => u[0] - v[0]);
    const free = [];
    let cursor = lo;
    for (const [s, e] of blocks) {
      if (e <= lo || s >= hi) continue;
      if (s > cursor) free.push([cursor, Math.min(s, hi)]);
      cursor = Math.max(cursor, e);
    }
    if (cursor < hi) free.push([cursor, hi]);
    const mid = (lo + hi) / 2;
    let pick = null;
    for (const [s, e] of free) {
      if (e - s < 4) continue;
      const at = mid >= s && mid <= e ? mid : (s + e) / 2;
      const d = Math.abs(at - mid);
      if (!pick || d < pick.d) pick = { at, d };
    }
    return pick ? pick.at : mid;
  };
  /**
   * One orthogonal shape per pair of sides. Two vertical sides make a ㄷ through a corridor
   * between them - or above both tops, or below both bottoms, when they face the same way. Two
   * horizontal sides make the same shape lying down. A vertical and a horizontal side make a ㄱ.
   * Null when the pair cannot be joined that way without going back through a box.
   */
  const pathFor = (p, q, a, b) => {
    if (vertical(p.side) && vertical(q.side)) {
      let lo; let hi;
      if (p.side === 'top' && q.side === 'bottom') { lo = q.y; hi = p.y; }
      else if (p.side === 'bottom' && q.side === 'top') { lo = p.y; hi = q.y; }
      else if (p.side === 'top') { hi = Math.min(p.y, q.y); lo = hi - NODE_GAP; }
      else { lo = Math.max(p.y, q.y); hi = lo + NODE_GAP; }
      if (hi <= lo) return null;
      const cy = corridor('y', lo, hi, [Math.min(p.x, q.x), Math.max(p.x, q.x)], a, b);
      return [p, { x: p.x, y: cy }, { x: q.x, y: cy }, q];
    }
    if (!vertical(p.side) && !vertical(q.side)) {
      let lo; let hi;
      if (p.side === 'left' && q.side === 'right') { lo = q.x; hi = p.x; }
      else if (p.side === 'right' && q.side === 'left') { lo = p.x; hi = q.x; }
      else if (p.side === 'left') { hi = Math.min(p.x, q.x); lo = hi - NODE_GAP; }
      else { lo = Math.max(p.x, q.x); hi = lo + NODE_GAP; }
      if (hi <= lo) return null;
      const cx = corridor('x', lo, hi, [Math.min(p.y, q.y), Math.max(p.y, q.y)], a, b);
      return [p, { x: cx, y: p.y }, { x: cx, y: q.y }, q];
    }
    if (vertical(p.side)) {
      const outward = p.side === 'top' ? q.y < p.y : q.y > p.y;
      const inward = q.side === 'left' ? p.x < q.x : p.x > q.x;
      return outward && inward ? [p, { x: p.x, y: q.y }, q] : null;
    }
    const outward = p.side === 'left' ? q.x < p.x : q.x > p.x;
    const inward = q.side === 'top' ? p.y < q.y : p.y > q.y;
    return outward && inward ? [p, { x: q.x, y: p.y }, q] : null;
  };
  /** Drop repeated points and the middle of three in a line, so a ㄷ whose ends align is a line. */
  const tidy = (pts) => {
    const out = [];
    for (const pt of pts) {
      const last = out[out.length - 1];
      if (!(last && last.x === pt.x && last.y === pt.y)) out.push(pt);
    }
    for (let i = 1; i < out.length - 1;) {
      const u = out[i - 1]; const v = out[i]; const w = out[i + 1];
      if ((u.x === v.x && v.x === w.x) || (u.y === v.y && v.y === w.y)) out.splice(i, 1);
      else i += 1;
    }
    return out;
  };
  /**
   * Where a line runs. Every line is orthogonal: it leaves a box straight out of one side, turns
   * only at right angles, and enters the other box straight into a side. A line is a claim about
   * its two ends and nothing else, and the centre-to-centre segment this started with made claims
   * it did not mean - it ran under the plate beside its end and came out the far side, so a group
   * line from one interface read as a group line from the instance next to it. So, of every shape
   * every pair of sides allows, the one crossing the fewest OTHER plates wins, then the one
   * grazing the fewest, then the fewest bends, then the shortest; a shape that goes back through
   * either end is no shape at all.
   */
  const route = (a, b) => {
    const ca = centre(a); const cb = centre(b);
    const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    const hi = { x: Math.max(a.x + a.w, b.x + b.w), y: Math.max(a.y + a.h, b.y + b.h) };
    const reach = 2 * NODE_GAP;
    const others = plates.filter((r) => r !== a && r !== b
      && r.x < hi.x + reach && r.x + r.w > lo.x - reach && r.y < hi.y + reach && r.y + r.h > lo.y - reach);
    let best = null;
    for (const p of sideAnchors(a, cb)) {
      for (const q of sideAnchors(b, ca)) {
        const raw = pathFor(p, q, a, b);
        if (!raw) continue;
        const path = tidy(raw);
        let hits = 0; let grazes = 0; let len = 0; let back = false;
        for (let i = 1; i < path.length; i += 1) {
          const u = path[i - 1]; const v = path[i];
          if (crosses(u, v, a) || crosses(u, v, b)) { back = true; break; }
          for (const r of others) {
            if (crosses(u, v, r)) hits += 1;
            else if (crosses(u, v, grown(r, GRAZE))) grazes += 1;
          }
          len += Math.abs(v.x - u.x) + Math.abs(v.y - u.y);
        }
        if (back) continue;
        const score = hits * 100000 + grazes * 1000 + (path.length - 2) * 40 + len;
        if (!best || score < best.score) best = { path, score };
      }
    }
    return best ? best.path : [ca, cb];
  };

  // ---- the grid router ---------------------------------------------------------------------
  // The shape router above joins two boxes in at most four points, and in a crowded place every
  // one of its shapes runs through a neighbour - a line from the ACL to a subnet two rows down
  // went straight through the route table beside it, which reads as the table's line. So a line
  // is found on a grid of RES-pixel cells with A* instead: plates are walls; a container's border
  // and the label band under its top edge cost extra, so a line crosses them where it must and
  // not along them; a cell another line already runs along costs extra, so parallel lines take
  // parallel lanes; and every turn costs extra, so a line turns as little as it can. The shape
  // router is the fallback for the rare pair the grid cannot join.
  // Costs are in half-steps: a step is 2, so the extras can be smaller than a step. A line passes
  // a plate at one cell's distance for 1 extra a cell - enough to prefer open ground, not enough
  // to send it round the VPC rather than through a ten-pixel gap. A turn is 20: a line changes
  // lane only to escape a long shared stretch, not to dodge a short one.
  const RES = 5;
  const WINDOW = 160;
  /** The estimate is weighted above one: the search then heads for the goal rather than sweeping
   *  the window, at the price of a line a little longer than the cheapest - a picture's price to
   *  pay, and what keeps a scene of hundreds under a second. */
  const GREED = 1.6;
  const STEP = 2;
  const TURN = 20;
  const NEAR = 1;
  const BORDER = 4;
  const LABEL = 6;
  const LANE = 8;
  const gridW = Math.ceil(GRAPH_W / RES) + 2;
  const gridH = Math.ceil((cloud.y + cloud.h) / RES) + 2;
  const hard = new Uint8Array(gridW * gridH);
  const soft = new Uint8Array(gridW * gridH);
  const traffic = new Uint8Array(gridW * gridH);
  /** Every cell whose point lies inside the rectangle. */
  const paint = (x0, y0, x1, y1, fn) => {
    const c0 = Math.max(0, Math.ceil(x0 / RES)); const c1 = Math.min(gridW - 1, Math.floor(x1 / RES));
    const r0 = Math.max(0, Math.ceil(y0 / RES)); const r1 = Math.min(gridH - 1, Math.floor(y1 / RES));
    for (let r = r0; r <= r1; r += 1) for (let c = c0; c <= c1; c += 1) fn(r * gridW + c);
  };
  for (const r of plates) paint(r.x - 2, r.y - 2, r.x + r.w + 2, r.y + r.h + 2, (i) => { hard[i] = 1; });
  for (const r of plates) {
    paint(r.x - 2 - RES, r.y - 2 - RES, r.x + r.w + 2 + RES, r.y + r.h + 2 + RES, (i) => { soft[i] += NEAR; });
  }
  for (const c of containers) {
    paint(c.x, c.y, c.x + c.w, c.y + HEAD, (i) => { soft[i] += LABEL; });
    paint(c.x, c.y + c.h - 2, c.x + c.w, c.y + c.h + 2, (i) => { soft[i] += BORDER; });
    paint(c.x - 2, c.y, c.x + 2, c.y + c.h, (i) => { soft[i] += BORDER; });
    paint(c.x + c.w - 2, c.y, c.x + c.w + 2, c.y + c.h, (i) => { soft[i] += BORDER; });
  }
  const cellOf = (x, y) => Math.round(y / RES) * gridW + Math.round(x / RES);
  /** The cells a line may leave a box from: just outside each side, at every grid column or row
   *  along it inside the corner inset, each with its end point on the border. Every position
   *  rather than one, so two lines to one plate land at two places on it and the router picks
   *  the pair of ports that costs least - which is what spreads lines into lanes. */
  const ports = (box) => {
    const out = [];
    const above = Math.floor((box.y - 3) / RES) * RES;
    const below = Math.ceil((box.y + box.h + 3) / RES) * RES;
    const before = Math.floor((box.x - 3) / RES) * RES;
    const after = Math.ceil((box.x + box.w + 3) / RES) * RES;
    const x0 = Math.ceil((box.x + ANCHOR_INSET) / RES) * RES;
    const x1 = Math.floor((box.x + box.w - ANCHOR_INSET) / RES) * RES;
    const y0 = Math.ceil((box.y + ANCHOR_INSET) / RES) * RES;
    const y1 = Math.floor((box.y + box.h - ANCHOR_INSET) / RES) * RES;
    // A whisper of cost grows with the distance from the side's middle, so of two equal ways the
    // one through the middle wins and a symmetric picture gets symmetric lines.
    const mx = box.x + box.w / 2; const my = box.y + box.h / 2;
    // Every cell along a plate's side; every fourth along a container's, which is wide.
    const step = box.w > 2 * NODE_W ? 4 * RES : RES;
    for (let x = x0; x <= x1; x += step) {
      const bias = 0.01 * Math.abs(x - mx) / RES;
      out.push({ end: { x, y: box.y }, cell: cellOf(x, above), dir: 0, bias });
      out.push({ end: { x, y: box.y + box.h }, cell: cellOf(x, below), dir: 2, bias });
    }
    for (let y = y0; y <= y1; y += step) {
      const bias = 0.01 * Math.abs(y - my) / RES;
      out.push({ end: { x: box.x, y }, cell: cellOf(before, y), dir: 3, bias });
      out.push({ end: { x: box.x + box.w, y }, cell: cellOf(after, y), dir: 1, bias });
    }
    return out.filter((p) => p.cell >= 0 && p.cell < gridW * gridH && !hard[p.cell]);
  };
  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  const states = gridW * gridH * 4;
  const gScore = new Float32Array(states);
  const stamp = new Uint32Array(states);        // 2 * gen: open, 2 * gen + 1: closed
  const from = new Int32Array(states);
  let gen = 0;
  // A binary heap on two typed arrays - keys and states side by side - rather than on an array of
  // pairs: the pairs were half the router's time in allocation and collection.
  let heapKey = new Float64Array(1 << 12);
  let heapVal = new Int32Array(1 << 12);
  let heapN = 0;
  const hpush = (f, s) => {
    if (heapN === heapKey.length) {
      const k2 = new Float64Array(heapN * 2); k2.set(heapKey); heapKey = k2;
      const v2 = new Int32Array(heapN * 2); v2.set(heapVal); heapVal = v2;
    }
    let i = heapN; heapN += 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p] <= f) break;
      heapKey[i] = heapKey[p]; heapVal[i] = heapVal[p];
      i = p;
    }
    heapKey[i] = f; heapVal[i] = s;
  };
  const hpop = () => {
    const top = heapVal[0];
    heapN -= 1;
    if (heapN > 0) {
      const f = heapKey[heapN]; const s = heapVal[heapN];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; if (l >= heapN) break;
        const r = l + 1;
        const m = (r < heapN && heapKey[r] < heapKey[l]) ? r : l;
        if (heapKey[m] >= f) break;
        heapKey[i] = heapKey[m]; heapVal[i] = heapVal[m];
        i = m;
      }
      heapKey[i] = f; heapVal[i] = s;
    }
    return top;
  };
  const gridRoute = (a, b, wide = false) => {
    const starts = ports(a);
    const goals = ports(b);
    if (starts.length === 0 || goals.length === 0) return null;
    // The search stays in a window around the two boxes: nearly every line is local, and a search
    // over the whole grid for each of seven hundred lines is seconds, not milliseconds. The pair
    // the window cannot join is searched again over the whole grid.
    const reach = wide ? Infinity : Math.ceil(WINDOW / RES);
    const wx0 = Math.max(0, Math.floor(Math.min(a.x, b.x) / RES) - reach);
    const wx1 = Math.min(gridW - 1, Math.ceil(Math.max(a.x + a.w, b.x + b.w) / RES) + reach);
    const wy0 = Math.max(0, Math.floor(Math.min(a.y, b.y) / RES) - reach);
    const wy1 = Math.min(gridH - 1, Math.ceil(Math.max(a.y + a.h, b.y + b.h) / RES) + reach);
    const goalAt = new Map(goals.map((p) => [p.cell, p]));
    // The heuristic: steps to the rectangle the goal cells lie on. Never more than the true cost,
    // so the first goal reached is the cheapest.
    let gx0 = Infinity; let gx1 = -Infinity; let gy0 = Infinity; let gy1 = -Infinity;
    for (const p of goals) {
      const cx = p.cell % gridW; const cy = (p.cell - cx) / gridW;
      gx0 = Math.min(gx0, cx); gx1 = Math.max(gx1, cx); gy0 = Math.min(gy0, cy); gy1 = Math.max(gy1, cy);
    }
    // The heuristic counts the turns a line still has to make as well as the steps: none if the
    // goal lies straight ahead, one if it lies off to a side, two if it lies behind. Every one of
    // those is unavoidable, so the estimate never exceeds the cost - and it is tight enough that
    // the search stops wandering the window.
    const h = (cell, dir) => {
      const cx = cell % gridW; const cy = (cell - cx) / gridW;
      const dx = Math.max(0, gx0 - cx, cx - gx1);
      const dy = Math.max(0, gy0 - cy, cy - gy1);
      let turns = 0;
      if (dir === 0 || dir === 2) {
        const ahead = dir === 0 ? cy > gy1 : cy < gy0;
        if (dy > 0 && !ahead) turns = 2;
        else if (dx > 0) turns = 1;
      } else {
        const ahead = dir === 3 ? cx > gx1 : cx < gx0;
        if (dx > 0 && !ahead) turns = 2;
        else if (dy > 0) turns = 1;
      }
      return STEP * (dx + dy) + TURN * turns;
    };
    gen += 1;
    const open = 2 * gen; const closed = 2 * gen + 1;
    heapN = 0;
    starts.forEach((s, i) => {
      const st = s.cell * 4 + s.dir;
      stamp[st] = open; gScore[st] = s.bias; from[st] = -1 - i;
      hpush(s.bias + GREED * h(s.cell, s.dir), st);
    });
    while (heapN > 0) {
      const st = hpop();
      if (stamp[st] === closed) continue;
      stamp[st] = closed;
      const cell = st >> 2; const dir = st & 3;
      if (goalAt.has(cell)) {
        // Walk back to the start port, then lay the two end points on their borders.
        const cells = [];
        let cur = st;
        while (cur >= 0) { cells.push(cur >> 2); cur = from[cur]; }
        const start = starts[-1 - cur];
        cells.reverse();
        for (const c of cells) if (traffic[c] < 255) traffic[c] += 1;
        const pts = [start.end, ...cells.map((c) => ({ x: (c % gridW) * RES, y: Math.floor(c / gridW) * RES })), goalAt.get(cell).end];
        return tidy(pts);
      }
      const cx = cell % gridW; const cy = (cell - cx) / gridW;
      for (let d = 0; d < 4; d += 1) {
        if (d === (dir + 2) % 4) continue;
        const nx = cx + DX[d]; const ny = cy + DY[d];
        if (nx < wx0 || ny < wy0 || nx > wx1 || ny > wy1) continue;
        const ncell = ny * gridW + nx;
        if (hard[ncell] && !goalAt.has(ncell)) continue;
        const ns = ncell * 4 + d;
        const cost = gScore[st] + STEP + soft[ncell] + traffic[ncell] * LANE + (d !== dir ? TURN : 0)
          + (goalAt.get(ncell)?.bias ?? 0);
        if (stamp[ns] >= open && gScore[ns] <= cost) continue;
        stamp[ns] = open; gScore[ns] = cost; from[ns] = st;
        hpush(cost + GREED * h(ncell, d), ns);
      }
    }
    return wide ? null : gridRoute(a, b, true);
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
  const boxedIn = new Map();                            // interface id -> instance id it is in
  const foldedIn = new Map(foldedNodes.map((f) => [f.id, f.in]));
  for (const n of placedNodes) {
    if (!n.box) continue;
    for (const e of eniOf.get(n.id) ?? []) if (drawn.has(e) || foldedIn.has(e)) boxedIn.set(e, n.id);
  }
  const explicitRtb = new Map();                        // subnet id -> Set(rtb id)
  const mainRtb = new Map();                            // vpc id -> rtb id
  // The folded interfaces take part too: their groups are the box's groups whether the box is
  // open or closed, so the lines are the same either way.
  for (const n of [...placedNodes, ...foldedNodes]) {
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
  // Short lines first, so the long ones route around them: a volume's line under its instance is
  // laid before the group line that has to pass that column.
  const ROUTE_ORDER = ['volume', 'interface', 'association', 'route', 'security', 'image'];
  edges.sort((p, q) => ROUTE_ORDER.indexOf(p.kind) - ROUTE_ORDER.indexOf(q.kind)
    || p.from.localeCompare(q.from) || p.to.localeCompare(q.to));
  for (const e of edges) {
    const a = boxOf(e.from);
    const b = boxOf(e.to);
    e.points = (gridRoute(a, b) ?? route(a, b)).map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }));
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

  // The table beside the picture: one row per drawn node, and one per interface folded into a
  // closed box - said to be inside it, so the table stays the whole answer while the picture is
  // folded.
  const rows = [
    ...placedNodes.map((n) => ({
      id: n.id,
      resourceType: n.resourceType,
      typeLabel: n.typeLabel,
      name: nodes.get(n.id).name,
      where: nodes.get(n.id).subnet || nodes.get(n.id).vpc || nodes.get(n.id).zone || '',
      degree: kept.filter((e) => e.from === n.id || e.to === n.id).length,
      sensitive: n.sensitive,
      folded: false,
    })),
    ...foldedNodes.map((f) => ({
      id: f.id,
      resourceType: nodes.get(f.id).resourceType,
      typeLabel: nodes.get(f.id).typeLabel,
      name: nodes.get(f.id).name,
      where: `${f.in} 안`,
      degree: 0,
      sensitive: nodes.get(f.id).sensitive,
      folded: true,
    })),
  ].sort((a, b) => a.resourceType.localeCompare(b.resourceType) || a.id.localeCompare(b.id));

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
       *  accounting is nodes + omittedNodes + containerRows + foldedRows === totalRows, and a test
       *  says so. */
      containerRows: ids.filter((id) => placeOf(nodes.get(id)) === null).length,
      /** Interfaces inside a closed instance box: placed and counted, not drawn. */
      foldedRows: foldedNodes.length,
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
  '이 그림은 조회기가 읽은 연결을 점선으로 그린 것이다. 실선 테두리는 기록된 소속이고, 촘촘한 점선은 기본 라우팅 테이블에서 도출한 연결이다.';

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

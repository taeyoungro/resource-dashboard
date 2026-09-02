// The scene behind "구성도 보기": where each resource TYPE sits in a canonical picture of its
// service. The ENGINE - one layout, three pictures. What each picture contains is a spec:
// topologyEc2.js, topologyLambda.js, topologyEcs.js.
//
// The impact panel answers "what does this policy reach" as a list, and a list of thirty resource
// types with counts beside them is a true answer nobody reads. This builds the same answer as a
// picture - and the whole difficulty of a picture is that it says more than a list does. A list
// that puts 인스턴스 and 볼륨 on consecutive lines has claimed nothing about them. A picture that
// puts an instance inside a security group inside a subnet inside a VPC has claimed four things.
//
// So: NOTHING HERE DECIDES WHAT A RESOURCE IS CONNECTED TO. What a picture places is the TYPE, at
// the position AWS scopes that type to, which is a fact about the service rather than a fact about
// this account. Every frame that is not measured is drawn dashed and says so, the caption inside
// the viewBox says so, and sceneSummary() says so to a screen reader.
//
// THE ONE THING THE NESTING ASSERTS IS AWS'S SCOPING, and the legend claims it out loud, so each
// spec has to get it right. EC2: 리전 ⊃ VPC ⊃ 가용 영역 ⊃ 서브넷. Lambda and ECS: neither has an
// availability zone or a subnet frame at all, because a function attaches ENIs in up to sixteen
// subnets and a service in up to sixteen, and one plate in one subnet box would name one of them.
//
// A MEASUREMENT NEVER CHANGES A BORDER. Solid means the assessment established the containment -
// the account and the region, and nothing else in any picture. Where a lookup DID measure
// something (a function's VPC, a service's subnets) the number goes on the label band and the
// border stays dashed, because "N functions are in a VPC" is not "these functions are in THIS
// VPC" and a solid box would say the second.
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
// WHAT CAN BE FILTERED. Every dimension is a fact a container recorded, never one inferred here.
//
//   account, region   on every row, from the ARN and from Resource Explorer's own Region
//   vpc, subnet       from vpc_id / subnet_id / subnet_ids, on the types the querier can place
//   cluster           ECS only, from the cluster ARN DescribeServices returned
//
// None of those are in an ARN and Resource Explorer returns none of them, so impact/inventory.py
// joins each on from a service call - one Describe per type per region for EC2, one paginated
// ListFunctions per region for Lambda, batched DescribeServices for ECS.
//
// A ROW THE LOOKUP DID NOT PLACE IS NOT A ROW OUTSIDE THE VPC, and the filter must never flatten
// the two. The type may have no VPC at all (a volume, a snapshot, an AMI - and, ordinarily, a
// Lambda function: not being in a VPC is the common case and a fact); the lookup may have been
// denied, budgeted out or unable to route its call; or the assessment may predate the field.
// facets() counts each state so the screen can say how much of the picture a VPC filter cannot
// speak for, rather than silently dropping it - and below COVERAGE_FLOOR the dimension is not
// offered at all, because a chip reading `vpc-0abc 12` for a VPC that holds 120 is worse than no
// chip.
//
// Plain JS with a .d.ts beside it, same arrangement as blockPath.js and for the same reason:
// node --test is the one test runner here and it cannot load TypeScript. Korean lives in the
// specs, not here; what Korean this file has left is the handful of sentences whose shape is the
// same in every picture, and each takes its nouns from spec.words.

import { parseArn } from './arn.js';
import EC2_SPEC from './topologyEc2.js';
import LAMBDA_SPEC from './topologyLambda.js';
import ECS_SPEC from './topologyEcs.js';

// ---- geometry ---------------------------------------------------------------------------------
//
// Exported so the tests assert against the real numbers rather than against a copy of them, and so
// the component can hold none: Topology.tsx renders three .maps and a conditional, and every
// coordinate in the output was computed here.

export const SCENE_W = 760;
export const FRAME_PAD = 14;
/** The label band inside a frame: badge, label, count, note. */
export const FRAME_HEAD = 32;
export const RAIL_GAP = 14;
export const SLOT_W = 120;
export const SLOT_H = 104;
export const SLOT_GAP = 12;
export const ICON = 48;
export const BADGE = 20;
/** One slot plus two pads. A frame with `span: 'column'` is this wide - the width the Amazon EBS
 *  frame has always had, named for what it holds rather than for the one frame that wanted it. */
export const COLUMN_W = SLOT_W + 2 * FRAME_PAD;
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

/**
 * Below this share of the rows a dimension applies to, the dimension is not offered - it is
 * explained.
 *
 * A control that appears to narrow and narrows badly is the failure the filter exists to avoid,
 * and "narrows badly" is not only the zero case. Under the ECS call budget a partly answered
 * lookup is the ORDINARY state: with 40 of 400 services placed, a chip reading `vpc-0abc 12` is a
 * VPC that probably holds 120, and an approver who narrows to it reads a tenth of the picture as
 * the whole of it. Below the floor the dimension moves to `unavailable` WITH the fraction, which
 * is a control that says why it is not there rather than one that quietly lies.
 */
export const COVERAGE_FLOOR = 0.5;

// ---- what gets a picture ----------------------------------------------------------------------

/** Every picture this module can draw, by kind. */
export const TOPOLOGIES = { ec2: EC2_SPEC, lambda: LAMBDA_SPEC, ecs: ECS_SPEC };

/**
 * The policies this module draws, and which picture each gets.
 *
 * Three entries, on the operator's direction: EC2 first, then Lambda and ECS. Widening it further
 * is one entry here plus one spec - and a spec is a CANONICAL TOPOLOGY, which is the part that is
 * not free. A load balancer has a place in an ECS picture only by accident, and a diagram that
 * invents a home for a resource is the exact failure this feature exists to avoid.
 */
export const DIAGRAMMED_POLICIES = new Map([
  ['AmazonEC2FullAccess', 'ec2'],
  ['AWSLambda_FullAccess', 'lambda'],
  ['AmazonECS_FullAccess', 'ecs'],
]);

/**
 * Which topology a policy identifier gets, or null.
 *
 * The identifier is an ARN for an AWS managed policy and a bare name for a customer managed one,
 * so it is reduced the same way policyName() reduces it for display. Exact map membership, never a
 * substring test: MyAmazonECS_FullAccessCopy is a different policy - possibly one that grants
 * something else entirely - and gets no picture.
 */
export function topologyPolicy(identifier) {
  if (typeof identifier !== 'string' || !identifier) return null;
  const name = parseArn(identifier)?.name ?? identifier;
  return DIAGRAMMED_POLICIES.get(name) ?? null;
}

/** The spec a policy is drawn with, or null. */
export function specOf(policy) {
  const kind = topologyPolicy(policy?.identifier);
  return kind ? TOPOLOGIES[kind] : null;
}

// ---- measuring text ---------------------------------------------------------------------------

/**
 * Roughly how many "label units" a line of text occupies, where LABEL_BUDGET is what fits a cell.
 *
 * SVG <text> does not wrap and gives no signal when it overflows, so a label longer than its cell
 * hangs out of the VPC frame in production and nothing anywhere says so. A test runs this over
 * every label in every spec, which turns "somebody will notice eventually" into a failing suite the
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

/**
 * Every subnet a row NAMES, as a list.
 *
 * Two shapes, because they are two different facts and the querier records them separately. An EC2
 * instance IS IN one subnet (`subnet_id`, a string). A Lambda function or an ECS service ATTACHES
 * network interfaces IN up to sixteen (`subnet_ids`, a list) - AwsVpcConfiguration.subnets and
 * VpcConfigResponse.SubnetIds are both max 16. Folding the plural into the singular would make the
 * one type that can answer "which subnet is this in" unable to.
 *
 * A list of one for the EC2 shape, so `keeps` treats both identically and the EC2 filter behaves
 * exactly as it did.
 */
function subnetsOf(resource) {
  const one = resource?.subnet_id;
  if (typeof one === 'string' && one) return [one];
  const many = resource?.subnet_ids;
  return Array.isArray(many) ? many.filter((v) => typeof v === 'string' && v) : [];
}

/** The ECS cluster a row belongs to, as the querier recorded it. Empty for every other picture. */
function clusterOf(resource) {
  const value = resource?.cluster;
  return typeof value === 'string' && value ? value : '';
}

/**
 * What the placement lookup said about this row, or ''.
 *
 * Seven states and an absent key is one of them - see impact/inventory.py's Resource.placement.
 * The engine reads it for two things only: how many rows were measured into a VPC, and how many
 * were not measured and WHY. It never turns it into a position.
 */
function placementOf(resource) {
  const value = resource?.placement;
  return typeof value === 'string' && value ? value : '';
}

/**
 * What the picture can be narrowed by, and what it cannot.
 *
 * accounts and regions are read off the rows the container enumerated, so they are facts about this
 * assessment and the counts beside them are the same counts the picture draws. vpc, subnet and
 * cluster are read off the fields the placement lookup wrote, which is the same rule one step
 * removed: the container measured them, not this file.
 *
 * unavailable names the dimensions somebody will reasonably ask for and this data cannot serve,
 * WITH the reason. It is a field rather than a sentence on the screen because the screen must not
 * be the place that decides which filters are honest: a control that narrows nothing while looking
 * like it narrowed something is worse than no control, and worse still than a control that says
 * why it is not there. Two ways in: a spec names it statically (ECS's 시작 유형 and 보안 그룹), or
 * the lookup answered for too little of the picture - see COVERAGE_FLOOR.
 */
export function facets(policy) {
  const spec = specOf(policy);
  if (!spec) return null;
  const counts = { accounts: new Map(), regions: new Map(), vpcs: new Map(), subnets: new Map(),
                   clusters: new Map() };
  // Rows the placement lookup says nothing about. Counted rather than dropped: a VPC filter cannot
  // speak for them, and how many there are is the difference between "this VPC holds little" and
  // "most of this picture has no VPC recorded".
  let unplaced = 0;
  let placeable = 0;
  // Per dimension: how many of the rows it applies to it can actually speak for. COVERAGE_FLOOR
  // reads this. `applicable` is the rows a dimension could ever answer for - every row for account
  // and region, only the placeable types for the rest - so a volume having no VPC is not counted
  // against the lookup.
  const known = { accounts: 0, regions: 0, vpcs: 0, subnets: 0, clusters: 0 };
  const applicable = { accounts: 0, regions: 0, vpcs: 0, subnets: 0, clusters: 0 };
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const group of policy?.affected ?? []) {
    if (!spec.services.has(group?.service)) continue;
    const scoped = spec.placeable.has(group.resource_type);
    for (const resource of group.resources ?? []) {
      const account = accountOf(resource);
      const region = regionOf(resource);
      applicable.accounts += 1;
      applicable.regions += 1;
      if (account) { bump(counts.accounts, account); known.accounts += 1; }
      bump(counts.regions, region);
      known.regions += 1;
      if (!scoped) continue;
      placeable += 1;
      applicable.vpcs += 1;
      applicable.subnets += 1;
      applicable.clusters += 1;
      const vpc = vpcOf(resource);
      const cluster = clusterOf(resource);
      const subnets = subnetsOf(resource);
      // "AWS says this is in no VPC" is an ANSWER and not a gap, and the difference decides both
      // numbers below. A Lambda function that is not VPC-attached is the ORDINARY case; counting
      // it as a row the lookup could not speak for would put the VPC dimension under the coverage
      // floor on a perfectly measured account, and would print "배치를 읽지 못했다" about eight
      // functions AWS answered about. EC2 rows carry no `placement` at all, so for them this
      // reduces to "has a vpc_id" and both numbers are exactly what they have always been.
      const answered = !!vpc || placementOf(resource) === 'none';
      if (vpc) bump(counts.vpcs, vpc);
      if (answered) known.vpcs += 1; else unplaced += 1;
      // A resource that names several subnets is counted under each of them, so the subnet chips
      // can sum to more than the row count. The screen says so; folding it to one would be picking
      // one of sixteen.
      for (const subnet of subnets) bump(counts.subnets, subnet);
      if (subnets.length > 0 || answered) known.subnets += 1;
      if (cluster) { bump(counts.clusters, cluster); known.clusters += 1; }
    }
  }

  const listed = (map) => [...map.entries()]
    .map(([id, total]) => ({ id, total }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));

  const out = { accounts: [], regions: [], vpcs: [], subnets: [], clusters: [] };
  const coverage = {};
  const unavailable = [...(spec.unavailable ?? [])];
  for (const dimension of ['accounts', 'regions', 'vpcs', 'subnets', 'clusters']) {
    coverage[dimension] = { known: known[dimension], applicable: applicable[dimension] };
    if (!spec.dimensions.includes(dimension)) continue;
    if (applicable[dimension] > 0
        && known[dimension] / applicable[dimension] < COVERAGE_FLOOR) {
      unavailable.push({
        id: dimension,
        label: DIMENSION_LABEL[dimension],
        why: `배치를 확인한 것이 ${known[dimension].toLocaleString()}개뿐이라 `
             + `(해당 ${applicable[dimension].toLocaleString()}개 중) 좁히면 그림의 수와 어긋난다.`,
      });
      continue;
    }
    out[dimension] = listed(counts[dimension]);
  }
  return { ...out, unplaced, placeable, coverage, unavailable };
}

/** The Korean name of each filter dimension. Used for the unavailable notice; the bar's own labels
 *  come from the same table in the component. */
export const DIMENSION_LABEL = {
  accounts: '계정', regions: '리전', vpcs: 'VPC', subnets: '서브넷', clusters: '클러스터',
};

/** Whether a row survives the filter. A null or empty list on a dimension means 전체.
 *  Exported for graph.js, which narrows the relationship picture by exactly the same rule - two
 *  filters that could disagree would be two pictures of one account. */
export function keeps(filter, resource) {
  if (!filter) return true;
  const { accounts, regions, vpcs, subnets, clusters } = filter;
  if (accounts?.length && !accounts.includes(accountOf(resource))) return false;
  if (regions?.length && !regions.includes(regionOf(resource))) return false;
  // A row with no vpc_id does NOT match a chosen VPC. It is not evidence of belonging and it is not
  // evidence of not belonging - it is the absence of a recording - and the honest answer to "show
  // me what is in vpc-0abc" is the rows that say they are, with a count of the rows that say
  // nothing shown beside the picture rather than folded into it.
  if (vpcs?.length && !vpcs.includes(vpcOf(resource))) return false;
  // Intersection, because a resource can name several subnets. For the EC2 shape - one subnet -
  // this is exactly the membership test it always was.
  if (subnets?.length && !subnetsOf(resource).some((s) => subnets.includes(s))) return false;
  if (clusters?.length && !clusters.includes(clusterOf(resource))) return false;
  return true;
}

/** Whether any dimension of the filter actually narrows anything. */
export function filterActive(filter) {
  if (!filter) return false;
  return ['accounts', 'regions', 'vpcs', 'subnets', 'clusters']
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
 * Whether the assessment actually enumerated the services this picture is about.
 *
 * The distinction this exists to keep: a policy with no groups for its own service and a policy
 * whose enumeration FAILED are the same document shape - `affected` simply has no entry - and they
 * are opposite news. assess.py appends the service to `services_failed` and skips it, so the
 * assessment says which happened and the picture has to ask.
 *
 * False when ANY of the picture's services failed, because a picture missing part of its subject
 * must not present the rest as the whole.
 */
export function enumeratedFor(policy, coverage) {
  const spec = specOf(policy);
  if (!spec || !coverage) return true;
  const failed = new Set(coverage.services_failed ?? []);
  for (const service of spec.services) {
    if (failed.has(service)) return false;
    if (coverage.services_enumerated?.[service]?.error) return false;
  }
  return true;
}

/**
 * Everything the window draws, or null when this policy gets no picture.
 *
 * `enumerated` false means the lookup failed, and the empty picture then says SO rather than saying
 * the policy reaches nothing. An empty scene is otherwise indistinguishable from a failed one, and
 * for AmazonEC2FullAccess - ec2:* on everything - "이 정책이 닿는 EC2 자원이 없다" is the most
 * load-bearing false sentence this feature can produce, printed over a picture somebody
 * screenshots. The panel says the same thing in a banner the modal covers.
 *
 * Deterministic: two calls on the same input deepEqual. Nothing in here reads a clock, a random
 * source, or the length of a capped list.
 */
export function scene(policy, accountId, filter = null, enumerated = true) {
  const spec = specOf(policy);
  if (!spec) return null;
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
  // How many rows the QUERIER measured into a VPC, and how many it did not measure and why. This
  // is the only number in the picture that comes from a service call rather than from Resource
  // Explorer, and it is what a `measure: 'placed'` frame's existence and its band count are made
  // of. `unmeasured` is kept broken out by reason rather than summed, because "the lookup was
  // denied", "the budget ran out" and "AWS says this is in no VPC" are three different things and
  // the screen says a different sentence for each.
  let placed = 0;
  const unmeasured = {};

  for (const group of policy?.affected ?? []) {
    // Unfiltered, the count is the field the container publishes. Filtered, it is the rows that
    // survive - which is the SAME quantity, because assess.py sets total to the number of rows it
    // kept. Both are floors when `truncated` says the enumeration hit its cap, and the picture
    // marks them the same way, so narrowing the view never changes how sure a number is.
    const kept = (group?.resources ?? []).filter((r) => keeps(filter, r));
    const total = narrowed ? kept.length : (Number(group?.total) || 0);
    if (!spec.services.has(group?.service)) {
      // An omitted service is counted whole. Its rows are not this picture's rows and the
      // account/region filter is about the picture, not about the footnote naming what it omits.
      const whole = Number(group?.total) || 0;
      if (whole > 0) omittedBy.set(group.service, (omittedBy.get(group.service) ?? 0) + whole);
      continue;
    }
    if (total === 0) continue;
    if (group.truncated) truncated = true;
    for (const resource of kept) regions.add(regionOf(resource));
    if (spec.placeable.has(group.resource_type)) {
      for (const resource of kept) {
        // A VPC id IS the answer 'vpc'. The EC2 lookup records the VPC and the subnet on the row
        // and writes no `placement` word - that word is the Lambda and ECS lookups' - and reading
        // its absence as "unanswered" printed 조회가 답하지 않았다 over every EC2 row the lookup
        // had placed. facets() already counts a row with a VPC as answered; this is the same rule.
        const state = placementOf(resource) || (vpcOf(resource) ? 'vpc' : '');
        // 'none' is an ANSWER - AWS said this resource is in no VPC - so it is neither placed nor
        // unmeasured. For a Lambda function that is the ordinary case, and counting it as a gap
        // would print "배치를 읽지 못했다" about rows the lookup answered perfectly well about.
        if (state === 'vpc') placed += 1;
        else if (state !== 'none') {
          // No recorded state at all is 'unanswered', which covers an assessment written before
          // the lookup existed and a row the lookup skipped - and reading either as "AWS says this
          // is in no VPC" would draw a missing permission as an architectural fact.
          const reason = state || 'unanswered';
          unmeasured[reason] = (unmeasured[reason] ?? 0) + 1;
        }
      }
    }
    measured += total;
    kinds += 1;

    const slot = spec.slots[group.resource_type];
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
      label: slot?.kind === 'frame' ? [spec.frameLabel[slot.frame]]
        : (slot?.label ?? [group.resource_type]),
      icon: slot?.kind === 'node' ? (slot.icon ?? null) : null,
      rail: slot?.kind === 'node' ? slot.rail : null,
      frame: slot?.kind === 'frame' ? slot.frame : (slot ? spec.rails[slot.rail].frame : null),
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
  const order = Object.keys(spec.slots);
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
  const byId = new Map(spec.frames.map((f) => [f.id, f]));
  const kidsOf = (id) => spec.frames.filter((f) => f.parent === id);
  const railOf = (f) => (f.rail ? (railSlots.get(f.rail) ?? []) : []);
  const root = spec.frames.find((f) => f.parent === null);
  // The rail whose one slot sits ON a border rather than inside a frame, if this picture has one.
  // EC2's internet gateway is the only one in the codebase, and it stays the only one: a plate
  // crossing a border is the loudest sentence available here, and it can only be said about
  // something that is definitionally on that border.
  const straddleRail = Object.entries(spec.rails).find(([, r]) => r.straddle)?.[0] ?? null;
  const straddler = straddleRail ? ((railSlots.get(straddleRail) ?? [])[0] ?? null) : null;

  const drawn = (f) => {
    if (f.always) return true;
    // A ghost frame is a position, not a measurement - it is drawn whenever anything it would
    // contain is, and it never carries a count.
    if (f.ghost) return kidsOf(f.id).some(drawn);
    // A `measure` frame is drawn only when the querier actually placed something into it. An empty
    // VPC box on a Lambda picture would say every function is VPC-attached, when the ordinary
    // account has none - which is the single biggest lie available in that picture.
    if (f.measure === 'placed') return placed > 0;
    if (straddler && straddleRail && spec.rails[straddleRail].frame === f.id) return true;
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
    if (f.arrange === 'row') {
      // Side by side. A kid with `span: 'column'` keeps a fixed width because it holds exactly one
      // column of slots; the rest share what is left. For EC2's one row - 서브넷 beside Amazon EBS
      // - this is byte-identical to the two-kid split it replaces.
      const fixed = kids.filter((k) => k.span).length;
      const spent = fixed * COLUMN_W + RAIL_GAP * Math.max(0, kids.length - 1);
      const free = Math.max(1, kids.length - fixed);
      const share = (innerW - spent) / free;
      let cursor = inner;
      for (const kid of kids) {
        const kw = kid.span ? COLUMN_W : share;
        place(kid, cursor, kw);
        cursor += kw + RAIL_GAP;
      }
      return;
    }
    for (const kid of kids) place(kid, inner, kid.span ? COLUMN_W : innerW);
  };
  place(root, 1, SCENE_W - 2);

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
  // Read off the rails table rather than written as 'vpc', so moving the straddle to another
  // border moves its clearance with it - and a picture with no straddle reserves nothing.
  const straddled = straddleRail ? spec.rails[straddleRail].frame : null;
  const straddleParent = straddled ? (byId.get(straddled)?.parent ?? null) : null;
  const headOf = (f) => (straddler && (f.id === straddled || f.id === straddleParent)
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
  measure(root);

  // ---- pass 3: place ------------------------------------------------------------------------
  const frames = [];
  const slots = [];
  const regionList = [...regions].sort();

  // The notes every picture shares, in the order they are decided. The region band is here rather
  // than in a spec because its three empty states - lookup failed, filter matched nothing, policy
  // reaches nothing - are the same distinction in every picture and must not drift between them;
  // only the noun changes, and it comes from the spec.
  const noteFor = (f) => {
    if (f.id === root.id) return accountId ? `계정 ${accountId}` : null;
    if (f.rail && spec.rails[f.rail]?.frame === f.id && f.longNote) {
      if (regionList.length === 0) {
        if (!enumerated) return `${spec.words.subject} 조회가 실패했다 — 없다는 뜻이 아니다`;
        return narrowed ? '고른 조건에 맞는 자원이 없다'
          : `이 정책이 닿는 ${spec.words.subject} 자원이 없다`;
      }
      const head = regionList.length === 1 ? regionList[0]
        : `${regionList.length}곳 — ${regionList.slice(0, 3).join(', ')}`
          + (regionList.length > 3 ? ` 외 ${regionList.length - 3}곳` : '');
      // The region set is read off the enumerated rows, which the container caps at 1000. When a
      // group was cut, the set of regions is a floor exactly as the counts are.
      return truncated ? `${head} · 잘린 목록에서 읽은 것이다` : head;
    }
    // Then whatever this picture wants to say about its own frames, and only then the engine's
    // fallback for a frame that IS a type and has none of it.
    const own = spec.noteFor?.(f.id, { accountId, narrowed, enumerated, placed, regionList });
    if (own) return own;
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
  const bandText = (f, count, sensitive) => `${spec.frameLabel[f.id]}`
    + (count ? `  ${count.countLabel}` : '') + (sensitive > 0 ? `  민감 ${sensitive}개` : '');

  const walk = (f, y) => {
    const x = xOf.get(f.id);
    const w = widthOf.get(f.id);
    const h = heightOf.get(f.id);
    // A frame's count is either its own type's count, or - for a frame that exists BECAUSE the
    // querier measured something into it - what the querier measured. The second is the only
    // number in any picture that came from a service call rather than from Resource Explorer, and
    // it says what it is: `배치 확인`, not a resource count.
    const count = f.measure === 'placed'
      ? { countLabel: `${placed.toLocaleString()}개 배치 확인`, sensitive: 0 }
      : (frameCount.get(f.id) ?? null);
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
      label: spec.frameLabel[f.id],
      count: count ? count.countLabel : null,
      note,
      // The one frame that is a position rather than a measurement. The renderer fades it, so the
      // field carries the intention its name always claimed instead of being read by one assertion.
      ghost: !!f.ghost,
      // A COUNT, not a flag, and rendered on the label band rather than as a border colour. The
      // legend promised 빨간 테두리 for sensitive resources while the 보안 그룹 border was red
      // unconditionally and no frame ever turned red for being sensitive - false in both
      // directions, and the sensitive thread is the one the panel force-opens the block for.
      sensitive,
      title: f.longNote && regionList.length > 3 ? regionList.join(', ') : null,
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
  walk(root, spec.sky);

  // The one slot that is not inside anything. Its vertical centre sits exactly on the border it
  // straddles, which is what an internet gateway IS; `erase` tells the renderer to knock the border
  // out from under it so position itself is the statement and no arrow has to say "this is the
  // boundary". Only EC2 has one, and only because a gateway is definitionally on that border - a
  // straddle asserted about a population that is partly measured would be the loudest sentence in
  // the picture said about a fraction.
  let link = null;
  if (straddler) {
    const host = frames.find((f) => f.id === straddled);
    const x = host.x + host.w - FRAME_PAD - SLOT_W;
    const y = host.y - SLOT_H / 2;
    slots.push({
      key: straddler.resourceType,
      resourceType: straddler.resourceType,
      x, y, w: SLOT_W, h: SLOT_H,
      icon: straddler.icon,
      label: straddler.label,
      count: straddler.countLabel,
      sensitive: straddler.sensitive > 0,
      erase: true,
      title: `${straddler.resourceType} — ${straddler.label.join(' ')} ${straddler.countLabel}`,
    });
    const spelt = spec.rails[straddleRail].link;
    if (spelt) link = { cx: x + SLOT_W / 2, ...spelt, to: y };
  }

  // ---- the foot lines, inside the viewBox ---------------------------------------------------
  const cloud = frames.find((f) => f.id === root.id);
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
  foot.push(spec.words.caption);

  const footTop = spec.sky + cloud.h + FOOT_PAD;
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
    /** Whether the assessment enumerated this picture's services at all. False makes an empty
     *  picture a statement about the LOOKUP and not about the policy - see enumeratedFor. */
    enumerated,
    /** Which picture this is. */
    kind: spec.kind,
    /** Rows the querier measured into a VPC. 0 for EC2, which records no `placement`. */
    placed,
    /** Rows of a placeable type the lookup did not place, by reason. */
    unmeasured,
  };
}

/**
 * The caption a picture draws INSIDE its viewBox, from the one noun that differs between them.
 *
 * The no-identities rule is a strong screenshot defence and not a complete one - a 보안 그룹 frame
 * with 인스턴스 40개 in it still travels - and a caveat in the dialog body does not travel with a
 * cropped image. This one does. Built here rather than written out three times so the sentence
 * cannot drift between pictures; `home` is the only part a spec supplies, and EC2's reproduces the
 * string this caption has always carried, character for character.
 */
export function captionFor(home) {
  return `이 그림은 자원 유형을 ${home}에 놓은 것이다. 테두리의 포함 관계는 측정한 것이 아니다.`;
}

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
  const words = TOPOLOGIES[scene.kind]?.words ?? { subject: '', summaryHome: '' };
  if (scene.empty) {
    if (!scene.enumerated) {
      return `이 평가는 ${words.subject} 자원 조회에 실패해서 그릴 것이 없다. 이 정책이 닿는 `
        + '자원이 없다는 뜻이 아니다. 계정과 리전 테두리만 그렸다.';
    }
    return scene.narrowed
      ? `고른 계정과 리전에 이 정책이 닿는 ${words.subject} 자원이 없다. 계정과 리전 테두리만 그렸다.`
      : `이 정책이 닿는 ${words.subject} 자원이 인벤토리에 없다. 계정과 리전 테두리만 그렸다.`;
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
  return `이 정책이 닿는 ${words.subject} 자원 ${scene.kinds}종 `
    + `${scene.measured.toLocaleString()}개${floor}를 `
    + `${words.summaryHome}에 놓은 그림이다. ${region}`
    + (scene.truncated ? ' — 잘린 목록에서 읽은 하한이다' : '') + '. '
    // Empty when every type this policy reaches is one the picture has no slot for: the sentence
    // then said "…자리에 놓은 그림이다" about nothing placed, and left a stray ". ." behind it.
    + (placed ? `${placed}. ` : '')
    + (scene.unslotted.length > 0 ? `그림에 자리가 없는 유형 ${scene.unslotted.length}종. ` : '')
    + (scene.omitted.length > 0 ? `그림 밖 서비스 ${scene.omitted.length}종. ` : '')
    + '테두리의 포함 관계는 측정한 것이 아니다.';
}

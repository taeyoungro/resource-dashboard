// The scene behind 구성도 보기 - what an approver cannot verify by looking at the picture.
//
// The split is deliberate. The SCREEN half of this feature lives in src/components/Topology.tsx and
// is pinned as source text by riskUi.test.js: the sentences that keep the picture honest, where the
// caveats sit, that the component computes nothing. What this file pins is everything a reader
// would have to trust: which frame a resource type lands in, whether a resource can silently
// vanish between the panel and the drawing, whether the counts are the true ones, and whether the
// geometry actually says what the labels say.
//
// The last of those is the reason a unit test exists here at all. A slot that escapes its frame is
// a picture claiming a containment while every sentence above it says the containment was never
// measured - and no source-text assertion can see it, because the source is a .map over numbers
// somebody else computed.
//
//     node --test server/ec2Topology.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTION, EC2_FRAMES, EC2_RAILS, EC2_SLOTS, LABEL_BUDGET, SCENE_W,
  VPC_SCOPED, ec2Scene, facets, filterActive, sceneSummary, textUnits, topologyPolicy,
} from './ec2Topology.js';
import { RESOURCE_TYPE_ICONS } from './serviceIcons.js';

const ACCOUNT = '718100330247';
const EC2_ARN = 'arn:aws:iam::aws:policy/AmazonEC2FullAccess';
const ICON_DIR = fileURLToPath(new URL('../public/aws-icons', import.meta.url));
/** The module with its comments stripped. The prose explains at length what the code must NOT do -
 *  "it must not consult serviceIcons.js", "counts come from group.total and never from
 *  group.resources.length" - so an assertion against the raw file fails on the sentence forbidding
 *  the thing it is looking for. What these tests are about is the CODE. */
const CODE = readFileSync(new URL('./ec2Topology.js', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** One ImpactGroup, with a row so the region fallback has something to read. */
function group(resourceType, total, over = {}) {
  return {
    service: resourceType.split(':')[0],
    resource_type: resourceType,
    actions: [],
    scope: 'listed',
    total,
    truncated: false,
    sensitive_hits: 0,
    resources: [{
      arn: `arn:aws:ec2:ap-northeast-2:${ACCOUNT}:thing/x`,
      region: 'ap-northeast-2', tags: {}, sensitive: false,
    }],
    ...over,
  };
}

function policyOf(affected, identifier = EC2_ARN) {
  return {
    source: 'aws_managed',
    identifier,
    default_version_id: 'v1',
    is_baseline: false,
    restrictable: true,
    unreadable: null,
    actions_granted: ['ec2:*'],
    affected,
  };
}

const FULL = [
  group('ec2:instance', 40), group('ec2:volume', 12), group('ec2:snapshot', 2),
  group('ec2:security-group', 8), group('ec2:subnet', 5), group('ec2:vpc', 3),
  group('ec2:image', 4), group('ec2:key-pair', 2), group('ec2:internet-gateway', 1),
  group('ec2:route-table', 6),
];

test('그림과 목록을 합치면 패널이 센 자원 수가 된다', () => {
  // The accounting invariant. Every resource the panel counted is either drawn, or named in the
  // foot line, or named as an omitted service - and this is what says so arithmetically.
  //
  // Defect it prevents: a resource type disappearing from the picture AND from every list, because
  // nothing in the layout knew where to put it and nothing downstream noticed it was gone.
  const affected = [
    ...FULL,
    group('ec2:quantum-widget', 7),
    { ...group('elasticloadbalancing:loadbalancer', 3), service: 'elasticloadbalancing' },
  ];
  const scene = ec2Scene(policyOf(affected), ACCOUNT);
  const drawn = scene.rows.reduce((n, r) => n + r.total, 0);
  const outside = scene.omitted.reduce((n, o) => n + o.total, 0);
  const panel = affected.reduce((n, g) => n + g.total, 0);
  assert.equal(drawn + outside, panel, 'a resource vanished between the panel and the picture');
});

test('a resource type with no slot is listed, never placed in a neighbouring frame', () => {
  // Defect it prevents: a drifted type getting a home it did not earn. A raw resource_type does not
  // fit a 120px cell, and a mis-sized plate inside the VPC frame is a placement claim nobody made.
  const scene = ec2Scene(policyOf([...FULL, group('ec2:quantum-widget', 7)]), ACCOUNT);
  assert.ok(scene.unslotted.some((r) => r.resourceType === 'ec2:quantum-widget'));
  assert.ok(!scene.slots.some((s) => s.resourceType === 'ec2:quantum-widget'),
            'an unknown type was drawn into whatever frame happened to be nearby');
  assert.ok(scene.foot.some((l) => l.text.includes('ec2:quantum-widget')),
            'an undrawable type left no trace on the picture');
});

test('the diagram never falls back to the service icon', () => {
  // resourceIconPath('ec2', anything) never returns null - it falls through to Amazon-EC2.svg. In
  // the panel's list that is decoration; in a diagram an EC2 tile sitting inside the 보안 그룹
  // frame is a placement claim about key pairs.
  const scene = ec2Scene(policyOf([group('ec2:key-pair', 2), group('ec2:host', 1)]), ACCOUNT);
  assert.ok(!JSON.stringify(scene).includes('Amazon-EC2.svg'),
            'a type with no glyph of its own borrowed the service icon');
  assert.ok(scene.slots.every((s) => s.icon === null || s.icon.startsWith('Res-')),
            'a slot rendered something other than a Res_*_48 glyph');
  assert.ok(!CODE.includes('resourceIconPath') && !/from '\.\/serviceIcons/.test(CODE),
            'the module reached for the service icon table');
});

test('every icon a slot or a frame badge names exists among the extracted files', () => {
  // Defect it prevents: a blank plate shipping where a glyph was intended. An <image> whose href
  // 404s renders nothing, silently - the same visual state as an honest icon: null - so nothing on
  // the page would ever say the asset was missing.
  const files = new Set(readdirSync(ICON_DIR));
  const named = [
    ...EC2_FRAMES.map((f) => f.badge),
    ...Object.values(EC2_SLOTS).map((s) => s.icon),
    'Res-Internet.svg',
  ].filter(Boolean);
  for (const icon of named) {
    assert.ok(files.has(icon),
              `${icon} is named by the slot table and is not in public/aws-icons - `
              + 're-run tools/extract-aws-icons.mjs or fix the entry');
  }
  assert.ok(named.length >= 20, 'the icon list shrank to nothing and this test stopped testing');
});

test('the diagram icons cannot shadow a service icon', () => {
  // Res_Amazon-EC2_Instance_48 and Arch_Amazon-EC2_64 would both want to be Amazon-EC2.svg. The
  // Res-/Group- prefixes are what keep the second write from replacing the icon every policy
  // summary line renders.
  const files = readdirSync(ICON_DIR);
  const prefixed = files.filter((f) => f.startsWith('Res-') || f.startsWith('Group-'));
  assert.ok(prefixed.length >= 21, 'the diagram assets are missing from public/aws-icons');
  for (const file of prefixed) {
    const bare = file.replace(/^(Res|Group)-/, '');
    assert.ok(!files.includes(bare) || bare !== file,
              `${file} collides with the service icon ${bare}`);
  }
});

test('every slot lies inside the frame it is drawn in', () => {
  // Defect it prevents: a geometry bug that lets a plate escape its frame - a picture that lies
  // about containment while every sentence above it says the containment was never measured. No
  // source-text test can see this one.
  const scene = ec2Scene(policyOf(FULL), ACCOUNT);
  const frames = new Map(scene.frames.map((f) => [f.id, f]));
  for (const slot of scene.slots) {
    const spec = EC2_SLOTS[slot.resourceType];
    const rail = EC2_RAILS[spec.rail];
    const frame = frames.get(rail.frame);
    assert.ok(frame, `${slot.resourceType} names a rail whose frame is not drawn`);
    assert.ok(slot.x >= frame.x && slot.x + slot.w <= frame.x + frame.w,
              `${slot.resourceType} is outside ${frame.id} horizontally`);
    if (rail.straddle) continue;
    assert.ok(slot.y >= frame.y && slot.y + slot.h <= frame.y + frame.h,
              `${slot.resourceType} is outside ${frame.id} vertically`);
  }
  for (const frame of scene.frames) {
    const spec = EC2_FRAMES.find((f) => f.id === frame.id);
    if (!spec.parent) continue;
    const parent = frames.get(spec.parent);
    assert.ok(frame.x >= parent.x && frame.x + frame.w <= parent.x + parent.w
              && frame.y >= parent.y && frame.y + frame.h <= parent.y + parent.h,
              `${frame.id} is not inside ${parent.id}`);
  }
});

test('no two slots overlap', () => {
  const scene = ec2Scene(policyOf(Object.keys(EC2_SLOTS).map((t) => group(t, 3))), ACCOUNT);
  for (let i = 0; i < scene.slots.length; i += 1) {
    for (let j = i + 1; j < scene.slots.length; j += 1) {
      const a = scene.slots[i];
      const b = scene.slots[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x
        || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.resourceType} overlaps ${b.resourceType}`);
    }
  }
});

test('one instance and four thousand instances draw the same picture', () => {
  // Defect it prevents: a layout that reads the inventory. The unit of the picture is the TYPE, so
  // geometry is constant in the number of resources - and that is what makes the diagram usable on
  // an account with forty thousand of them.
  const geometry = (n) => {
    const scene = ec2Scene(policyOf([group('ec2:instance', n), group('ec2:volume', n)]), ACCOUNT);
    return {
      width: scene.width,
      height: scene.height,
      frames: scene.frames.map((f) => [f.id, f.x, f.y, f.w, f.h]),
      slots: scene.slots.map((s) => [s.resourceType, s.x, s.y, s.w, s.h]),
    };
  };
  assert.deepEqual(geometry(1), geometry(4000));
});

test('counts come from group.total, not from the rows the container returned', () => {
  // The container caps resources at 1000 and GroupBlock shows 50 of them. total is the true count,
  // and a floor when the group was cut.
  const big = group('ec2:instance', 4000);
  const scene = ec2Scene(policyOf([big]), ACCOUNT);
  assert.equal(scene.slots[0].count, '4,000개');
  assert.equal(scene.measured, 4000);

  const cut = ec2Scene(policyOf([{ ...big, truncated: true }]), ACCOUNT);
  assert.equal(cut.slots[0].count, '4,000개 이상†');
  assert.ok(cut.truncated, 'a truncated group did not raise the scene-wide flag');
  assert.ok(!CODE.includes('resources.length'), 'the module counted the capped row list');
});

test('the region list is a floor when a group is truncated', () => {
  // Regions are read off the enumerated rows, which the container caps - so when a group was cut
  // the set of regions is a floor exactly as the counts are, and the frame has to say so.
  const scene = ec2Scene(policyOf([{ ...group('ec2:instance', 4000), truncated: true }]), ACCOUNT);
  const region = scene.frames.find((f) => f.id === 'region');
  assert.match(region.note, /잘린 목록에서 읽은 것이다/,
               'the picture claimed a completeness the region set does not have');
});

test('the region set uses the same fallback the resource rows do', () => {
  const rows = [
    { arn: 'arn:aws:ec2:eu-west-1:1:i/a', region: 'ap-northeast-2', tags: {}, sensitive: false },
    { arn: 'arn:aws:ec2:eu-west-1:1:i/b', region: '', tags: {}, sensitive: false },
    { arn: 'not-an-arn', region: '', tags: {}, sensitive: false },
  ];
  const scene = ec2Scene(policyOf([group('ec2:instance', 3, { resources: rows })]), ACCOUNT);
  assert.deepEqual(scene.regions, ['ap-northeast-2', 'eu-west-1', 'global']);
});

test('every label line fits its cell', () => {
  // Defect it prevents: a slot with a long Korean name shipping a picture with text hanging out of
  // the VPC frame. SVG <text> does not wrap and says nothing when it overflows.
  for (const [type, slot] of Object.entries(EC2_SLOTS)) {
    if (slot.kind !== 'node') continue;
    assert.ok(slot.label.length <= 2, `${type} needs more than two label lines`);
    for (const line of slot.label) {
      assert.ok(textUnits(line) <= LABEL_BUDGET,
                `${type} label "${line}" is ${textUnits(line).toFixed(1)} units, over ${LABEL_BUDGET}`);
    }
  }
});

test('an ec2 type a neighbouring table knows about has a slot here', () => {
  // Defect it prevents: the next person teaching RESOURCE_TYPE_ICONS about an EC2 type and leaving
  // this table to find out by drift. The unslotted foot line is a real channel but a quiet one.
  for (const type of Object.keys(RESOURCE_TYPE_ICONS)) {
    if (!type.startsWith('ec2:')) continue;
    assert.ok(type in EC2_SLOTS,
              `${type} is in RESOURCE_TYPE_ICONS and has no slot - add one, or a NO_SLOT reason`);
  }
});

test('a frame with nothing in it is not drawn, and 가용 영역 always is', () => {
  // Defect it prevents: an empty 보안 그룹 frame reading as "this policy reaches a security group".
  const scene = ec2Scene(policyOf([group('ec2:volume', 4)]), ACCOUNT);
  const ids = scene.frames.map((f) => f.id);
  assert.deepEqual(ids, ['cloud', 'region', 'az', 'ebs']);
  const az = scene.frames.find((f) => f.id === 'az');
  assert.equal(az.count, null, 'the availability zone reported a count it cannot have');
  assert.equal(az.note, '평가에 없음');
  assert.ok(az.ghost);
});

test('a frame drawn only to hold something says it counted nothing', () => {
  const scene = ec2Scene(policyOf([group('ec2:instance', 40)]), ACCOUNT);
  const sg = scene.frames.find((f) => f.id === 'sg');
  assert.ok(sg, 'the frame holding the compute rail was not drawn');
  assert.equal(sg.count, null);
  assert.equal(sg.note, '인벤토리에 없음',
               'a frame with no measurement of its own said nothing about that');
});

test('the link is drawn only when the internet gateway is', () => {
  const without = ec2Scene(policyOf([group('ec2:instance', 3)]), ACCOUNT);
  assert.equal(without.link, null, 'an arrow was drawn to a gateway that is not in the picture');

  const scene = ec2Scene(policyOf(FULL), ACCOUNT);
  const igw = scene.slots.find((s) => s.resourceType === 'ec2:internet-gateway');
  const vpc = scene.frames.find((f) => f.id === 'vpc');
  const az = scene.frames.find((f) => f.id === 'az');
  assert.ok(scene.link, 'the gateway is drawn and its link is not');
  assert.equal(igw.y + igw.h / 2, vpc.y, 'the gateway does not straddle the VPC border');
  assert.ok(igw.erase, 'the border is not knocked out from under the gateway');
  assert.ok(igw.y > az.y && igw.y + igw.h < az.y + az.h,
            'the gateway escapes the availability zone, which it is not on the border of');
});

test('a non-ec2 group never enters the scene and is named in omitted', () => {
  // Defect it prevents: a load balancer drawn inside a security group, which is not a place a load
  // balancer is.
  const affected = [{ ...group('elasticloadbalancing:loadbalancer', 3), service: 'elasticloadbalancing' }];
  const scene = ec2Scene(policyOf(affected), ACCOUNT);
  assert.equal(scene.slots.length, 0);
  assert.ok(!scene.frames.some((f) => f.id === 'sg'));
  assert.deepEqual(scene.omitted, [{ service: 'elasticloadbalancing', total: 3 }]);
  assert.ok(scene.empty, 'a picture with no EC2 resource did not say it was empty');
});

test('only AmazonEC2FullAccess gets a scene, by ARN and by bare name', () => {
  // Defect it prevents: a read-only policy drawing a picture of instances it cannot change.
  assert.equal(topologyPolicy(EC2_ARN), 'ec2');
  assert.equal(topologyPolicy('AmazonEC2FullAccess'), 'ec2');
  for (const other of ['AmazonEC2ReadOnlyAccess', 'MyAmazonEC2FullAccessCopy',
                       'AdministratorAccess', 'arn:aws:iam::aws:policy/AmazonS3FullAccess',
                       '', null, undefined]) {
    assert.equal(topologyPolicy(other), null, `${other} was given a picture`);
  }
  assert.equal(ec2Scene(policyOf(FULL, 'AmazonEC2ReadOnlyAccess'), ACCOUNT), null);
});

test('a slot never grows a field naming what it is attached to', () => {
  // Defect it prevents: the module quietly becoming a graph. The assessment carries no containment,
  // so a field saying which instance a volume is attached to could only ever be invented.
  const scene = ec2Scene(policyOf(FULL), ACCOUNT);
  assert.deepEqual(Object.keys(scene.slots[0]).sort(), [
    'count', 'erase', 'h', 'icon', 'key', 'label', 'resourceType', 'sensitive', 'title', 'w', 'x', 'y',
  ]);
});

test('the scene is deterministic and the width is constant', () => {
  const twice = () => ec2Scene(policyOf(FULL), ACCOUNT);
  assert.deepEqual(twice(), twice());
  const everything = ec2Scene(
    policyOf(Object.keys(EC2_SLOTS).map((t) => group(t, 5))), ACCOUNT,
  );
  assert.equal(everything.width, SCENE_W, 'a busy account widened the picture');
  assert.equal(ec2Scene(policyOf([group('ec2:volume', 1)]), ACCOUNT).width, SCENE_W);
});

test('sceneSummary names every measured type and ends with the caveat', () => {
  // The <desc> is what a screen reader gets instead of the picture, so it is pinned like content.
  const scene = ec2Scene(policyOf(FULL), ACCOUNT);
  const desc = sceneSummary(scene);
  for (const row of scene.rows) {
    assert.ok(desc.includes(row.label.join(' ')), `${row.resourceType} is missing from the desc`);
  }
  assert.match(desc, /테두리의 포함 관계는 측정한 것이 아니다\.$/,
               'the text equivalent does not end on the caveat the picture ends on');
  assert.match(sceneSummary(ec2Scene(policyOf([]), ACCOUNT)), /인벤토리에 없다/);
});

test('the caption travels inside the picture', () => {
  // A caveat in the dialog body does not survive a cropped screenshot. This one is a <text> in the
  // viewBox, so it does.
  const scene = ec2Scene(policyOf(FULL), ACCOUNT);
  assert.equal(scene.foot.at(-1).text, CAPTION);
  assert.match(CAPTION, /측정한 것이 아니다/);
  assert.ok(scene.foot.at(-1).y < scene.height, 'the caption is drawn outside the viewBox');
});

// ---- narrowing the picture ---------------------------------------------------------------------
//
// The account and the region a resource sits in are facts every row carries, so the picture can be
// narrowed to them. Which VPC or subnet a resource sits in is NOT in this assessment at all, and
// the tests below pin that the module says so rather than offering a control that narrows nothing.

/** A row in a named region and account, so the facet tests have something to separate. */
function rowIn(region, account = ACCOUNT, kind = 'instance') {
  return {
    arn: `arn:aws:ec2:${region}:${account}:${kind}/${region}-${account}`,
    region, tags: {}, sensitive: false,
  };
}

const TWO_REGIONS = [
  group('ec2:instance', 3, {
    resources: [rowIn('ap-northeast-2'), rowIn('ap-northeast-2'), rowIn('us-east-1')],
  }),
  group('ec2:volume', 2, { resources: [rowIn('us-east-1', ACCOUNT, 'volume')] }),
];

test('the facets are read off the rows', () => {
  const found = facets(policyOf(TWO_REGIONS));
  assert.deepEqual(found.regions, [
    { id: 'ap-northeast-2', total: 2 },
    { id: 'us-east-1', total: 2 },
  ]);
  assert.deepEqual(found.accounts, [{ id: ACCOUNT, total: 4 }]);
  assert.equal(facets(policyOf(TWO_REGIONS, 'AdministratorAccess')), null);
});

test('a region filter narrows the picture to that region', () => {
  // Defect it prevents: a filter that renders a smaller picture without actually changing which
  // resources it counts - which is the same picture with a smaller number under it.
  const scene = ec2Scene(policyOf(TWO_REGIONS), ACCOUNT, { regions: ['us-east-1'] });
  assert.ok(scene.narrowed);
  assert.deepEqual(scene.regions, ['us-east-1']);
  const instances = scene.slots.find((s) => s.resourceType === 'ec2:instance');
  assert.equal(instances.count, '1개', 'the count is the whole group rather than the matching rows');
  assert.equal(scene.measured, 2);
});

test('an account filter narrows on the ARN, which is where the account is', () => {
  const mixed = [group('ec2:instance', 2, {
    resources: [rowIn('us-east-1', ACCOUNT), rowIn('us-east-1', '999999999999')],
  })];
  const scene = ec2Scene(policyOf(mixed), ACCOUNT, { accounts: ['999999999999'] });
  assert.equal(scene.measured, 1);
  assert.equal(scene.slots[0].count, '1개');
});

test('the filter combines - both dimensions have to match', () => {
  const scene = ec2Scene(policyOf(TWO_REGIONS), ACCOUNT,
                         { accounts: [ACCOUNT], regions: ['ap-northeast-2'] });
  assert.equal(scene.measured, 2, 'the two dimensions did not intersect');
  assert.ok(!scene.slots.some((s) => s.resourceType === 'ec2:volume'),
            'a type with no row in the chosen region was still drawn');
});

test('an empty picture says whether the FILTER emptied it', () => {
  // Defect it prevents: a narrowed picture with nothing in it reading as "this policy reaches
  // nothing", which is a statement about the policy and not about the filter.
  const narrowed = ec2Scene(policyOf(TWO_REGIONS), ACCOUNT, { regions: ['eu-west-1'] });
  assert.ok(narrowed.empty && narrowed.narrowed);
  assert.match(sceneSummary(narrowed), /고른 계정과 리전에/);
  assert.match(narrowed.frames.find((f) => f.id === 'region').note, /고른 조건에 맞는 자원이 없다/);

  const whole = ec2Scene(policyOf([]), ACCOUNT);
  assert.ok(whole.empty && !whole.narrowed);
  assert.match(sceneSummary(whole), /인벤토리에 없다/);
});

test('전체 is the unfiltered picture, however it is spelled', () => {
  const whole = ec2Scene(policyOf(TWO_REGIONS), ACCOUNT);
  for (const filter of [null, {}, { regions: [] }, { accounts: [], regions: [] },
                        { accounts: null, regions: null }]) {
    assert.equal(filterActive(filter), false, `${JSON.stringify(filter)} counted as a filter`);
    assert.deepEqual(ec2Scene(policyOf(TWO_REGIONS), ACCOUNT, filter), whole,
                     `${JSON.stringify(filter)} drew something other than the whole picture`);
  }
});

test('a filter never changes how sure a number is', () => {
  // Filtered counts come from the rows and unfiltered ones from group.total, and assess.py sets
  // total to the number of rows it kept - so the two are the same quantity and a truncated group is
  // a floor either way. A filter that silently upgraded a floor to an exact count would be the
  // picture claiming completeness it lost at the container.
  const cut = [group('ec2:instance', 2, {
    truncated: true, resources: [rowIn('us-east-1'), rowIn('ap-northeast-2')],
  })];
  const scene = ec2Scene(policyOf(cut), ACCOUNT, { regions: ['us-east-1'] });
  assert.ok(scene.truncated, 'the scene forgot the group was truncated once it was filtered');
  assert.match(scene.slots[0].count, /이상†/, 'a filtered count lost its floor marking');
});

test('a filter cannot change what the picture leaves out', () => {
  // The omitted-services footnote is about the whole policy. Narrowing the drawing must not make a
  // service the policy reaches look smaller than it is.
  const affected = [
    ...TWO_REGIONS,
    { ...group('elasticloadbalancing:loadbalancer', 3), service: 'elasticloadbalancing' },
  ];
  const whole = ec2Scene(policyOf(affected), ACCOUNT);
  const narrowed = ec2Scene(policyOf(affected), ACCOUNT, { regions: ['us-east-1'] });
  assert.deepEqual(narrowed.omitted, whole.omitted);
});

test('narrowing keeps every geometric guarantee', () => {
  // The layout does not get a second implementation for the filtered case, and this is what says
  // so: a narrowed scene is still a scene, with the same containment and the same width.
  const scene = ec2Scene(policyOf(FULL), ACCOUNT, { regions: ['ap-northeast-2'] });
  assert.equal(scene.width, SCENE_W);
  const frames = new Map(scene.frames.map((f) => [f.id, f]));
  for (const slot of scene.slots) {
    const rail = EC2_RAILS[EC2_SLOTS[slot.resourceType].rail];
    const frame = frames.get(rail.frame);
    assert.ok(slot.x >= frame.x && slot.x + slot.w <= frame.x + frame.w,
              `${slot.resourceType} escaped ${frame.id} once the picture was narrowed`);
  }
});

// ---- VPC and subnet, once the querier records them ---------------------------------------------
//
// No EC2 ARN carries a VPC and Resource Explorer does not return one, so impact/inventory.py's
// _with_placement joins the membership on from the EC2 Describe calls and writes vpc_id / subnet_id
// onto the row. These pin what the dashboard may conclude from that - and, just as importantly,
// what it may not conclude from a row that has neither.

function placed(region, vpc, subnet, kind = 'instance') {
  return {
    arn: `arn:aws:ec2:${region}:${ACCOUNT}:${kind}/${vpc}-${subnet}-${kind}`,
    region, tags: {}, sensitive: false,
    ...(vpc ? { vpc_id: vpc } : {}),
    ...(subnet ? { subnet_id: subnet } : {}),
  };
}

const TWO_VPCS = [
  group('ec2:instance', 3, {
    resources: [placed('us-east-1', 'vpc-a', 'subnet-a1'),
                placed('us-east-1', 'vpc-a', 'subnet-a2'),
                placed('us-east-1', 'vpc-b', 'subnet-b1')],
  }),
  group('ec2:volume', 2, {
    resources: [placed('us-east-1', '', '', 'volume'), placed('us-east-1', '', '', 'volume')],
  }),
];

test('the VPC and subnet facets come from what the querier recorded', () => {
  const found = facets(policyOf(TWO_VPCS));
  assert.deepEqual(found.vpcs, [{ id: 'vpc-a', total: 2 }, { id: 'vpc-b', total: 1 }]);
  assert.deepEqual(found.subnets, [
    { id: 'subnet-a1', total: 1 }, { id: 'subnet-a2', total: 1 }, { id: 'subnet-b1', total: 1 },
  ]);
});

test('a type with no VPC is not counted as one the lookup failed on', () => {
  // A volume is zone-scoped and has no VPC by definition. Folding it into "rows with no VPC
  // recorded" would report a permission failure that did not happen, and would tell an approver the
  // placement lookup is broken when it is working exactly as specified.
  const found = facets(policyOf(TWO_VPCS));
  assert.equal(found.unplaced, 0, 'a volume was counted as an unplaced VPC resource');
  assert.equal(found.placeable, 3, 'placeable counts rows that could have a VPC, not every row');
});

test('a VPC-scoped row the querier could not place is counted and named', () => {
  // The optional permission was denied, or the assessment predates the field. Either way a VPC
  // filter cannot speak for the row, and the screen has to say how many there are - otherwise a
  // denied permission reads as an empty VPC.
  const unknown = [group('ec2:instance', 2, {
    resources: [placed('us-east-1', 'vpc-a', 'subnet-a1'), placed('us-east-1', '', '')],
  })];
  const found = facets(policyOf(unknown));
  assert.equal(found.unplaced, 1);
  assert.equal(found.placeable, 2);
});

test('a VPC filter narrows to the rows that SAY they are in it', () => {
  const scene = ec2Scene(policyOf(TWO_VPCS), ACCOUNT, { vpcs: ['vpc-a'] });
  assert.ok(scene.narrowed);
  assert.equal(scene.slots.find((s) => s.resourceType === 'ec2:instance').count, '2개');
  assert.ok(!scene.slots.some((s) => s.resourceType === 'ec2:volume'),
            'a volume, which has no VPC at all, survived a VPC filter');
});

test('a row with no recorded VPC never matches a chosen one', () => {
  // Absence is not evidence of belonging and not evidence of not belonging. The picture shows the
  // rows that say they are in the VPC; the count of rows that say nothing sits beside it.
  const unknown = [group('ec2:instance', 2, {
    resources: [placed('us-east-1', 'vpc-a', 'subnet-a1'), placed('us-east-1', '', '')],
  })];
  const scene = ec2Scene(policyOf(unknown), ACCOUNT, { vpcs: ['vpc-a'] });
  assert.equal(scene.measured, 1);
});

test('a subnet filter narrows further than its VPC', () => {
  const scene = ec2Scene(policyOf(TWO_VPCS), ACCOUNT, { vpcs: ['vpc-a'], subnets: ['subnet-a2'] });
  assert.equal(scene.measured, 1);
});

test('every VPC-scoped type has a slot in the picture', () => {
  // VPC_SCOPED mirrors PLACEMENT in impact/inventory.py. A type the querier places and this picture
  // has no seat for would be a resource with a known VPC and nowhere to be drawn.
  for (const type of VPC_SCOPED) {
    assert.ok(type in EC2_SLOTS, `${type} is placed by the querier and has no slot`);
  }
});

test('전체 still means unfiltered on the two new dimensions', () => {
  const whole = ec2Scene(policyOf(TWO_VPCS), ACCOUNT);
  for (const filter of [{ vpcs: [] }, { vpcs: [], subnets: [] },
                        { accounts: [], regions: [], vpcs: null, subnets: null }]) {
    assert.equal(filterActive(filter), false, `${JSON.stringify(filter)} counted as a filter`);
    assert.deepEqual(ec2Scene(policyOf(TWO_VPCS), ACCOUNT, filter), whole);
  }
});

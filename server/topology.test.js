// The engine, over every picture it draws.
//
// Each test here runs once per entry in TOPOLOGIES. That is the point: the invariants a reader has
// to trust are the same in all three - a plate that escapes its frame claims a containment while
// every sentence in the window denies it, whether the plate is an instance or a task - and writing
// them once per picture would be three copies drifting apart, with the third one written last and
// checked least.
//
// What is NOT here is anything specific to one picture: which frame a type lands in, what the
// Korean says, whether the EC2 scene still matches the golden fixture. Those live in
// topologyEc2.test.js, topologyLambda.test.js and topologyEcs.test.js.
//
//     node --test server/topology.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FOOT_BUDGET, FRAME_PAD, LABEL_BUDGET, SCENE_W, SLOT_W, TOPOLOGIES,
  facets, filterActive, scene, sceneSummary, textUnits, topologyPolicy, DIAGRAMMED_POLICIES,
} from './topology.js';

const ACCOUNT = '718100330247';
const ICON_DIR = fileURLToPath(new URL('../public/aws-icons', import.meta.url));
const KINDS = Object.keys(TOPOLOGIES);

/** The policy identifier that gets this picture. Read back out of the registry, so a rename cannot
 *  leave these tests quietly asserting about a policy that no longer draws anything. */
const identifierOf = (kind) => {
  const name = [...DIAGRAMMED_POLICIES.entries()].find(([, k]) => k === kind)?.[0];
  assert.ok(name, `no policy draws the ${kind} picture`);
  return `arn:aws:iam::aws:policy/${name}`;
};

/** One ImpactGroup of the given type, with `n` rows so the region fallback has something to read. */
function group(spec, resourceType, total, over = {}) {
  const service = resourceType.split(':')[0];
  return {
    service, resource_type: resourceType, actions: [], scope: 'listed', total,
    truncated: false, sensitive_hits: 0,
    resources: Array.from({ length: Math.min(total, 3) }, (_, i) => ({
      arn: `arn:aws:${service}:ap-northeast-2:${ACCOUNT}:thing/x${i}`,
      region: 'ap-northeast-2', tags: {}, sensitive: false,
      ...(spec.placeable.has(resourceType)
        ? { placement: 'vpc', vpc_id: 'vpc-0a0', subnet_ids: ['subnet-0b0'],
            cluster: `arn:aws:ecs:ap-northeast-2:${ACCOUNT}:cluster/c0` }
        : {}),
    })),
    ...over,
  };
}

const policyOf = (kind, affected) => ({
  source: 'aws_managed', identifier: identifierOf(kind), default_version_id: 'v1',
  is_baseline: false, restrictable: true, unreadable: null, actions_granted: ['*'], affected,
});

/** Every type the picture knows about, drawn at once - the busiest scene it can produce. */
const everySlot = (kind) => {
  const spec = TOPOLOGIES[kind];
  return Object.keys(spec.slots).map((t) => group(spec, t, 3));
};
const sceneOf = (kind, affected = null, filter = null) =>
  scene(policyOf(kind, affected ?? everySlot(kind)), ACCOUNT, filter);

// ---- geometry, which no source-text test can see ------------------------------------------------

test('every slot lies inside the frame it is drawn in', () => {
  // Defect it prevents: a plate escaping its box - a picture that lies about containment while
  // every sentence above it says the containment was never measured.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const s = sceneOf(kind);
    const frames = new Map(s.frames.map((f) => [f.id, f]));
    for (const slot of s.slots) {
      const rail = spec.rails[spec.slots[slot.resourceType].rail];
      const frame = frames.get(rail.frame);
      assert.ok(frame, `${kind}: ${slot.resourceType} names a rail whose frame is not drawn`);
      assert.ok(slot.x >= frame.x && slot.x + slot.w <= frame.x + frame.w,
                `${kind}: ${slot.resourceType} is outside ${frame.id} horizontally`);
      // A straddling slot is centred ON its frame's top border by design, and every OTHER border
      // it must stay clear of is checked below.
      if (rail.straddle) continue;
      assert.ok(slot.y >= frame.y && slot.y + slot.h <= frame.y + frame.h,
                `${kind}: ${slot.resourceType} is outside ${frame.id} vertically`);
    }
  }
});

test('a straddling slot crosses exactly one border and no other', () => {
  // Defect it prevents: the one that shipped - the gateway plate reaching 20px into the 서브넷
  // frame, across a network-rail plate, and clean through a 46px VPC. The plate ERASES what it
  // covers, so each of those was a picture with a border rubbed out.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const straddleRail = Object.entries(spec.rails).find(([, r]) => r.straddle)?.[0];
    if (!straddleRail) continue;
    const host = spec.rails[straddleRail].frame;
    const s = sceneOf(kind);
    const slot = s.slots.find((sl) => spec.slots[sl.resourceType]?.rail === straddleRail);
    assert.ok(slot, `${kind}: the straddling slot was not drawn`);
    const hostFrame = s.frames.find((f) => f.id === host);
    assert.equal(slot.y + slot.h / 2, hostFrame.y,
                 `${kind}: the straddler is not centred on ${host}'s border`);
    for (const other of s.frames) {
      if (other.id === host) continue;
      const inX = slot.x < other.x + other.w && slot.x + slot.w > other.x;
      const crossesTop = slot.y < other.y && slot.y + slot.h > other.y;
      const crossesBottom = slot.y < other.y + other.h && slot.y + slot.h > other.y + other.h;
      assert.ok(!(inX && (crossesTop || crossesBottom)),
                `${kind}: the straddler also crosses ${other.id}, whose border it is not on`);
    }
  }
});

test('no two slots overlap', () => {
  for (const kind of KINDS) {
    const s = sceneOf(kind);
    for (let i = 0; i < s.slots.length; i += 1) {
      for (let j = i + 1; j < s.slots.length; j += 1) {
        const a = s.slots[i];
        const b = s.slots[j];
        assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
                  `${kind}: ${a.resourceType} overlaps ${b.resourceType}`);
      }
    }
  }
});

test('every frame lies inside its parent', () => {
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const s = sceneOf(kind);
    const frames = new Map(s.frames.map((f) => [f.id, f]));
    for (const frame of s.frames) {
      const parent = spec.frames.find((f) => f.id === frame.id).parent;
      if (!parent) continue;
      const box = frames.get(parent);
      assert.ok(frame.x >= box.x && frame.x + frame.w <= box.x + box.w
                && frame.y >= box.y && frame.y + frame.h <= box.y + box.h,
                `${kind}: ${frame.id} is not inside ${parent}`);
    }
  }
});

test('the picture is always exactly SCENE_W wide and never grows with the inventory', () => {
  // Defect it prevents: a layout that reads the inventory. The unit is the TYPE, so the geometry
  // is constant in the number of resources - which is what makes the window usable on an account
  // with forty thousand of them.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const one = Object.keys(spec.slots).map((t) => group(spec, t, 1));
    const many = Object.keys(spec.slots).map((t) => group(spec, t, 4000));
    const a = sceneOf(kind, one);
    const b = sceneOf(kind, many);
    assert.equal(a.width, SCENE_W, `${kind}: the picture is not SCENE_W wide`);
    assert.equal(a.height, b.height, `${kind}: the height reads the inventory`);
    assert.deepEqual(a.frames.map((f) => [f.id, f.x, f.y, f.w, f.h]),
                     b.frames.map((f) => [f.id, f.x, f.y, f.w, f.h]),
                     `${kind}: a frame moved when the counts changed`);
  }
});

test('the scene is deterministic', () => {
  for (const kind of KINDS) {
    assert.deepEqual(sceneOf(kind), sceneOf(kind), `${kind}: two calls disagree`);
  }
});

// ---- text that cannot wrap ----------------------------------------------------------------------

test('every slot label fits its cell and runs to at most two lines', () => {
  for (const kind of KINDS) {
    for (const [type, slot] of Object.entries(TOPOLOGIES[kind].slots)) {
      if (slot.kind !== 'node') continue;
      assert.ok(slot.label.length <= 2, `${kind}: ${type} needs more than two label lines`);
      for (const line of slot.label) {
        assert.ok(textUnits(line) <= LABEL_BUDGET,
                  `${kind}: ${type} label "${line}" is ${textUnits(line).toFixed(1)} units, `
                  + `over ${LABEL_BUDGET}`);
      }
    }
  }
});

test('every frame label band fits the frame it is drawn on', () => {
  // Defect it prevents: the Amazon EBS note running out across the region border. The band is one
  // <text> that does not wrap and says nothing when it overflows.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    for (const s of [sceneOf(kind), sceneOf(kind, []), sceneOf(kind, everySlot(kind), null)]) {
      for (const f of s.frames) {
        const badge = spec.frames.find((x) => x.id === f.id).badge;
        const budget = (f.w - (badge ? 34 : 10) - FRAME_PAD)
          * (LABEL_BUDGET / (SLOT_W - 8)) * (11 / 12);
        const band = f.label + (f.count ? `  ${f.count}` : '')
          + (f.sensitive > 0 ? `  민감 ${f.sensitive}개` : '') + (f.note ? `  ${f.note}` : '');
        assert.ok(textUnits(band) <= budget,
                  `${kind}: ${f.id} band is ${textUnits(band).toFixed(1)} over `
                  + `${budget.toFixed(1)}: ${band}`);
      }
    }
  }
});

test('every foot line fits the picture it is drawn in', () => {
  const long = ['aardvark-network-insights-access-scope-analysis',
                'transit-gateway-route-table-announcement', 'verified-access-trust-provider'];
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const service = [...spec.services][0];
    const cases = [
      everySlot(kind),
      long.map((t) => group(spec, `${service}:${t}`, 1200)),
      [group(spec, `${service}:${'a'.repeat(200)}`, 1)],
      [...everySlot(kind),
       { service: 'elasticloadbalancing', resource_type: 'loadbalancer', total: 30,
         scope: 'listed', resources: [] }],
    ];
    for (const affected of cases) {
      for (const line of sceneOf(kind, affected).foot) {
        assert.ok(textUnits(line.text) <= FOOT_BUDGET,
                  `${kind}: foot line is ${textUnits(line.text).toFixed(1)} over `
                  + `${FOOT_BUDGET.toFixed(1)}: ${line.text}`);
      }
    }
  }
});

// ---- the icons ----------------------------------------------------------------------------------

test('public/aws-icons and the specs name exactly the same files', () => {
  // BOTH directions, which the extractor's header has always claimed and which did not exist until
  // now. Forward-only, an allowlist entry whose slot was deleted leaves its file behind forever -
  // and every floor assertion in this repository passes HARDER with an orphan present, so an
  // equality is the only shape that catches one. Over the UNION of all three specs, because a file
  // one picture stopped drawing may still be drawn by another.
  const drawn = new Set();
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    for (const f of spec.frames) if (f.badge) drawn.add(f.badge);
    for (const s of Object.values(spec.slots)) if (s.icon) drawn.add(s.icon);
    for (const r of Object.values(spec.rails)) if (r.link?.glyph) drawn.add(r.link.glyph);
  }
  const prefixed = readdirSync(ICON_DIR)
    .filter((f) => f.startsWith('Res-') || f.startsWith('Group-')).sort();
  assert.deepEqual(prefixed, [...drawn].sort(),
                   'public/aws-icons and the specs disagree - an orphan file, or an icon the '
                   + 'extractor allowlist does not name');
});

test('no spec names an Arch tile or falls back to a service icon', () => {
  // An Arch_*_64 is an 80x80 opaque coloured tile. One of those among 48px transparent line glyphs
  // makes a node read as more important than its neighbours for no reason a reader could name -
  // and an Amazon-EC2 tile inside the 보안 그룹 frame is a placement claim about key pairs.
  for (const kind of KINDS) {
    for (const [type, slot] of Object.entries(TOPOLOGIES[kind].slots)) {
      if (!slot.icon) continue;
      assert.ok(slot.icon.startsWith('Res-'),
                `${kind}: ${type} draws ${slot.icon}, which is not a Res_*_48 glyph`);
    }
    assert.ok(!JSON.stringify(sceneOf(kind)).includes('/Amazon-EC2.svg'),
              `${kind}: a type with no glyph of its own borrowed a service icon`);
  }
});

// ---- what the picture may and may not say --------------------------------------------------------

test('drawn plus unslotted plus omitted is what the panel itself counted', () => {
  // The accounting invariant. Every resource the panel counted is either drawn, or named in the
  // foot line, or named as an omitted service - and this says so arithmetically.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const service = [...spec.services][0];
    const affected = [
      ...everySlot(kind),
      group(spec, `${service}:quantum-widget`, 7),
      { service: 'elasticloadbalancing', resource_type: 'loadbalancer', actions: [], scope: '*',
        total: 3, truncated: false, sensitive_hits: 0, resources: [] },
    ];
    const s = sceneOf(kind, affected);
    const drawn = s.rows.reduce((n, r) => n + r.total, 0);
    const outside = s.omitted.reduce((n, o) => n + o.total, 0);
    assert.equal(drawn + outside, affected.reduce((n, g) => n + g.total, 0),
                 `${kind}: a resource vanished between the panel and the picture`);
  }
});

test('a type with no slot is listed, never nudged into a neighbouring frame', () => {
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const type = `${[...spec.services][0]}:quantum-widget`;
    const s = sceneOf(kind, [...everySlot(kind), group(spec, type, 7)]);
    assert.ok(s.unslotted.some((r) => r.resourceType === type), `${kind}: unlisted`);
    assert.ok(!s.slots.some((sl) => sl.resourceType === type),
              `${kind}: an unknown type was drawn into whatever frame was nearby`);
    assert.ok(s.foot.some((l) => l.text.includes(type)),
              `${kind}: an undrawable type left no trace on the picture`);
  }
});

test('a NO_SLOT entry has a reason and is not also a slot', () => {
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    for (const [type, reason] of Object.entries(spec.noSlot)) {
      assert.ok(!(type in spec.slots), `${kind}: ${type} is both a slot and a written omission`);
      assert.ok(typeof reason === 'string' && reason.length > 0,
                `${kind}: ${type} is in NO_SLOT with no reason, which is the omission it prevents`);
    }
  }
});

test('every placeable type has somewhere to be drawn', () => {
  // Defect it prevents: a resource whose VPC the querier went and looked up, with nowhere in the
  // picture for it to appear - a call paid for and an answer nobody can see.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    for (const type of spec.placeable) {
      assert.ok(type in spec.slots, `${kind}: ${type} is placeable and has no slot`);
    }
  }
});

test('every frame can actually be drawn by something', () => {
  // Defect it prevents: a frame nothing reaches - a box in the skeleton no input can fill, which
  // reads as a picture that is missing something rather than as one that never had it.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    for (const f of spec.frames) {
      const reachable = f.always || f.ghost || f.measure || f.type || f.rail
        || spec.frames.some((k) => k.parent === f.id);
      assert.ok(reachable, `${kind}: ${f.id} is drawn by nothing`);
      if (f.parent) {
        assert.ok(spec.frames.some((k) => k.id === f.parent),
                  `${kind}: ${f.id} names a parent that is not a frame`);
      }
    }
  }
});

test('only a border the assessment measured is solid', () => {
  // The rule the whole feature rests on. A measurement goes on a label band as a number; it never
  // becomes a solid border, because "N functions are in a VPC" is not "these functions are in THIS
  // VPC" and a solid box says the second.
  for (const kind of KINDS) {
    for (const f of TOPOLOGIES[kind].frames) {
      if (f.dashed) continue;
      assert.ok(f.always,
                `${kind}: ${f.id} is solid and is not one of the two frames the assessment `
                + 'establishes - the account and the region');
    }
  }
});

test('a row the lookup could not place never matches a chosen VPC, subnet or cluster', () => {
  // A control that appears to narrow and narrows nothing. An unrecorded placement is the ABSENCE
  // of a recording and is not evidence either way, so the honest answer to "show me what is in
  // vpc-0abc" is the rows that say they are.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const type = [...spec.placeable][0];
    if (!type) continue;
    const service = type.split(':')[0];
    const blank = {
      service, resource_type: type, actions: [], scope: 'listed', total: 2, truncated: false,
      sensitive_hits: 0,
      resources: [
        { arn: `arn:aws:${service}:ap-northeast-2:${ACCOUNT}:thing/known`,
          region: 'ap-northeast-2', tags: {}, sensitive: false, placement: 'vpc',
          vpc_id: 'vpc-known', subnet_ids: ['subnet-known'], cluster: 'arn:cluster/known' },
        // Nothing recorded: no vpc_id, no subnets, no cluster, no placement.
        { arn: `arn:aws:${service}:ap-northeast-2:${ACCOUNT}:thing/silent`,
          region: 'ap-northeast-2', tags: {}, sensitive: false },
      ],
    };
    for (const [dimension, value] of [['vpcs', 'vpc-known'], ['subnets', 'subnet-known'],
                                      ['clusters', 'arn:cluster/known']]) {
      const s = sceneOf(kind, [blank], { [dimension]: [value] });
      assert.equal(s.measured, 1,
                   `${kind}: a row with no recorded ${dimension} matched a chosen one`);
    }
  }
});

test('filterActive is false for every spelling of 전체', () => {
  for (const filter of [null, {}, { accounts: [] }, { accounts: null },
                        { accounts: [], regions: [], vpcs: [], subnets: [], clusters: [] }]) {
    assert.equal(filterActive(filter), false, `${JSON.stringify(filter)} narrowed something`);
  }
  assert.equal(filterActive({ clusters: ['c'] }), true, 'a cluster filter narrows nothing');
});

test('a filter never changes how sure a number is', () => {
  // Narrowing must not turn a floor into a total: the † and the 이상 travel with the count.
  for (const kind of KINDS) {
    const spec = TOPOLOGIES[kind];
    const type = Object.keys(spec.slots).find((t) => spec.slots[t].kind === 'node');
    const affected = [group(spec, type, 3, { truncated: true })];
    const whole = sceneOf(kind, affected);
    const narrowed = sceneOf(kind, affected, { regions: ['ap-northeast-2'] });
    assert.ok(whole.truncated && narrowed.truncated, `${kind}: the filter cleared the floor`);
    assert.match(narrowed.rows[0].countLabel, /이상†/, `${kind}: the narrowed count lost its mark`);
  }
});

test('a dimension the lookup can barely speak for is explained, not offered', () => {
  // A chip reading `vpc-0abc 12` for a VPC that probably holds 120 is worse than no chip. Below
  // COVERAGE_FLOOR the dimension moves to `unavailable` WITH the fraction.
  const kind = KINDS.find((k) => TOPOLOGIES[k].placeable.size > 0 && k !== 'ec2');
  const spec = TOPOLOGIES[kind];
  const type = [...spec.placeable][0];
  const service = type.split(':')[0];
  const rows = Array.from({ length: 10 }, (_, i) => ({
    arn: `arn:aws:${service}:ap-northeast-2:${ACCOUNT}:thing/x${i}`,
    region: 'ap-northeast-2', tags: {}, sensitive: false,
    // One placed, nine the lookup never answered for.
    ...(i === 0 ? { placement: 'vpc', vpc_id: 'vpc-0a0' } : { placement: 'over-budget' }),
  }));
  const f = facets(policyOf(kind, [{
    service, resource_type: type, actions: [], scope: 'listed', total: 10, truncated: false,
    sensitive_hits: 0, resources: rows,
  }]));
  assert.deepEqual(f.vpcs, [], 'a 10%-covered dimension was still offered as chips');
  const said = f.unavailable.find((u) => u.id === 'vpcs');
  assert.ok(said, 'the dimension vanished instead of saying why it is not there');
  assert.match(said.why, /1개뿐이라/, 'the reason does not carry the fraction');
  assert.match(said.why, /10개 중/, 'the reason does not say what it is a fraction of');
});

test('only the named policies get a picture, by ARN and by bare name', () => {
  // Defect it prevents: MyAmazonECS_FullAccessCopy - a different policy, possibly granting
  // something else entirely - drawing a picture of services it cannot touch.
  for (const [name, kind] of DIAGRAMMED_POLICIES) {
    assert.equal(topologyPolicy(name), kind, `${name} does not draw its own picture`);
    assert.equal(topologyPolicy(`arn:aws:iam::aws:policy/${name}`), kind,
                 `${name} does not draw its picture when named by ARN`);
    assert.equal(topologyPolicy(`My${name}Copy`), null, `My${name}Copy drew ${kind}`);
    assert.equal(topologyPolicy(`${name}2`), null, `${name}2 drew ${kind}`);
  }
  for (const junk of ['', null, undefined, 'AdministratorAccess', 'arn:aws:iam::aws:policy/x']) {
    assert.equal(topologyPolicy(junk), null, `${junk} drew a picture`);
  }
});

test('the slot shape is the frozen twelve, in every picture', () => {
  // Defect it prevents: the module quietly becoming a graph. A slot is a plate with a position, a
  // glyph and a count - anything more is an edge, and edges are what this feature does not draw.
  const KEYS = ['key', 'resourceType', 'x', 'y', 'w', 'h', 'icon', 'label', 'count', 'sensitive',
                'erase', 'title'];
  for (const kind of KINDS) {
    for (const slot of sceneOf(kind).slots) {
      assert.deepEqual(Object.keys(slot).sort(), [...KEYS].sort(), `${kind}: the slot shape moved`);
    }
  }
});

test('an empty picture says whether the service was even looked at', () => {
  for (const kind of KINDS) {
    const failed = scene(policyOf(kind, []), ACCOUNT, null, false);
    assert.ok(failed.empty && failed.enumerated === false);
    assert.match(sceneSummary(failed), /조회에 실패해서 그릴 것이 없다/,
                 `${kind}: the empty picture claimed the policy reaches nothing`);
    assert.match(sceneSummary(failed), /없다는 뜻이 아니다/, `${kind}: no denial of the reading`);
    const band = failed.frames.find((f) => f.note && /조회가 실패/.test(f.note));
    assert.ok(band, `${kind}: the region band did not say the lookup failed`);
  }
});

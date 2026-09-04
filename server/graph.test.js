// The relationship picture - what a reader cannot verify by looking at it.
//
// The claims here are stronger than the type picture's, because the picture is: it says WHICH
// instance is in WHICH subnet and WHAT is attached to it. So what these tests pin is that every
// one of those claims comes from a recorded field and never from this module's guess; that a node
// is drawn inside the container its row names and nowhere else; that an edge joins two things
// that are both drawn, or is counted as dangling; that the budget stops the picture rather than
// letting it draw a prefix; and that two runs on the same input draw the same picture.
//
//     node --test server/graph.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARDS_PER_SUBNET, EDGE_BUDGET, GRAPH_CAPTION, GRAPH_W, NODE_BUDGET, NODE_GAP, RELATIONS,
  graphSummary, idOf, relationScene, ruleSentence, ruleText, shortId, shortName,
} from './graph.js';

const A = '718100330247';
const R = 'us-east-1';
const ARN = 'arn:aws:iam::aws:policy/AmazonEC2FullAccess';
const arn = (t, id) => `arn:aws:ec2:${R}:${A}:${t}/${id}`;
const row = (t, id, over = {}) => ({ arn: arn(t, id), region: R, tags: {}, sensitive: false, ...over });
const g = (type, resources) => ({
  service: 'ec2', resource_type: type, actions: [], scope: '*', total: resources.length,
  truncated: false, sensitive_hits: resources.filter((r) => r.sensitive).length, resources,
});
const policyOf = (affected) => ({
  source: 'aws_managed', identifier: ARN, default_version_id: 'v1', is_baseline: false,
  restrictable: true, unreadable: null, actions_granted: ['ec2:*'], affected,
});
const sceneOf = (affected, filter = null, enumerated = true, options = {}) =>
  relationScene(policyOf(affected), A, filter, enumerated, options);
/** Every instance box open, for the tests about what is inside one. */
const OPEN = { expanded: ['i-0aaa111', 'i-0bbb222'] };

/** The operator's account in miniature: two VPCs, two zones, two instances with everything. */
function ACCOUNT() {
  return [
    g('ec2:vpc', [row('vpc', 'vpc-0a1', { vpc_id: 'vpc-0a1', tags: { Name: 'prod' } }),
                  row('vpc', 'vpc-0b2', { vpc_id: 'vpc-0b2' })]),
    g('ec2:subnet', [
      row('subnet', 'subnet-a1', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-a1', zone: 'us-east-1a',
                                   tags: { Name: 'prod-public-a' } }),
      row('subnet', 'subnet-a2', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-a2', zone: 'us-east-1a' }),
      row('subnet', 'subnet-b1', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-b1', zone: 'us-east-1b' }),
      row('subnet', 'subnet-c1', { vpc_id: 'vpc-0b2', subnet_id: 'subnet-c1', zone: 'us-east-1a' }),
    ]),
    g('ec2:instance', [
      row('instance', 'i-0aaa111', {
        vpc_id: 'vpc-0a1', subnet_id: 'subnet-a1', zone: 'us-east-1a', sensitive: true,
        tags: { Name: 'web-1' },
        links: { network_interface: ['eni-1', 'eni-2'], security_group: ['sg-web', 'sg-ssh'],
                 volume: ['vol-1'], image: ['ami-1'] },
      }),
      row('instance', 'i-0bbb222', {
        vpc_id: 'vpc-0a1', subnet_id: 'subnet-b1', zone: 'us-east-1b',
        links: { network_interface: ['eni-3'], security_group: ['sg-db'], volume: ['vol-2', 'vol-3'],
                 image: ['ami-1'] },
      }),
    ]),
    g('ec2:network-interface', [
      row('network-interface', 'eni-1', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-a1', zone: 'us-east-1a',
                                          links: { instance: ['i-0aaa111'], security_group: ['sg-web', 'sg-ssh'] } }),
      row('network-interface', 'eni-2', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-a1', zone: 'us-east-1a',
                                          links: { instance: ['i-0aaa111'], security_group: ['sg-web'] } }),
      row('network-interface', 'eni-3', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-b1', zone: 'us-east-1b',
                                          links: { instance: ['i-0bbb222'], security_group: ['sg-db'] } }),
      row('network-interface', 'eni-nat', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-a1', zone: 'us-east-1a' }),
      row('network-interface', 'eni-lone', { vpc_id: 'vpc-0b2', subnet_id: 'subnet-c1', zone: 'us-east-1a' }),
      row('network-interface', 'eni-6', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-a2', zone: 'us-east-1a',
                                          links: { security_group: ['sg-web'] } }),
    ]),
    g('ec2:security-group', ['sg-web', 'sg-ssh', 'sg-db', 'sg-default']
      .map((s) => row('security-group', s, { vpc_id: 'vpc-0a1' }))),
    g('ec2:volume', [
      row('volume', 'vol-1', { zone: 'us-east-1a', links: { instance: ['i-0aaa111'] } }),
      row('volume', 'vol-2', { zone: 'us-east-1b', links: { instance: ['i-0bbb222'] } }),
      row('volume', 'vol-3', { zone: 'us-east-1b', links: { instance: ['i-0bbb222'] } }),
      row('volume', 'vol-spare', { zone: 'us-east-1a' }),
    ]),
    g('ec2:route-table', [
      row('route-table', 'rtb-main', { vpc_id: 'vpc-0a1', links: { main: ['vpc-0a1'], internet_gateway: ['igw-1'] },
                                       routes: [{ destination: '10.0.0.0/16', target: 'local', state: 'active' },
                                                { destination: '0.0.0.0/0', target: 'igw-1', state: 'active' }] }),
      row('route-table', 'rtb-priv', { vpc_id: 'vpc-0a1', links: { subnet: ['subnet-b1'], nat_gateway: ['nat-1'] },
                                       routes: [{ destination: '0.0.0.0/0', target: 'nat-1', state: 'active' }] }),
      row('route-table', 'rtb-c', { vpc_id: 'vpc-0b2', links: { main: ['vpc-0b2'] },
                                    routes: [{ destination: '10.1.0.0/16', target: 'local', state: 'active' }] }),
    ]),
    g('ec2:network-acl', [
      row('network-acl', 'acl-default', { vpc_id: 'vpc-0a1',
                                          links: { subnet: ['subnet-a1', 'subnet-a2', 'subnet-b1'], default: ['vpc-0a1'] } }),
      row('network-acl', 'acl-c', { vpc_id: 'vpc-0b2', links: { subnet: ['subnet-c1'], default: ['vpc-0b2'] } }),
    ]),
    g('ec2:natgateway', [row('natgateway', 'nat-1', { vpc_id: 'vpc-0a1', subnet_id: 'subnet-a1',
                                                       links: { network_interface: ['eni-nat'] } })]),
    g('ec2:internet-gateway', [row('internet-gateway', 'igw-1', { vpc_id: 'vpc-0a1' }),
                               row('internet-gateway', 'igw-2', { vpc_id: 'vpc-0b2' })]),
    g('ec2:image', [row('image', 'ami-1')]),
    g('ec2:key-pair', [row('key-pair', 'key-1'), row('key-pair', 'key-2')]),
    { service: 'elasticloadbalancing', resource_type: 'loadbalancer', actions: [], scope: '*',
      total: 3, truncated: false, sensitive_hits: 0, resources: [] },
  ];
}

const inside = (inner, outer) => inner.x >= outer.x && inner.x + inner.w <= outer.x + outer.w
  && inner.y >= outer.y && inner.y + inner.h <= outer.y + outer.h;
const boxes = (scene) => new Map([
  ...scene.containers.map((c) => [c.id, c]),
  ...scene.nodes.map((n) => [n.id, n]),
]);

test('every policy gets a relationship picture, whatever its actions reach', () => {
  // The gate this used to assert - EC2 only - was wrong for THIS picture. A spec authorises the
  // 유형별 자리 picture because that one puts a type where AWS normally puts it; here every border
  // is a placement the querier read and every line is a link it read, so there is nothing to
  // authorise. A policy nobody wrote a spec for draws exactly what was measured about it.
  const bucket = (name) => ({ arn: `arn:aws:s3:::${name}`, region: 'us-east-1', tags: {} });
  const role = (name) => ({ arn: `arn:aws:iam::${A}:role/${name}`, region: 'global', tags: {} });
  const admin = {
    identifier: 'AdministratorAccess',
    affected: [
      { service: 's3', resource_type: 's3:bucket', actions: ['s3:DeleteBucket'], scope: '*',
        total: 2, truncated: false, sensitive_hits: 0, resources: [bucket('logs'), bucket('data')] },
      { service: 'iam', resource_type: 'iam:role', actions: ['iam:PassRole'], scope: '*',
        total: 1, truncated: false, sensitive_hits: 0, resources: [role('deployer')] },
    ],
  };
  const scene = relationScene(admin, A);
  assert.ok(scene, 'a policy outside the three specs gets no picture');
  assert.deepEqual(scene.rows.map((r) => r.id).sort(), ['data', 'deployer', 'logs']);
  // Named by their own type, because no spec names them and inventing a Korean word for four
  // hundred services would be a table nobody could check.
  assert.deepEqual([...new Set(scene.nodes.map((n) => n.typeLabel))].sort(), ['iam:role', 's3:bucket']);
  // And drawn with the service's own icon rather than a blank tile.
  assert.ok(scene.nodes.every((n) => n.icon?.startsWith('/aws-icons/')), 'a plate has no icon');
  // Nothing measured places a bucket, so both land in the region band and no VPC is drawn.
  assert.equal(scene.containers.filter((c) => c.kind === 'vpc').length, 0);
  assert.equal(scene.counts.placedRows, 0);
  // An empty policy still has nothing to draw, and says so rather than returning null.
  assert.equal(relationScene({ identifier: 'AdministratorAccess', affected: [] }, A).empty, true);
});

test('an EC2 type is named the same whichever policy the picture was opened for', () => {
  // The labels used to be read through the OPEN POLICY's spec, so AdministratorAccess printed
  // `ec2:instance` where AmazonEC2FullAccess printed 「인스턴스」 - one resource, two names, on two
  // screens an approver compares. They are keyed by type now.
  const rows = ACCOUNT();
  const named = (identifier) => {
    const scene = relationScene({ identifier, affected: rows }, A);
    return scene.nodes.find((n) => n.resourceType === 'ec2:instance');
  };
  const managed = named('arn:aws:iam::aws:policy/AmazonEC2FullAccess');
  const admin = named('AdministratorAccess');
  assert.equal(managed.typeLabel, '인스턴스');
  assert.equal(admin.typeLabel, managed.typeLabel);
  assert.equal(admin.icon, managed.icon);
});

test('every node is drawn inside the container its row names, and nowhere else', () => {
  // THE CLAIM THE PICTURE MAKES. An instance is in the subnet its subnet_id names, which is in
  // the zone its zone names, which is in the VPC its vpc_id names - and every one of those is a
  // field the querier recorded. A node in the wrong box is the picture lying about where a
  // resource is.
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  const rowsById = new Map(ACCOUNT().flatMap((grp) => grp.resources.map((r) => [idOf(r.arn), r])));
  for (const n of scene.nodes) {
    if (n.erase) continue;                                   // the straddling gateway, below
    const r = rowsById.get(n.id);
    if (r.subnet_id) {
      const sub = by.get(`subnet:${r.subnet_id}`);
      assert.ok(sub && inside(n, sub), `${n.id} is not inside its subnet ${r.subnet_id}`);
    } else if (r.vpc_id) {
      const vpc = by.get(`vpc:${r.vpc_id}`);
      assert.ok(vpc && inside(n, vpc), `${n.id} is not inside its VPC ${r.vpc_id}`);
      for (const c of scene.containers) {
        if (c.kind === 'subnet' || c.kind === 'az') {
          assert.ok(!inside(n, c), `${n.id} has no subnet and was drawn inside ${c.id}`);
        }
      }
    } else if (!n.id.startsWith('vol-') || !scene.edges.some((e) => e.kind === 'volume' && (e.from === n.id || e.to === n.id))) {
      for (const c of scene.containers) {
        if (c.kind === 'vpc' || c.kind === 'subnet' || c.kind === 'az') {
          assert.ok(!inside(n, c), `${n.id} names no VPC and was drawn inside ${c.id}`);
        }
      }
    }
    assert.ok(inside(n, by.get('region')), `${n.id} is outside the region`);
  }
});

test('a volume is drawn beside the instance it is attached to, and the unattached one is not', () => {
  // The one deliberate placement a row does not name: a volume has no subnet, but the edge from a
  // disk to the instance that would lose it is the edge an approver most wants, so an ATTACHED
  // volume sits in its instance's card. An unattached one stays in the region band with its zone.
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  const vol1 = by.get('vol-1');
  const i1 = by.get('i-0aaa111');
  assert.ok(inside(vol1, by.get('subnet:subnet-a1')), 'the attached volume is not beside its instance');
  assert.equal(vol1.x, i1.x, 'the volume is not in its instance\'s column');
  assert.ok(vol1.y > i1.y, 'the volume is not below its instance');
  const spare = by.get('vol-spare');
  assert.ok(!scene.containers.some((c) => c.kind === 'vpc' && inside(spare, c)),
            'an unattached volume was drawn inside a VPC');
  assert.equal(spare.sub, 'us-east-1a', 'the region-band volume does not say its zone');
  assert.equal(vol1.sub, '볼륨', 'a volume beside its instance repeats the zone the subnet already says');
});

test('every container is inside its parent, and every measured border is solid', () => {
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  for (const c of scene.containers) {
    if (c.kind === 'cloud') continue;
    const parent = c.kind === 'region' ? by.get('cloud')
      : c.kind === 'vpc' ? by.get('region')
        : c.kind === 'az' ? by.get(`vpc:${c.id.split(':')[1]}`)
          : scene.containers.find((z) => z.kind === 'az' && inside(c, z));
    assert.ok(parent && inside(c, parent), `${c.id} is not inside its parent`);
    assert.equal(c.dashed, false, `${c.id} was measured and is dashed`);
    assert.equal(c.measured, true);
  }
});

test('a subnet the assessment holds no row for is still drawn - dashed and saying so', () => {
  // Its instances are inside SOMETHING. Dropping the frame would put them in the VPC band, which
  // says "no subnet"; drawing it solid would say the subnet was reached. Dashed, 평가에 없음.
  const scene = sceneOf([
    g('ec2:instance', [row('instance', 'i-1', { vpc_id: 'vpc-x', subnet_id: 'subnet-ghost', zone: 'us-east-1a' })]),
  ]);
  const sub = scene.containers.find((c) => c.id === 'subnet:subnet-ghost');
  assert.ok(sub, 'the named subnet was not drawn');
  assert.equal(sub.dashed, true);
  assert.match(sub.note, /평가에 없음/);
  const vpc = scene.containers.find((c) => c.id === 'vpc:vpc-x');
  assert.equal(vpc.dashed, true, 'a VPC nobody reached was drawn as measured');
  assert.ok(inside(boxes(scene).get('i-1'), sub));
});

test('no two nodes overlap and no node crosses a container border it is not on', () => {
  for (const affected of [ACCOUNT(), BIG(120)]) {
    const scene = sceneOf(affected);
    const plates = [...scene.nodes, ...scene.overflow];
    for (let i = 0; i < plates.length; i += 1) {
      for (let j = i + 1; j < plates.length; j += 1) {
        const a = plates[i];
        const b = plates[j];
        // An interface inside its instance's box is the one overlap the picture means.
        if ((a.box && inside(b, a)) || (b.box && inside(a, b))) continue;
        assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
                  `${a.id ?? a.label} overlaps ${b.id ?? b.label}`);
      }
    }
    for (const n of scene.nodes) {
      for (const c of scene.containers) {
        const crossesX = n.x < c.x + c.w && n.x + n.w > c.x && (n.y < c.y && n.y + n.h > c.y
          || n.y < c.y + c.h && n.y + n.h > c.y + c.h);
        if (n.erase && c.kind === 'vpc' && n.y + n.h / 2 === c.y) continue;   // the straddler
        assert.ok(!crossesX, `${n.id} crosses the border of ${c.id}`);
      }
    }
  }
});

test('the internet gateway straddles its VPC border, and only that border', () => {
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  for (const [igw, vpc] of [['igw-1', 'vpc:vpc-0a1'], ['igw-2', 'vpc:vpc-0b2']]) {
    const n = by.get(igw);
    const c = by.get(vpc);
    assert.ok(n.erase, `${igw} does not erase the border under it`);
    assert.equal(n.y + n.h / 2, c.y, `${igw} is not centred on ${vpc}'s top border`);
    assert.ok(n.x >= c.x && n.x + n.w <= c.x + c.w, `${igw} is outside ${vpc} horizontally`);
  }
});

test('every edge joins two drawn things, or is counted as dangling - never invented, never lost', () => {
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  for (const e of scene.edges) {
    assert.ok(by.has(e.from) && by.has(e.to), `${e.from} -> ${e.to} names something not drawn`);
    assert.ok(e.kind in RELATIONS_KINDS, `${e.kind} is not a kind the legend explains`);
    // The line starts on the border of one box and ends on the border of the other.
    const a = by.get(e.from);
    const b = by.get(e.to);
    const on = (p, box) => (Math.abs(p.x - box.x) < 1 || Math.abs(p.x - (box.x + box.w)) < 1
      || Math.abs(p.y - box.y) < 1 || Math.abs(p.y - (box.y + box.h)) < 1)
      && p.x >= box.x - 1 && p.x <= box.x + box.w + 1 && p.y >= box.y - 1 && p.y <= box.y + box.h + 1;
    assert.ok(on({ x: e.x1, y: e.y1 }, a), `${e.from} -> ${e.to} does not start on ${e.from}'s border`);
    assert.ok(on({ x: e.x2, y: e.y2 }, b), `${e.from} -> ${e.to} does not end on ${e.to}'s border`);
  }
  // The dangling ones: a link to a row the assessment does not hold.
  const cut = sceneOf([
    g('ec2:instance', [row('instance', 'i-1', { vpc_id: 'vpc-x', subnet_id: 'subnet-x',
                                                links: { network_interface: ['eni-missing'], volume: ['vol-missing'] } })]),
  ]);
  assert.deepEqual(cut.counts.dangling, { network_interface: 1, volume: 1 });
  assert.equal(cut.edges.length, 0);
  assert.ok(cut.foot.some((l) => /그림 밖으로 나가는 연결 2개/.test(l.text)));
});
const RELATIONS_KINDS = { interface: 1, volume: 1, security: 1, association: 1, route: 1,
                          chain: 1, image: 1 };

test('the same fact seen from both ends is one line, or one border', () => {
  // The instance records its volumes and the volume records its instance: two Describes, one
  // edge. The instance records its interfaces and the interface records its instance: two
  // Describes, and the interface is drawn INSIDE the instance - no line at all.
  const scene = sceneOf(ACCOUNT());
  const between = (a, b) => scene.edges.filter((e) => [e.from, e.to].sort().join() === [a, b].sort().join());
  assert.equal(between('i-0aaa111', 'vol-1').length, 1);
  assert.equal(between('i-0aaa111', 'vol-1')[0].kind, 'volume');
  assert.equal(between('i-0aaa111', 'eni-1').length, 0, 'a line was drawn to an interface inside the box');
  // And the instance's own security groups are its interface's: one line per (instance, group),
  // from the box, whichever of the two records named it.
  assert.equal(between('i-0aaa111', 'sg-web').length, 1);
  assert.equal(between('i-0aaa111', 'sg-ssh').length, 1);
  assert.equal(between('eni-1', 'sg-web').length, 0, 'the group line went to the interface inside the box');
  assert.equal(between('eni-2', 'sg-web').length, 0);
});

test('an interface attached to an instance is drawn inside it, and the group line goes to the instance', () => {
  const scene = sceneOf(ACCOUNT(), null, true, OPEN);
  const by = boxes(scene);
  const web = by.get('i-0aaa111');
  assert.equal(web.box, true, 'the instance is not a box');
  assert.equal(web.holds, 2);
  assert.equal(web.open, true);
  for (const eni of ['eni-1', 'eni-2']) assert.ok(inside(by.get(eni), web), `${eni} is not inside its instance`);
  assert.ok(inside(web, by.get('subnet:subnet-a1')), 'the box is not inside its subnet');
  // Closed by default: the interfaces are folded into the box, the table lists them as inside
  // it, and the group lines are the same as with the box open - a reader clicks to see the
  // interfaces, not to get the lines.
  const closed = sceneOf(ACCOUNT());
  const shut = boxes(closed).get('i-0aaa111');
  assert.equal(shut.open, false);
  assert.equal(shut.holds, 2);
  assert.match(shut.note, /2개/);
  assert.ok(!closed.nodes.some((n) => n.id === 'eni-1'), 'a folded interface was drawn');
  assert.deepEqual(closed.rows.filter((r) => r.folded).map((r) => [r.id, r.where]).sort(),
                   [['eni-1', 'i-0aaa111 안'], ['eni-2', 'i-0aaa111 안'], ['eni-3', 'i-0bbb222 안']]);
  assert.equal(closed.counts.foldedRows, 3);
  const groupLines = (s) => s.edges.filter((e) => e.kind === 'security')
    .map((e) => [e.from, e.to].sort().join('>')).sort();
  assert.deepEqual(groupLines(closed), groupLines(scene), 'folding the interfaces changed the group lines');
  // The unattached interfaces keep their own plates and their own group lines.
  assert.equal(by.get('eni-6').box, false);
  assert.ok(scene.edges.some((e) => e.kind === 'security' && [e.from, e.to].includes('eni-6')));
  // The NAT gateway's interface is an attachment drawn as a line, not a box.
  assert.ok(scene.edges.some((e) => e.kind === 'interface' && [e.from, e.to].sort().join() === 'eni-nat,nat-1'));
  // An instance whose interfaces are not in the assessment is an empty box that says so.
  const bare = sceneOf([g('ec2:instance', [row('instance', 'i-1', { vpc_id: 'vpc-x', subnet_id: 'subnet-x' })])],
                       null, true, { expanded: ['i-1'] });
  const box = bare.nodes.find((n) => n.id === 'i-1');
  assert.equal(box.box, true);
  assert.equal(box.holds, 0);
  assert.equal(box.open, false, 'a box with nothing to show opened');
  assert.match(box.note, /평가에 없음/);
  // A box wraps its interfaces to the width its subnet offers: three zones, six interfaces.
  const wide = sceneOf([
    g('ec2:subnet', ['a', 'b', 'c'].map((z) => row('subnet', `subnet-${z}`,
      { vpc_id: 'vpc-w', subnet_id: `subnet-${z}`, zone: `us-east-1${z}` }))),
    g('ec2:instance', [row('instance', 'i-w', { vpc_id: 'vpc-w', subnet_id: 'subnet-a', zone: 'us-east-1a',
      links: { network_interface: Array.from({ length: 6 }, (_, i) => `eni-w${i}`) } })]),
    g('ec2:network-interface', Array.from({ length: 6 }, (_, i) => row('network-interface', `eni-w${i}`,
      { vpc_id: 'vpc-w', subnet_id: 'subnet-a', zone: 'us-east-1a', links: { instance: ['i-w'] } }))),
  ], null, true, { expanded: ['i-w'] });
  const wb = boxes(wide);
  assert.ok(inside(wb.get('i-w'), wb.get('subnet:subnet-a')), 'the box overflows its subnet');
  for (let i = 0; i < 6; i += 1) assert.ok(inside(wb.get(`eni-w${i}`), wb.get('i-w')), `eni-w${i} is outside the box`);
  assert.equal(wide.edges.length, 0, 'a line was drawn between a box and what it holds');
});

test('a subnet with no explicit route-table association gets the main table, dashed and derived', () => {
  // AWS marks the main table on the association entry with no SubnetId. The subnet's edge to it
  // is REAL - that is the table it routes by - but nothing recorded it, so it is drawn dashed and
  // the count says how many were derived.
  const scene = sceneOf(ACCOUNT());
  const implicit = scene.edges.filter((e) => e.implicit);
  assert.deepEqual(implicit.map((e) => [e.from, e.to]).sort(), [
    ['rtb-c', 'subnet:subnet-c1'], ['rtb-main', 'subnet:subnet-a1'], ['rtb-main', 'subnet:subnet-a2'],
  ]);
  assert.equal(scene.counts.implicitEdges, 3);
  // subnet-b1 HAS an explicit association, so the main table is NOT drawn to it.
  assert.ok(!scene.edges.some((e) => e.from === 'rtb-main' && e.to === 'subnet:subnet-b1'));
  assert.ok(scene.edges.some((e) => e.from === 'rtb-priv' && e.to === 'subnet:subnet-b1' && !e.implicit));
  assert.match(graphSummary(scene), /3개는 기본 라우팅 테이블에서 도출했다/);
});

test('every network ACL association reaches its subnet', () => {
  const scene = sceneOf(ACCOUNT());
  const acl = scene.edges.filter((e) => e.from === 'acl-default');
  assert.deepEqual(acl.map((e) => e.to).sort(),
                   ['subnet:subnet-a1', 'subnet:subnet-a2', 'subnet:subnet-b1']);
  assert.ok(acl.every((e) => e.kind === 'association' && !e.implicit));
});

test('a route to a gateway is an edge from the table to the gateway, and `local` never is', () => {
  const scene = sceneOf(ACCOUNT());
  assert.ok(scene.edges.some((e) => e.kind === 'route' && e.from === 'rtb-main' && e.to === 'igw-1'));
  assert.ok(scene.edges.some((e) => e.kind === 'route' && e.from === 'rtb-priv' && e.to === 'nat-1'));
  assert.ok(!scene.edges.some((e) => e.to === 'local'));
});

/** `n` instances in one subnet, each with an interface, a volume and a group. */
function BIG(n) {
  const groups = Array.from({ length: 5 }, (_, i) => `sg-${i}`);
  const instances = [];
  const enis = [];
  const vols = [];
  for (let i = 0; i < n; i += 1) {
    const id = `i-${String(i).padStart(6, '0')}`;
    instances.push(row('instance', id, {
      vpc_id: 'vpc-big', subnet_id: 'subnet-big', zone: 'us-east-1a',
      links: { network_interface: [`eni-${i}`], volume: [`vol-${i}`], security_group: [groups[i % 5]], image: ['ami-1'] },
    }));
    enis.push(row('network-interface', `eni-${i}`, { vpc_id: 'vpc-big', subnet_id: 'subnet-big', zone: 'us-east-1a',
                                                     links: { instance: [id], security_group: [groups[i % 5]] } }));
    vols.push(row('volume', `vol-${i}`, { zone: 'us-east-1a', links: { instance: [id] } }));
  }
  return [
    g('ec2:vpc', [row('vpc', 'vpc-big', { vpc_id: 'vpc-big' })]),
    g('ec2:subnet', [row('subnet', 'subnet-big', { vpc_id: 'vpc-big', subnet_id: 'subnet-big', zone: 'us-east-1a' })]),
    g('ec2:instance', instances), g('ec2:network-interface', enis), g('ec2:volume', vols),
    g('ec2:security-group', groups.map((s) => row('security-group', s, { vpc_id: 'vpc-big' }))),
    g('ec2:image', [row('image', 'ami-1')]),
  ];
}

test('past the node budget the picture stops and says how much it left out', () => {
  // Never a silent prefix. 300 instances x 3 nodes is 900 rows against NODE_BUDGET; the subnet
  // draws what fits, one plate says 외 N개, and the foot line says what to do about it.
  const scene = sceneOf(BIG(300));
  assert.ok(scene.nodes.length <= NODE_BUDGET, `${scene.nodes.length} nodes drawn over the budget`);
  assert.ok(scene.overflow.length >= 1, 'nothing says what was left out');
  const left = scene.counts.omittedNodes;
  assert.ok(left > 0);
  // Every row is a plate, an omitted plate, a border (the VPC and subnet rows), or an interface
  // folded into a closed box. Nothing else.
  assert.equal(scene.nodes.length + left + scene.counts.containerRows + scene.counts.foldedRows,
               scene.counts.totalRows,
               'drawn plus omitted plus containers plus folded is not every row - a resource vanished');
  assert.equal(scene.counts.containerRows, 2);
  assert.ok(scene.foot.some((l) => l.text.includes(`그리지 못한 자원 ${left.toLocaleString()}개`)));
  assert.ok(scene.foot.some((l) => l.text.includes('좁히면')), 'the foot line does not say how to see the rest');
  // Whole cards, never half an instance: an instance drawn without its interface would say it
  // has none. Folded into the box counts as with it.
  const drawn = new Set(scene.nodes.map((n) => n.id));
  const folded = new Set(scene.rows.filter((r) => r.folded).map((r) => r.id));
  for (const n of scene.nodes) {
    if (!n.id.startsWith('i-')) continue;
    const i = Number(n.id.slice(2));
    assert.ok((drawn.has(`eni-${i}`) || folded.has(`eni-${i}`)) && drawn.has(`vol-${i}`),
              `${n.id} was drawn without its card`);
  }
});

test('a subnet folds its instances past CARDS_PER_SUBNET into one plate', () => {
  const scene = sceneOf(BIG(CARDS_PER_SUBNET + 5));
  const plate = scene.overflow.find((o) => o.container === 'subnet:subnet-big');
  assert.ok(plate, 'the subnet did not fold');
  assert.equal(plate.count, 5 * 3);
  assert.equal(scene.nodes.filter((n) => n.id.startsWith('i-')).length, CARDS_PER_SUBNET);
});

test('past the edge budget the least load-bearing kinds go first, whole kinds at a time', () => {
  // With 60 instances everything fits; the budget is exercised by shrinking it in the ONE place
  // the module reads it. Rather than monkey-patch, assert the order the module declares and that a
  // scene under budget drops nothing.
  const scene = sceneOf(BIG(60));
  assert.ok(scene.edges.length <= EDGE_BUDGET);
  assert.deepEqual(scene.counts.droppedEdges, {});
  // Every relation the querier writes is one the picture explains.
  for (const rel of ['network_interface', 'instance', 'volume', 'security_group', 'subnet', 'main',
                     'default', 'route_table', 'internet_gateway', 'nat_gateway', 'image']) {
    assert.ok(rel in RELATIONS, `${rel} is recorded by the querier and this picture does not know it`);
  }
});

test('the scene is deterministic and exactly GRAPH_W wide', () => {
  for (const affected of [ACCOUNT(), BIG(40), []]) {
    const a = sceneOf(affected);
    const b = sceneOf(affected);
    assert.deepEqual(a, b);
    assert.equal(a.width, GRAPH_W);
  }
});

test('the filter narrows the picture by the same rule as the type picture', () => {
  const whole = sceneOf(ACCOUNT());
  const one = sceneOf(ACCOUNT(), { subnets: ['subnet-b1'] });
  assert.ok(one.narrowed);
  assert.ok(one.nodes.every((n) => ['i-0bbb222', 'eni-3', 'vol-2', 'vol-3'].includes(n.id) || !n.id.startsWith('i-')),
            'a resource outside the chosen subnet was drawn');
  assert.ok(one.nodes.some((n) => n.id === 'i-0bbb222'));
  assert.ok(!one.nodes.some((n) => n.id === 'i-0aaa111'));
  assert.ok(one.nodes.length < whole.nodes.length);
});

test('an older assessment with neither placement nor links is not informative', () => {
  // Its graph would be one region band of unconnected plates. The screen opens the type picture
  // for that document and offers this one second.
  const old = sceneOf([g('ec2:instance', [row('instance', 'i-1'), row('instance', 'i-2')])]);
  assert.equal(old.informative, false);
  assert.equal(sceneOf(ACCOUNT()).informative, true);
});

test('an empty picture says whether EC2 was even looked at', () => {
  const failed = sceneOf([], null, false);
  assert.ok(failed.empty && !failed.enumerated);
  assert.match(graphSummary(failed), /조회에 실패/);
  assert.match(failed.containers.find((c) => c.kind === 'region').note, /조회가 실패/);
  assert.match(graphSummary(sceneOf([])), /인벤토리에 없다/);
  assert.match(graphSummary(sceneOf(ACCOUNT(), { regions: ['eu-west-1'] })), /고른 조건에 맞는/);
});

test('names and ids are cut to the plate and never silently', () => {
  assert.equal(shortId('i-0123456789abcdef0'), 'i-0123456…def0');
  assert.equal(shortId('sg-web'), 'sg-web');
  assert.equal(shortName('a-very-long-name-indeed'), 'a-very-long-n…');
  assert.equal(shortName('web-1'), 'web-1');
  assert.equal(idOf('arn:aws:ec2:us-east-1:1:instance/i-0abc'), 'i-0abc');
  assert.equal(idOf('arn:aws:ec2:us-east-1::snapshot/snap-1'), 'snap-1');
  const scene = sceneOf(ACCOUNT());
  const web = scene.nodes.find((n) => n.id === 'i-0aaa111');
  assert.equal(web.label, 'web-1');
  assert.equal(web.sub, 'i-0aaa111');
  assert.match(web.title, /web-1/);
  assert.match(web.title, /arn:aws:ec2/);
  assert.equal(web.sensitive, true);
});

test('the caption is inside the viewBox and the table has a row per drawn node', () => {
  const scene = sceneOf(ACCOUNT());
  assert.ok(scene.foot.some((l) => l.text === GRAPH_CAPTION));
  assert.ok(scene.foot.every((l) => l.y < scene.height));
  assert.equal(scene.rows.filter((r) => !r.folded).length, scene.nodes.length);
  assert.equal(scene.rows.length, scene.nodes.length + scene.counts.foldedRows);
  const web = scene.rows.find((r) => r.id === 'i-0aaa111');
  assert.equal(web.where, 'subnet-a1');
  assert.ok(web.degree >= 3, 'the row does not count the instance\'s edges');
  assert.deepEqual(scene.omitted, [{ service: 'elasticloadbalancing', total: 3 }]);
});

test('a line leaves by the side facing its other end and never runs under the plate beside it', () => {
  // Defect it prevents: the centre-to-centre line from eni-3 to sg-db ran under i-0bbb222 and came
  // out the far side, so it read as a group line from the instance; the route from rtb-main to the
  // internet gateway surfaced from under acl-default two plates along.
  const scene = sceneOf(ACCOUNT(), null, true, OPEN);
  const by = boxes(scene);
  const through = (p, q, r) => {       // the engine's own rule restated: through the box shrunk by a pixel
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
  const runsUnder = (e, id) => {
    const r = by.get(id);
    for (let i = 1; i < e.points.length; i += 1) if (through(e.points[i - 1], e.points[i], r)) return true;
    return false;
  };
  const edge = (from, to) => scene.edges.find((e) => e.from === from && e.to === to)
    ?? assert.fail(`${from} -> ${to} is not drawn`);
  // The group line leaves the instance box outward and never runs under the interface it holds.
  assert.ok(!runsUnder(edge('i-0bbb222', 'sg-db'), 'eni-3'), 'the group line runs under the interface inside the box');
  // The table sits right under the gateway now, so its route is one vertical piece up to it - and
  // it runs under nothing on the way.
  const igw = edge('rtb-main', 'igw-1');
  assert.equal(igw.points.length, 2, 'the route to the gateway bends');
  for (const id of ['rtb-priv', 'acl-default']) assert.ok(!runsUnder(igw, id), `the route runs under ${id}`);
  // Two plates SIDE BY SIDE are no longer joined straight across: a line leaves through the middle
  // of a horizontal edge and nothing else, so it goes over the row or under it - out, along the
  // corridor, back in. Three pieces, four points.
  const beside = edge('nat-1', 'eni-nat');
  assert.equal(beside.points.length, 4);
  assert.equal(beside.points[0].x, beside.points[1].x, 'the line does not leave straight up or down');
  // Every line's ends are its first and last points.
  for (const e of scene.edges) {
    assert.ok(e.points.length >= 2, `${e.from} -> ${e.to} has ${e.points.length} points`);
    // Orthogonal: every piece is horizontal or vertical, none is empty, none doubles back.
    for (let i = 1; i < e.points.length; i += 1) {
      const u = e.points[i - 1]; const v = e.points[i];
      assert.ok((u.x === v.x) !== (u.y === v.y), `${e.from} -> ${e.to} has a piece that is not horizontal or vertical`);
    }
    for (let i = 2; i < e.points.length; i += 1) {
      const u = e.points[i - 2]; const v = e.points[i - 1]; const w = e.points[i];
      assert.ok(!((u.x === v.x && v.x === w.x) || (u.y === v.y && v.y === w.y)),
                `${e.from} -> ${e.to} has two pieces in a line - a bend that is not a bend`);
    }
    assert.deepEqual([e.x1, e.y1], [e.points[0].x, e.points[0].y]);
    const last = e.points[e.points.length - 1];
    assert.deepEqual([e.x2, e.y2], [last.x, last.y]);
    assert.ok(!runsUnder(e, e.from) && !runsUnder(e, e.to), `${e.from} -> ${e.to} runs back through its own end`);
    assert.match(e.title, /: .+ — .+/, `${e.from} -> ${e.to} has no hover text naming both ends`);
  }
  // The table row carries the type's Korean name beside the type.
  assert.ok(scene.rows.every((r) => typeof r.typeLabel === 'string' && r.typeLabel.length > 0));
});

test('a line touches a PLATE at one of two points: the middle of its top edge or of its bottom edge', () => {
  // The whole of the anchoring rule, over every line of two busy scenes. Before this a line met
  // its plate wherever the router found cheapest - anywhere along any of the four sides - and
  // twenty lines met twenty plates at twenty places, which is what made the picture a tangle.
  //
  // CONTAINERS are not in it, on purpose: a subnet frame is the border round what is inside it,
  // five hundred pixels wide, and half the lines that reach it start inside it. One point on such
  // a frame sends a line the width of it to enter where it already was.
  for (const affected of [ACCOUNT(), BIG(40)]) {
    const scene = sceneOf(affected, null, true, OPEN);
    const plates = new Map(scene.nodes.map((n) => [n.id, n]));
    let checked = 0;
    for (const e of scene.edges) {
      for (const [id, pt, at] of [[e.from, e.points[0], 0],
                                  [e.to, e.points[e.points.length - 1], e.points.length - 1]]) {
        const b = plates.get(id);
        if (!b) continue;                       // a container end, which keeps its spread
        checked += 1;
        // On a horizontal edge, top or bottom - never on a side.
        assert.ok(pt.y === b.y || pt.y === b.y + b.h,
                  `${e.from} -> ${e.to} touches ${id} at y ${pt.y}, not on its top or bottom edge`);
        // At its middle. Within half a grid cell: the anchor is snapped to the router's grid so
        // that the first piece of the line is exactly vertical.
        assert.ok(Math.abs(pt.x - (b.x + b.w / 2)) <= 2.5,
                  `${e.from} -> ${e.to} touches ${id} at x ${pt.x}, not the middle of ${b.x + b.w / 2}`);
        // And so the piece at that end is vertical: straight out, straight in.
        const next = e.points[at === 0 ? 1 : at - 1];
        assert.equal(pt.x, next.x, `${e.from} -> ${e.to} does not leave ${id} straight up or down`);
      }
    }
    assert.ok(checked > 10, `only ${checked} plate ends were checked`);
  }
});

test('the gap between two plates is wide enough to hold the corridors the lines run in', () => {
  // Every line runs over, under or between plates now, so the gap is a corridor and not a margin.
  // Four lanes at the router's five-pixel grid, after the two-pixel margin it keeps round a plate.
  assert.ok(NODE_GAP - 4 >= 4 * 5, `NODE_GAP ${NODE_GAP} leaves ${NODE_GAP - 4} for the lines`);
  const scene = sceneOf(ACCOUNT(), null, true, OPEN);
  // And the layout really uses it: two plates in one row stand NODE_GAP apart, not less.
  const row = scene.nodes.filter((n) => !n.box && n.y === scene.nodes.find((m) => m.id === 'rtb-main')?.y)
    .sort((a, b) => a.x - b.x);
  for (let i = 1; i < row.length; i += 1) {
    assert.ok(row[i].x - (row[i - 1].x + row[i - 1].w) >= NODE_GAP,
              `${row[i - 1].id} and ${row[i].id} are closer than NODE_GAP`);
  }
});

test('the picture is symmetric about the middle: the gateway on top, the tables in a column, the zones either side', () => {
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  const vpc = by.get('vpc:vpc-0a1');
  const mid = vpc.x + vpc.w / 2;
  const igw = by.get('igw-1');
  assert.ok(Math.abs(igw.x + igw.w / 2 - mid) < 1, 'the gateway is not centred on its VPC');
  for (const id of ['rtb-main', 'rtb-priv', 'acl-default']) {
    const n = by.get(id);
    assert.ok(Math.abs(n.x + n.w / 2 - mid) < 1, `${id} is not in the middle column`);
  }
  // The public table sits nearest the gateway, and its line up to it is one vertical piece.
  assert.ok(by.get('rtb-main').y < by.get('rtb-priv').y, 'the table with the internet route is not on top');
  const up = scene.edges.find((e) => e.kind === 'route' && e.to === 'igw-1');
  assert.equal(up.points.length, 2, 'the line to the gateway bends');
  assert.equal(up.points[0].x, up.points[1].x);
  assert.ok(Math.abs(up.points[0].x - mid) < 1, 'the line to the gateway is off the middle');
  // The zones mirror each other about the middle.
  const left = by.get('az:vpc-0a1:us-east-1a');
  const right = by.get('az:vpc-0a1:us-east-1b');
  assert.ok(left.x + left.w < mid && right.x > mid, 'the zones are not either side of the middle');
  assert.ok(Math.abs((mid - (left.x + left.w)) - (right.x - mid)) < 1, 'the zones are not mirrored');
  assert.ok(Math.abs(left.w - right.w) < 1);
  // The band is dealt left and right in turn, never all on one side.
  const band = ['sg-db', 'sg-default', 'sg-ssh', 'sg-web', 'dopt-1'].map((id) => by.get(id)).filter(Boolean);
  assert.ok(band.some((n) => n.x + n.w < mid) && band.some((n) => n.x > mid), 'the band is all on one side');
});

test('a subnet is public or private by its route table, and says which', () => {
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  assert.equal(by.get('subnet:subnet-a1').tint, 'public', 'the main table routes to igw-1');
  assert.equal(by.get('subnet:subnet-a2').tint, 'public');
  assert.equal(by.get('subnet:subnet-b1').tint, 'private', 'rtb-priv has no internet route');
  assert.equal(by.get('subnet:subnet-c1').tint, 'private', 'rtb-c is main and has no route');
  assert.match(by.get('subnet:subnet-a1').note, /퍼블릭/);
  assert.match(by.get('subnet:subnet-b1').note, /프라이빗/);
  // Narrowing to one subnet keeps its colour: the tables are read off every row, not the kept ones.
  const one = sceneOf(ACCOUNT(), { subnets: ['subnet-b1'] });
  assert.equal(boxes(one).get('subnet:subnet-b1').tint, 'private');
  // No table in the assessment, no colour - and the border is drawn all the same.
  const none = sceneOf([g('ec2:instance', [row('instance', 'i-1', { vpc_id: 'vpc-x', subnet_id: 'subnet-x' })])]);
  assert.equal(boxes(none).get('subnet:subnet-x').tint, null);
});

test('the DEFAULT route decides public, not merely having a route to a gateway', () => {
  // THE DEFECT THIS EXISTS FOR. The old rule was "the table has some internet-gateway route", and
  // a table whose only such route is a narrow prefix is a perfectly private table. Reading it as
  // public paints a private subnet as reachable from the internet - the one direction an approver
  // must never be misled in.
  const withRoutes = (routes) => sceneOf([
    g('ec2:subnet', [row('subnet', 'subnet-x', { vpc_id: 'vpc-x', subnet_id: 'subnet-x', zone: 'us-east-1a' })]),
    g('ec2:route-table', [row('route-table', 'rtb-x',
      { vpc_id: 'vpc-x', links: { main: ['vpc-x'], internet_gateway: ['igw-x'] }, routes })]),
  ]);
  const tintOf = (routes) => boxes(withRoutes(routes)).get('subnet:subnet-x').tint;
  // A gateway route for one prefix and no default route: private, though the link says igw.
  assert.equal(tintOf([{ destination: '203.0.113.0/24', target: 'igw-x', state: 'active' }]), 'private');
  // The default route to the gateway: public.
  assert.equal(tintOf([{ destination: '0.0.0.0/0', target: 'igw-x', state: 'active' }]), 'public');
  // IPv6's default route counts the same way.
  assert.equal(tintOf([{ destination: '::/0', target: 'igw-x', state: 'active' }]), 'public');
  // A blackhole default route names a target that no longer exists - not a path to anywhere.
  assert.equal(tintOf([{ destination: '0.0.0.0/0', target: 'igw-x', state: 'blackhole' }]), 'private');
  // An egress-only gateway is the IPv6 NAT gateway: out, never in. Never public.
  assert.equal(tintOf([{ destination: '::/0', target: 'eigw-x', state: 'active' }]), 'private');
  // A NAT default route is the textbook private subnet.
  assert.equal(tintOf([{ destination: '0.0.0.0/0', target: 'nat-x', state: 'active' }]), 'private');
  // Two families, one of them open, is open.
  assert.equal(tintOf([{ destination: '0.0.0.0/0', target: 'nat-x', state: 'active' },
                       { destination: '::/0', target: 'igw-x', state: 'active' }]), 'public');
  // No routes recorded at all: the older assessment, answered by the weaker rule and SAID to be.
  const old = boxes(sceneOf([
    g('ec2:subnet', [row('subnet', 'subnet-x', { vpc_id: 'vpc-x', subnet_id: 'subnet-x', zone: 'us-east-1a' })]),
    g('ec2:route-table', [row('route-table', 'rtb-x',
      { vpc_id: 'vpc-x', links: { main: ['vpc-x'], internet_gateway: ['igw-x'] } })]),
  ])).get('subnet:subnet-x');
  assert.equal(old.tint, 'public');
  assert.equal(old.tintBasis, 'links');
  assert.match(old.note, /경로 미기록/);
});

test('a subnet says which route table coloured it, and why', () => {
  // The association is drawn as a line, and a line can be lost in a crowded picture. The table's
  // id and the route that decided the colour are printed on the label band, where they cannot be.
  const scene = sceneOf(ACCOUNT());
  const by = boxes(scene);
  const pub = by.get('subnet:subnet-a1');
  assert.equal(pub.routeTable, 'rtb-main');
  assert.equal(pub.tintBasis, 'routes');
  assert.match(pub.note, /퍼블릭/);
  assert.match(pub.note, /rtb-main: 0\.0\.0\.0\/0 → igw-1/);
  const priv = by.get('subnet:subnet-b1');
  assert.equal(priv.routeTable, 'rtb-priv');
  assert.match(priv.note, /프라이빗/);
  assert.match(priv.note, /rtb-priv: 0\.0\.0\.0\/0 → nat-1/);
  // A table with no default route says so rather than printing nothing.
  assert.match(by.get('subnet:subnet-c1').note, /rtb-c: 기본 경로 없음/);
  // And the association line carries the same evidence in its hover text.
  const edge = scene.edges.find((e) => e.from === 'rtb-main' && e.to === 'subnet:subnet-a1');
  assert.ok(edge, 'the main table is not joined to the subnet it routes');
  assert.match(edge.title, /0\.0\.0\.0\/0 → igw-1/);
  // Narrowing to one subnet keeps the colour AND the reason: the tables are read off every row.
  const one = boxes(sceneOf(ACCOUNT(), { subnets: ['subnet-a1'] })).get('subnet:subnet-a1');
  assert.equal(one.tint, 'public');
  assert.match(one.note, /rtb-main/);
});

test('a subnet is coloured from its own row, even when the policy reaches no route table', () => {
  // THE DEFECT THE DEPLOYED ACCOUNT SHOWED. Instances, interfaces, groups, volumes, ACLs and an
  // internet gateway all enumerated; not one route table; every subnet uncoloured. Whether a
  // subnet is public is a fact about the SUBNET, so the querier records it on the subnet's row
  // and the picture reads it there first.
  const noTables = sceneOf([
    g('ec2:vpc', [row('vpc', 'vpc-x', { vpc_id: 'vpc-x' })]),
    g('ec2:subnet', [
      row('subnet', 'subnet-pub', { vpc_id: 'vpc-x', subnet_id: 'subnet-pub', zone: 'us-east-1a',
        route_table: 'rtb-main',
        default_routes: [{ destination: '0.0.0.0/0', target: 'igw-1', state: 'active' }] }),
      row('subnet', 'subnet-priv', { vpc_id: 'vpc-x', subnet_id: 'subnet-priv', zone: 'us-east-1a',
        route_table: 'rtb-priv',
        default_routes: [{ destination: '0.0.0.0/0', target: 'nat-1', state: 'active' }] }),
      row('subnet', 'subnet-none', { vpc_id: 'vpc-x', subnet_id: 'subnet-none', zone: 'us-east-1a',
        route_table: 'rtb-bare', default_routes: [] }),
    ]),
  ]);
  assert.ok(!noTables.nodes.some((n) => n.resourceType === 'ec2:route-table'),
            'the fixture is meant to hold no route table at all');
  const by = boxes(noTables);
  const pub = by.get('subnet:subnet-pub');
  assert.equal(pub.tint, 'public');
  assert.equal(pub.tintBasis, 'subnet');
  assert.equal(pub.routeTable, 'rtb-main');
  assert.match(pub.note, /rtb-main: 0\.0\.0\.0\/0 → igw-1/);
  assert.equal(by.get('subnet:subnet-priv').tint, 'private');
  // A table with no default route is private, and says that rather than printing nothing.
  assert.equal(by.get('subnet:subnet-none').tint, 'private');
  assert.match(by.get('subnet:subnet-none').note, /rtb-bare: 기본 경로 없음/);
  // The same rules as the table's own row: blackhole and egress-only are not public.
  const tintFor = (routes) => boxes(sceneOf([
    g('ec2:subnet', [row('subnet', 'subnet-1', { vpc_id: 'vpc-x', subnet_id: 'subnet-1',
      zone: 'us-east-1a', route_table: 'rtb-1', default_routes: routes })]),
  ])).get('subnet:subnet-1').tint;
  assert.equal(tintFor([{ destination: '0.0.0.0/0', target: 'igw-1', state: 'blackhole' }]), 'private');
  assert.equal(tintFor([{ destination: '::/0', target: 'eigw-1', state: 'active' }]), 'private');
  assert.equal(tintFor([{ destination: '::/0', target: 'igw-1', state: 'active' }]), 'public');
  // The subnet's own row WINS over a route-table row that disagrees: it is the newer, and the
  // measured, answer - the table row cannot know about an association it does not carry.
  const both = boxes(sceneOf([
    g('ec2:subnet', [row('subnet', 'subnet-1', { vpc_id: 'vpc-x', subnet_id: 'subnet-1',
      zone: 'us-east-1a', route_table: 'rtb-real',
      default_routes: [{ destination: '0.0.0.0/0', target: 'igw-1', state: 'active' }] })]),
    g('ec2:route-table', [row('route-table', 'rtb-other', { vpc_id: 'vpc-x',
      links: { main: ['vpc-x'] },
      routes: [{ destination: '0.0.0.0/0', target: 'nat-9', state: 'active' }] })]),
  ])).get('subnet:subnet-1');
  assert.equal(both.tint, 'public');
  assert.equal(both.routeTable, 'rtb-real');
});


test('unticking a type takes its plates and its lines out, and says how many', () => {
  const whole = sceneOf(ACCOUNT());
  const hidden = sceneOf(ACCOUNT(), { hiddenTypes: ['ec2:route-table', 'ec2:network-acl'] });
  const typesIn = (scene) => new Set(scene.nodes.map((n) => n.resourceType));
  assert.ok(typesIn(whole).has('ec2:route-table'), 'the fixture has no route table to hide');
  assert.ok(!typesIn(hidden).has('ec2:route-table'), 'a switched-off type is still drawn');
  assert.ok(!typesIn(hidden).has('ec2:network-acl'));
  // The lines to it go with it. A line whose other end is not on the picture is not a line.
  const touches = (scene, type) => scene.edges.some((e) => [e.from, e.to]
    .some((id) => scene.rows.find((r) => r.id === id)?.resourceType === type));
  assert.ok(touches(whole, 'ec2:route-table'), 'the fixture draws no route-table line');
  assert.ok(!touches(hidden, 'ec2:route-table'), 'a line survives the plate it was drawn to');
  // Counted and said, so a smaller picture is never read as a smaller policy.
  assert.equal(hidden.counts.hiddenRows, whole.rows.filter(
    (r) => r.resourceType === 'ec2:route-table' || r.resourceType === 'ec2:network-acl').length);
  assert.ok(hidden.foot.some((l) => l.text.includes('체크를 풀어 감춘 자원')));
  assert.equal(hidden.narrowed, true, 'hiding a type does not mark the picture narrowed');
  // The accounting still balances over what IS drawn.
  const c = hidden.counts;
  assert.equal(c.nodes + c.omittedNodes + c.containerRows + c.foldedRows, c.totalRows);
});

test('the checkbox list holds every type, hidden ones included, and marks the borders', () => {
  // A type switched off has to stay in the list or nobody could switch it back on - which is why
  // the picker reads the UNFILTERED scene. Pinned here so the scene keeps answering it.
  const hidden = sceneOf(ACCOUNT(), { hiddenTypes: ['ec2:route-table'] });
  assert.ok(hidden.types.some((t) => t.resourceType === 'ec2:route-table'),
            'a hidden type left the list and can never come back');
  const vpc = hidden.types.find((t) => t.resourceType === 'ec2:vpc');
  const subnet = hidden.types.find((t) => t.resourceType === 'ec2:subnet');
  assert.equal(vpc?.container, true, 'the VPC is offered as a plate');
  assert.equal(subnet?.container, true, 'the subnet is offered as a plate');
  assert.equal(hidden.types.find((t) => t.resourceType === 'ec2:instance')?.container, false);
  // Named the way the plates are named, off the same table.
  assert.equal(hidden.types.find((t) => t.resourceType === 'ec2:instance')?.label, '인스턴스');
});

test('a public subnet is drawn nearer the gateway than a private one in the same zone', () => {
  // The internet gateway is on the VPC's top border, so ordering the subnets public-first puts the
  // public ones at the top of the left column AND the top of the right - the arrangement AWS's own
  // reference diagrams use, and the one a reader traces a path down.
  //
  // The ids are chosen so the ALPHABET disagrees: `subnet-a-private` sorts before `subnet-z-public`
  // and the old order drew it first. A fixture whose two orders agree proves nothing.
  const both = [
    g('ec2:vpc', [row('vpc', 'vpc-1', { vpc_id: 'vpc-1' })]),
    g('ec2:subnet', [
      row('subnet', 'subnet-a-private', { vpc_id: 'vpc-1', subnet_id: 'subnet-a-private',
                                          zone: 'us-east-1a' }),
      row('subnet', 'subnet-z-public', { vpc_id: 'vpc-1', subnet_id: 'subnet-z-public',
                                         zone: 'us-east-1a' }),
    ]),
    g('ec2:route-table', [
      row('route-table', 'rtb-pub', { vpc_id: 'vpc-1', links: { subnet: ['subnet-z-public'] },
                                      routes: [{ destination: '0.0.0.0/0', target: 'igw-1', state: 'active' }] }),
      row('route-table', 'rtb-priv', { vpc_id: 'vpc-1', links: { subnet: ['subnet-a-private'] },
                                       routes: [{ destination: '0.0.0.0/0', target: 'nat-1', state: 'active' }] }),
    ]),
    g('ec2:internet-gateway', [row('internet-gateway', 'igw-1', { vpc_id: 'vpc-1' })]),
  ];
  const scene = sceneOf(both);
  const boxOf = (id) => scene.containers.find((c) => c.id === `subnet:${id}`);
  const pub = boxOf('subnet-z-public');
  const priv = boxOf('subnet-a-private');
  assert.equal(pub.tint, 'public', 'the fixture\'s public subnet is not coloured public');
  assert.equal(priv.tint, 'private', 'the fixture\'s private subnet is not coloured private');
  // Same zone box, so this is an ordering and not a placement.
  const az = scene.containers.find((c) => c.kind === 'az');
  assert.ok(inside(pub, az) && inside(priv, az), 'the two are not in one zone');
  assert.ok(pub.y < priv.y, 'the private subnet is drawn above the public one');
  // And above the gateway's own side: the gateway straddles the VPC's top border, so "first" is
  // "nearest it" rather than an arbitrary end of the column.
  const igw = scene.nodes.find((n) => n.resourceType === 'ec2:internet-gateway');
  assert.ok(igw.y < pub.y && pub.y < priv.y, 'the column does not run away from the gateway');
});

test('a subnet nothing can colour sits between the two', () => {
  // Three ranks, not two. A subnet whose table this assessment does not hold is neither, and
  // sorting it with the private ones would put an unanswered question under an answered one.
  const three = [
    g('ec2:vpc', [row('vpc', 'vpc-1', { vpc_id: 'vpc-1' })]),
    g('ec2:subnet', [
      row('subnet', 'subnet-a-private', { vpc_id: 'vpc-1', subnet_id: 'subnet-a-private', zone: 'z' }),
      row('subnet', 'subnet-b-unknown', { vpc_id: 'vpc-1', subnet_id: 'subnet-b-unknown', zone: 'z' }),
      row('subnet', 'subnet-c-public', { vpc_id: 'vpc-1', subnet_id: 'subnet-c-public', zone: 'z' }),
    ]),
    g('ec2:route-table', [
      row('route-table', 'rtb-pub', { vpc_id: 'vpc-1', links: { subnet: ['subnet-c-public'] },
                                      routes: [{ destination: '0.0.0.0/0', target: 'igw-1', state: 'active' }] }),
      row('route-table', 'rtb-priv', { vpc_id: 'vpc-1', links: { subnet: ['subnet-a-private'] },
                                       routes: [{ destination: '0.0.0.0/0', target: 'nat-1', state: 'active' }] }),
    ]),
  ];
  const scene = sceneOf(three);
  const y = (id) => scene.containers.find((c) => c.id === `subnet:${id}`).y;
  const tint = (id) => scene.containers.find((c) => c.id === `subnet:${id}`).tint;
  assert.equal(tint('subnet-b-unknown'), null, 'the fixture coloured the uncoloured one');
  assert.ok(y('subnet-c-public') < y('subnet-b-unknown'), 'the public one is not first');
  assert.ok(y('subnet-b-unknown') < y('subnet-a-private'), 'the uncoloured one is not in the middle');
});


test('the public band runs across every zone, above the private band', () => {
  // The arrangement asked for: public subnets top-left AND top-right, private bottom-left and
  // bottom-right. Each zone is one box and cannot be in two bands, so the bands are made by giving
  // each rank a common top ACROSS the zones - which is the thing to pin, because ordering each
  // zone's own column separately produces the same order and the wrong picture.
  const wide = [
    g('ec2:vpc', [row('vpc', 'vpc-1', { vpc_id: 'vpc-1' })]),
    g('ec2:subnet', [
      // Zone a: one public, one private. Zone b: one public, one private - but zone a's public
      // subnet holds two instances and is therefore TALLER, which is what used to push zone b's
      // private subnet up beside zone a's public one.
      row('subnet', 'sn-a-pub', { vpc_id: 'vpc-1', subnet_id: 'sn-a-pub', zone: 'az-a' }),
      row('subnet', 'sn-a-priv', { vpc_id: 'vpc-1', subnet_id: 'sn-a-priv', zone: 'az-a' }),
      row('subnet', 'sn-b-pub', { vpc_id: 'vpc-1', subnet_id: 'sn-b-pub', zone: 'az-b' }),
      row('subnet', 'sn-b-priv', { vpc_id: 'vpc-1', subnet_id: 'sn-b-priv', zone: 'az-b' }),
    ]),
    g('ec2:instance', ['i-1', 'i-2', 'i-3', 'i-4'].map((id) => row('instance', id,
      { vpc_id: 'vpc-1', subnet_id: 'sn-a-pub', zone: 'az-a' }))),
    g('ec2:route-table', [
      row('route-table', 'rtb-pub', { vpc_id: 'vpc-1', links: { subnet: ['sn-a-pub', 'sn-b-pub'] },
                                      routes: [{ destination: '0.0.0.0/0', target: 'igw-1', state: 'active' }] }),
      row('route-table', 'rtb-priv', { vpc_id: 'vpc-1', links: { subnet: ['sn-a-priv', 'sn-b-priv'] },
                                       routes: [{ destination: '0.0.0.0/0', target: 'nat-1', state: 'active' }] }),
    ]),
  ];
  const scene = sceneOf(wide);
  const box = (id) => scene.containers.find((c) => c.id === `subnet:${id}`);
  const pubs = ['sn-a-pub', 'sn-b-pub'].map(box);
  const privs = ['sn-a-priv', 'sn-b-priv'].map(box);
  for (const b of [...pubs, ...privs]) assert.ok(b, 'a subnet of the fixture was not drawn');
  assert.deepEqual(pubs.map((b) => b.tint), ['public', 'public']);
  assert.deepEqual(privs.map((b) => b.tint), ['private', 'private']);
  // One band each: both public subnets start at the same y, and so do both private ones.
  assert.equal(pubs[0].y, pubs[1].y, 'the public subnets are not in one band');
  assert.equal(privs[0].y, privs[1].y, 'the private subnets are not in one band');
  // And the private band is BELOW the tallest public subnet, not merely below its own zone's.
  const publicBottom = Math.max(...pubs.map((b) => b.y + b.h));
  for (const b of privs) assert.ok(b.y >= publicBottom, `${b.id} rides up beside a public subnet`);
  // Left and right, so the bands really are 상단 좌우 / 하단 좌우.
  assert.notEqual(pubs[0].x, pubs[1].x, 'the two zones are stacked rather than side by side');
  // The zone frames still hold their own subnets, which is the containment this could not trade.
  for (const zone of scene.containers.filter((c) => c.kind === 'az')) {
    const held = [...pubs, ...privs].filter((b) => inside(b, zone));
    assert.equal(held.length, 2, `${zone.id} does not hold exactly its own two subnets`);
    assert.equal(new Set(held.map((b) => b.id.split('-')[1])).size, 1, 'a zone holds another zone\'s subnet');
  }
});


// ---- what a security group allows, and the chain between two groups ----------------------------
//
// The defect these are about: the picture drew a security group as a box with nothing in it and a
// rule as a plate attached to nothing, because the querier read neither the values nor the group a
// rule belongs to. A reader could see THAT a group was reached and never what it allows.

const SG_VPC = { vpc_id: 'vpc-0a1' };
const WEB_RULES = [
  { direction: 'ingress', protocol: 'tcp', from_port: 443, to_port: 443,
    target_kind: 'cidr', target: '0.0.0.0/0' },
  { direction: 'egress', protocol: '-1', from_port: null, to_port: null,
    target_kind: 'security_group', target: 'sg-db' },
];
const SG_ACCOUNT = () => [
  g('ec2:vpc', [row('vpc', 'vpc-0a1', SG_VPC)]),
  g('ec2:security-group', [
    row('security-group', 'sg-web', { ...SG_VPC, rules: WEB_RULES,
                                      links: { allows_to: ['sg-db'] } }),
    row('security-group', 'sg-db', { ...SG_VPC,
                                     rules: [{ direction: 'ingress', protocol: 'tcp',
                                               from_port: 3306, to_port: 3306,
                                               target_kind: 'security_group', target: 'sg-web' }],
                                     links: { allows_from: ['sg-web'] } }),
  ]),
  g('ec2:security-group-rule', [
    row('security-group-rule', 'sgr-0in', { ...SG_VPC, rule: WEB_RULES[0],
                                            links: { security_group: ['sg-web'] } }),
  ]),
];

test('a rule gets no plate; the group says how many it has and the foot says where they are', () => {
  const scene = sceneOf(SG_ACCOUNT());
  // The rule is NOT on the canvas. Not as a plate, not folded into one, not as a line to the
  // group it belongs to - a rule is what a group allows, and the table the group opens says it.
  assert.equal(scene.nodes.find((n) => n.id === 'sgr-0in'), undefined);
  assert.equal(scene.edges.filter((e) => [e.from, e.to].includes('sgr-0in')).length, 0);
  assert.equal(scene.rows.find((r) => r.id === 'sgr-0in'), undefined);
  // Counted, and the picture says so rather than dropping it in silence.
  assert.equal(scene.counts.ruleRows, 1);
  assert.ok(scene.foot.some((f) => /보안 그룹 규칙 1개는 판으로 그리지 않는다/.test(f.text)),
            'the foot line does not say where the rules went');
  // Nor is it offered in the type picker: there is no plate to switch off.
  assert.equal(scene.types.find((t) => t.resourceType === 'ec2:security-group-rule'), undefined);
  // The GROUP's plate is what carries the rules now: how many, and a click opens the table.
  const web = scene.nodes.find((n) => n.id === 'sg-web');
  assert.equal(web.label, 'sg-web');
  assert.equal(web.sub, `규칙 ${WEB_RULES.length}개`);
  assert.equal(web.ruleCount, WEB_RULES.length);
  // Every other plate has none, so nothing else opens a table.
  assert.equal(scene.nodes.filter((n) => n.ruleCount > 0).length, 2);
});

test('the chain between two groups is one line per direction, pointing the way traffic goes', () => {
  const scene = sceneOf(SG_ACCOUNT());
  const chain = scene.edges.filter((e) => e.kind === 'chain');
  assert.equal(chain.length, 1, 'the two ends of one chain drew two lines');
  // sg-web's egress names sg-db, and sg-db's ingress names sg-web: the SAME permission from both
  // sides, and both say traffic goes web -> db. An undirected line would say neither.
  assert.equal(chain[0].from, 'sg-web');
  assert.equal(chain[0].to, 'sg-db');
  // The group's own plate keeps its name; the rules are in the panel and the hover title.
  const web = scene.nodes.find((n) => n.id === 'sg-web');
  assert.match(web.title, /아웃바운드 모든 프로토콜 → sg-db \(보안 그룹\)/);
});

test('a rule reading is null where there is no rule, and never a protocol named -1', () => {
  assert.equal(ruleText(null), null);
  // One cell of the table: the protocol and its ports, and nothing about direction or target -
  // those are columns of their own, and printing them here would print each twice.
  assert.equal(ruleText({}), '모든 프로토콜');
  assert.equal(ruleText({ protocol: 'tcp', from_port: 80, to_port: 443 }), 'tcp 80-443');
  assert.equal(ruleText({ protocol: 'tcp' }), 'tcp 전체 포트');
  assert.equal(ruleText({ direction: 'egress', target: 'sg-0db' }), '모든 프로토콜');
  assert.equal(ruleSentence({ direction: 'ingress', protocol: 'tcp', from_port: 22, to_port: 22,
                              target_kind: 'cidr', target: '10.0.0.0/8' }),
               '인바운드 tcp 22 ← 10.0.0.0/8');
  assert.equal(ruleSentence({ direction: 'egress', protocol: '-1',
                              target_kind: 'security_group', target: 'sg-0db' }),
               '아웃바운드 모든 프로토콜 → sg-0db (보안 그룹)');
});

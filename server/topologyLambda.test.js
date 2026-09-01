// The 람다 picture - what is in it, and more importantly what is deliberately not.
//
// The engine invariants are in topology.test.js and run over this spec too. What is here is the
// claims this picture makes that the others do not, and every one of them is about the same thing:
// a Lambda function is USUALLY NOT IN A VPC, and a picture that suggests otherwise is worse than
// no picture.
//
//     node --test server/topologyLambda.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { TOPOLOGIES, facets, scene, sceneSummary } from './topology.js';
import SPEC from './topologyLambda.js';

const ACCOUNT = '718100330247';
const ARN = 'arn:aws:iam::aws:policy/AWSLambda_FullAccess';

/** `n` functions, of which `inVpc` were measured into one and the rest AWS answered 'none' for. */
function functions(n, inVpc, over = {}) {
  return {
    service: 'lambda', resource_type: 'lambda:function', actions: [], scope: '*', total: n,
    truncated: false, sensitive_hits: 0,
    resources: Array.from({ length: n }, (_, i) => ({
      arn: `arn:aws:lambda:ap-northeast-2:${ACCOUNT}:function:f${i}`,
      region: 'ap-northeast-2', tags: {}, sensitive: false,
      ...(i < inVpc
        ? { placement: 'vpc', vpc_id: 'vpc-0a1', subnet_ids: ['subnet-1', 'subnet-2'] }
        : { placement: 'none' }),
    })),
    ...over,
  };
}
const policyOf = (affected) => ({
  source: 'aws_managed', identifier: ARN, default_version_id: 'v1', is_baseline: false,
  restrictable: true, unreadable: null, actions_granted: ['lambda:*'], affected,
});
const sceneOf = (affected, filter = null) => scene(policyOf(affected), ACCOUNT, filter);

test('AWSLambda_FullAccess draws the 람다 picture and nothing else does', () => {
  assert.equal(TOPOLOGIES.lambda, SPEC);
  assert.equal(scene(policyOf([]), ACCOUNT).kind, 'lambda');
});

test('the 함수 plate is in the regional rail and never inside the VPC frame', () => {
  // THE SINGLE BIGGEST LIE THIS PICTURE COULD TELL. A function not attached to a VPC is the
  // ordinary case and a fact about Lambda, not a gap in the lookup - so drawing the plate inside
  // the box would tell an approver every function this policy reaches is in a VPC.
  assert.equal(SPEC.slots['lambda:function'].rail, 'regional');
  assert.equal(SPEC.rails.regional.frame, 'region');
  const s = sceneOf([functions(12, 4)]);
  const plate = s.slots.find((sl) => sl.resourceType === 'lambda:function');
  const vpc = s.frames.find((f) => f.id === 'vpc');
  assert.ok(plate && vpc, 'the picture is missing the plate or the VPC frame');
  const inside = plate.x >= vpc.x && plate.x + plate.w <= vpc.x + vpc.w
    && plate.y >= vpc.y && plate.y + plate.h <= vpc.y + vpc.h;
  assert.ok(!inside, 'the 함수 plate was drawn inside the VPC frame');
});

test('nothing at all is drawn inside the VPC frame', () => {
  // Not now, and not by accident later: a subnet or security-group box appearing under it would
  // claim one of the sixteen subnets a function can name.
  assert.ok(!SPEC.frames.some((f) => f.parent === 'vpc'), 'a frame was nested under the VPC');
  assert.ok(!Object.values(SPEC.rails).some((r) => r.frame === 'vpc'),
            'a rail was pointed at the VPC frame, so plates would be drawn in it');
  const s = sceneOf([functions(12, 4)]);
  const vpc = s.frames.find((f) => f.id === 'vpc');
  for (const sl of s.slots) {
    const inside = sl.x >= vpc.x && sl.x + sl.w <= vpc.x + vpc.w
      && sl.y >= vpc.y && sl.y + sl.h <= vpc.y + vpc.h;
    assert.ok(!inside, `${sl.resourceType} was drawn inside the VPC frame`);
  }
});

test('there is no availability zone, subnet or security group frame', () => {
  // Each is a checked absence, not an oversight. VpcConfigResponse publishes no zone at all;
  // SubnetIds is max 16; and lambda has no security-group resource type for a box to count.
  for (const id of ['az', 'subnet', 'sg']) {
    assert.ok(!SPEC.frames.some((f) => f.id === id), `the picture grew a ${id} frame`);
  }
});

test('the VPC frame is absent when the querier placed nothing', () => {
  // An empty solid box reads as a confirmed containment; an empty dashed one reads as a VPC the
  // policy reaches and does not. The ordinary account has no VPC-attached function, and the
  // correct picture for it has no VPC box.
  const none = sceneOf([functions(12, 0)]);
  assert.equal(none.placed, 0);
  assert.ok(!none.frames.some((f) => f.id === 'vpc'), 'an empty VPC frame was drawn');
  const some = sceneOf([functions(12, 4)]);
  assert.equal(some.placed, 4);
  assert.ok(some.frames.some((f) => f.id === 'vpc'), 'the measured VPC frame was not drawn');
});

test('the VPC frame is dashed and carries the placed count, not a resource count', () => {
  // The rule the whole feature rests on: a measurement goes on the band as a number and never into
  // border solidity. And the number says what it IS - 배치 확인 - because "VPC 4개" would read as
  // four VPCs, which is not what was counted.
  const s = sceneOf([functions(12, 4)]);
  const vpc = s.frames.find((f) => f.id === 'vpc');
  assert.equal(vpc.dashed, true, 'a measurement leaked into border solidity');
  assert.equal(vpc.count, '4개 배치 확인');
  assert.match(vpc.note, /어느 함수인지는 말하지 않는다/,
               'the frame does not deny the reading it invites');
});

test('a lookup that failed draws the same picture as one that found nothing', () => {
  // The picture must not be asked to carry five different reasons; the screen carries them. What
  // the picture does is not draw a box it has no measurement for.
  const failed = sceneOf([functions(12, 0, {
    resources: Array.from({ length: 12 }, (_, i) => ({
      arn: `arn:aws:lambda:ap-northeast-2:${ACCOUNT}:function:f${i}`,
      region: 'ap-northeast-2', tags: {}, sensitive: false, placement: 'failed',
    })),
  })]);
  const none = sceneOf([functions(12, 0)]);
  assert.deepEqual(failed.frames.map((f) => f.id), none.frames.map((f) => f.id));
  assert.deepEqual(failed.slots.map((s) => [s.resourceType, s.x, s.y]),
                   none.slots.map((s) => [s.resourceType, s.x, s.y]));
  // But the two are NOT the same news, and the scene says which happened.
  assert.deepEqual(failed.unmeasured, { failed: 12 });
  assert.deepEqual(none.unmeasured, {}, 'AWS answering "no VPC" was counted as a gap');
});

test('every reason the lookup could not answer is counted, and none of them is 배치됨', () => {
  // Defect it prevents: a denied lookup folded into "not in a VPC". They are opposite news - one
  // is a deploy step, the other is an architecture - and an approver acts differently on each.
  const rows = ['vpc', 'none', 'failed', 'over-budget', 'subnet-unknown', undefined]
    .map((placement, i) => ({
      arn: `arn:aws:lambda:ap-northeast-2:${ACCOUNT}:function:f${i}`,
      region: 'ap-northeast-2', tags: {}, sensitive: false,
      ...(placement ? { placement } : {}),
      ...(placement === 'vpc' ? { vpc_id: 'vpc-0a1' } : {}),
    }));
  const s = sceneOf([{ service: 'lambda', resource_type: 'lambda:function', actions: [],
                       scope: '*', total: 6, truncated: false, sensitive_hits: 0, resources: rows }]);
  assert.equal(s.placed, 1);
  assert.deepEqual(s.unmeasured,
                   { failed: 1, 'over-budget': 1, 'subnet-unknown': 1, unanswered: 1 });
  // The buckets and the placed count together are every placeable row, so nothing is lost.
  const counted = s.placed + Object.values(s.unmeasured).reduce((n, v) => n + v, 0);
  assert.equal(counted, 6 - 1, 'a row is in neither bucket');   // the 'none' row is an ANSWER
});

test('all eleven types are in the regional rail', () => {
  // A rail is a placement claim. Every Lambda type is region-scoped, so one rail says only that -
  // which means a spelling this table gets wrong costs a foot line and never a wrong position.
  // Ten of the eleven are derived from the reference's own type names rather than seen in a live
  // Resource Explorer document, and this is what makes that derivation safe.
  assert.equal(Object.keys(SPEC.slots).length, 11);
  for (const [type, slot] of Object.entries(SPEC.slots)) {
    assert.equal(slot.kind, 'node', `${type} is not a plate`);
    assert.equal(slot.rail, 'regional', `${type} makes a placement claim`);
    assert.ok(type.startsWith('lambda:'), `${type} is not a lambda type`);
  }
  assert.deepEqual(SPEC.noSlot, {}, 'a type was refused a place with no reason recorded here');
});

test('only lambda:function is placeable, and it matches the querier', () => {
  // Pinned against LAMBDA_PLACEMENT in impact/inventory.py. Drift makes a type that cannot be
  // placed count against the lookup, so the screen reports a permission failure that never
  // happened - a layer has no VPC to be in.
  assert.deepEqual([...SPEC.placeable], ['lambda:function']);
  assert.equal(SPEC.multiSubnet, true, 'a function attaches ENIs in up to sixteen subnets');
});

test('a function AWS says is in no VPC does not count against the VPC filter', () => {
  // The coverage floor decides whether the VPC dimension is offered at all, so reading "AWS
  // answered: no VPC" as "we could not look" would take the filter away on a perfectly measured
  // account and print 배치를 읽지 못했다 about eight functions AWS answered about.
  const f = facets(policyOf([functions(12, 4)]));
  assert.equal(f.unplaced, 0, 'an answered row was counted as unplaced');
  assert.deepEqual(f.vpcs, [{ id: 'vpc-0a1', total: 4 }]);
  assert.equal(f.coverage.vpcs.known, 12);
  assert.equal(f.coverage.vpcs.applicable, 12);
  assert.deepEqual(f.unavailable, [], 'the VPC dimension was withdrawn from a measured account');
  // And narrowing to that VPC keeps the four that say they are in it, not the twelve.
  assert.equal(sceneOf([functions(12, 4)], { vpcs: ['vpc-0a1'] }).measured, 4);
});

test('the summary names 람다 and the caption travels with the crop', () => {
  const s = sceneOf([functions(12, 4)]);
  assert.match(sceneSummary(s), /^이 정책이 닿는 람다 자원/);
  assert.match(sceneSummary(s), /람다의 일반적인 구성 자리/);
  assert.ok(s.foot.some((l) => l.text === SPEC.words.caption), 'the caption is not in the viewBox');
  assert.match(SPEC.words.caption, /람다의 일반적인 자리/);
  // And the sentence that says what this picture leaves to the EC2 one.
  assert.match(SPEC.words.omitted, /EC2 구성도의 몫/);
});

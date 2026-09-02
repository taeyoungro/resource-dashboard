// The join between one resource and the two analyses - the thing a reader cannot check by looking.
//
// A finding names a TYPE and a SAMPLE of ARNs, never "this resource". So the question these tests
// pin is the one the panel answers wrongly if nobody watches it: does THIS finding reach THIS
// resource, or does it reach another resource of the same type, or can nobody tell?
//
//     node --test server/resourceFacts.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { gradesByResource, reachOf, resourceFacts } from './resourceFacts.js';

const A = '718100330247';
const arn = (t, id) => `arn:aws:ec2:us-east-1:${A}:${t}/${id}`;
const WEB = arn('instance', 'i-0aaa111');
const DB = arn('instance', 'i-0bbb222');
const VOL = arn('volume', 'vol-1');

const REFERENCE = {
  reference_version: 'v1',
  retrieved_at: '2026-09-02T00:00:00Z',
  services: {
    ec2: {
      TerminateInstances: ['Write', ['instance']],
      DescribeInstances: ['List', ['instance']],
      CreateTags: ['Tagging', ['instance', 'volume']],
      RunInstances: ['Write', ['instance'], true],
      DetachVolume: ['Write', ['volume', 'instance']],
    },
  },
};

const POLICY = {
  source: 'aws_managed',
  identifier: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
  affected: [
    {
      service: 'ec2',
      resource_type: 'ec2:instance',
      actions: ['ec2:TerminateInstances', 'ec2:DescribeInstances', 'ec2:CreateTags', 'ec2:RunInstances',
                'ec2:UnknownToTheReference'],
      scope: '*',
      total: 2,
      truncated: false,
      sensitive_hits: 1,
      attribution: 'resource_type',
      resources: [
        { arn: WEB, region: 'us-east-1', tags: { Name: 'web-1' }, sensitive: true },
        { arn: DB, region: 'us-east-1', tags: {}, sensitive: false },
      ],
    },
    {
      service: 'ec2',
      resource_type: 'ec2:volume',
      actions: ['ec2:DetachVolume'],
      scope: 'listed',
      total: 1,
      truncated: true,
      sensitive_hits: 0,
      resources: [{ arn: VOL, region: 'us-east-1', tags: {}, sensitive: false }],
    },
  ],
};

/** One finding, in the shape the page receives it. */
const finding = (id, over = {}) => ({
  id,
  axis: 'resource',
  category: 'ESCALATION',
  title: `${id} 제목`,
  escalationGrade: 'HIGH',
  assetImpactGrade: 'UNDETERMINED',
  assetEvidence: [],
  status: 'CONFIRMED',
  blockedBy: [],
  policyName: 'AmazonEC2FullAccess',
  policyId: 'p1',
  triggerActions: ['ec2:TerminateInstances'],
  requiredActions: ['ec2:TerminateInstances'],
  targets: [],
  restrictable: true,
  relatedTo: [],
  narrative: '',
  truncated: false,
  ...over,
});

/** One target group inside a finding. */
const target = (type, sample, complete, actions = ['ec2:TerminateInstances']) => ({
  type, count: sample.length, scope: 'listed', sample, sampleComplete: complete,
  controlPlane: [], governed: 0, governedRoles: [], actions, status: 'CONFIRMED',
});

test('a finding whose sample names the resource reaches it, and one whose complete sample does not never does', () => {
  const names = finding('R-1', { targets: [target('ec2:instance', [WEB], true)] });
  const other = finding('R-2', { targets: [target('ec2:instance', [DB], true)] });
  assert.equal(reachOf(names, WEB, 'ec2:instance').reach, 'named');
  assert.equal(reachOf(other, WEB, 'ec2:instance').reach, 'elsewhere');
  // A different type is not a reach at all, whatever the sample says.
  assert.equal(reachOf(names, VOL, 'ec2:volume'), null);
});

test('a cut sample cannot say either way, and that is its own answer', () => {
  // Defect it prevents: reading "the ARN is not in the sample" as "this finding does not reach
  // this resource" when the sample was a sample. Resource Explorer returns at most 1000 per
  // query, so a big account's samples are cut by default.
  const cut = finding('R-3', { targets: [target('ec2:instance', [DB], false)] });
  assert.equal(reachOf(cut, WEB, 'ec2:instance').reach, 'typed');
  // An assessment written before sampleComplete existed carries no claim, and no claim is not a
  // claim of completeness.
  const old = finding('R-4', { targets: [{ ...target('ec2:instance', [DB], true), sampleComplete: undefined }] });
  assert.equal(reachOf(old, WEB, 'ec2:instance').reach, 'typed');
});

test('the best reach wins when a finding names the type twice', () => {
  const both = finding('R-5', {
    targets: [target('ec2:instance', [DB], true), target('ec2:instance', [WEB], false)],
  });
  assert.equal(reachOf(both, WEB, 'ec2:instance').reach, 'named');
});

test('the panel separates what reaches this resource, what may, and what does not', () => {
  const findings = [
    finding('R-1', { targets: [target('ec2:instance', [WEB], true)] }),
    finding('R-2', { targets: [target('ec2:instance', [DB], true)] }),
    finding('R-3', { escalationGrade: 'CRITICAL', targets: [target('ec2:instance', [DB], false)] }),
    finding('M-1', { source: 'model', escalationGrade: 'MEDIUM', targets: [target('ec2:instance', [WEB], true)] }),
    finding('X-1', { targets: [target('ec2:volume', [VOL], true)] }),
  ];
  const facts = resourceFacts(POLICY, REFERENCE, findings, WEB);
  // HIGH before MEDIUM: the list is sorted by grade, not by which half found it.
  assert.deepEqual(facts.findings.named.map((f) => f.id), ['R-1', 'M-1']);
  assert.deepEqual(facts.findings.typed.map((f) => f.id), ['R-3']);
  assert.equal(facts.findings.elsewhere, 1, 'a finding on another resource of the type was not counted');
  // The two halves are marked, so the panel can draw them under their own headings.
  assert.equal(facts.findings.named.find((f) => f.id === 'M-1').source, 'model');
  assert.equal(facts.findings.named.find((f) => f.id === 'R-1').source, 'rule');
  // CRITICAL first inside each list.
  const graded = resourceFacts(POLICY, REFERENCE, [
    finding('R-low', { escalationGrade: 'LOW', targets: [target('ec2:instance', [WEB], true)] }),
    finding('R-crit', { escalationGrade: 'CRITICAL', targets: [target('ec2:instance', [WEB], true)] }),
  ], WEB);
  assert.deepEqual(graded.findings.named.map((f) => f.id), ['R-crit', 'R-low']);
  assert.equal(graded.worstGrade, 'CRITICAL');
});

test('the same finding from two scopes is counted once', () => {
  // RiskAnalysis runs one scope per policy plus one for the plan, and the same rule fires in both.
  const one = finding('R-1', { targets: [target('ec2:instance', [WEB], true)] });
  const facts = resourceFacts(POLICY, REFERENCE, [one, { ...one }], WEB);
  assert.equal(facts.findings.named.length, 1);
});

test('the actions are the ones that reach this type, with the level AWS gives them', () => {
  const facts = resourceFacts(POLICY, REFERENCE, [], WEB);
  assert.deepEqual(facts.actions.map((a) => [a.name, a.level]), [
    ['ec2:RunInstances', 'Write'],
    ['ec2:TerminateInstances', 'Write'],
    ['ec2:CreateTags', 'Tagging'],
    ['ec2:DescribeInstances', 'List'],
    ['ec2:UnknownToTheReference', null],
  ]);
  // Permissions management first, then Write, Tagging, Read, List - and the unknown last.
  assert.deepEqual(facts.levels.map((l) => [l.level, l.count]),
                   [['Write', 2], ['Tagging', 1], ['List', 1], ['', 1]]);
  // An action that BRINGS THE TYPE INTO BEING is marked: a restriction naming today's resources is
  // no scope for it.
  assert.equal(facts.actions.find((a) => a.name === 'ec2:RunInstances').makes, true);
  assert.equal(facts.actions.find((a) => a.name === 'ec2:TerminateInstances').makes, false);
  // An assessment with no reference at all gets a level of null on everything, never a guess.
  const bare = resourceFacts(POLICY, null, [], WEB);
  assert.ok(bare.actions.every((a) => a.level === null));
});

test('the group facts an approver has to see travel with the resource', () => {
  const instance = resourceFacts(POLICY, REFERENCE, [], WEB);
  assert.equal(instance.scope, '*', 'a policy that named no resource is not marked');
  assert.equal(instance.attribution, 'resource_type');
  assert.equal(instance.truncated, false);
  assert.equal(instance.groupTotal, 2);
  assert.equal(instance.sensitive, true);
  assert.equal(instance.name, 'web-1');
  const volume = resourceFacts(POLICY, REFERENCE, [], VOL);
  assert.equal(volume.scope, 'listed');
  assert.equal(volume.truncated, true, 'a truncated group is not marked');
  assert.equal(volume.resourceType, 'ec2:volume');
  assert.deepEqual(volume.actions.map((a) => a.name), ['ec2:DetachVolume']);
});

test('an arn in no group of this policy has no panel', () => {
  assert.equal(resourceFacts(POLICY, REFERENCE, [], arn('instance', 'i-elsewhere')), null);
  assert.equal(resourceFacts(null, REFERENCE, [], WEB), null);
});

test('the picture can mark the resources a finding names before anything is clicked', () => {
  const findings = [
    finding('R-1', { escalationGrade: 'HIGH', targets: [target('ec2:instance', [WEB], true)] }),
    finding('R-2', { escalationGrade: 'CRITICAL', targets: [target('ec2:instance', [WEB, DB], true)] }),
    finding('R-3', { escalationGrade: 'LOW', targets: [target('ec2:instance', ['arn:aws:ec2:us-east-1:1:instance/i-gone'], true)] }),
  ];
  const marks = gradesByResource(POLICY, findings);
  assert.equal(marks.get(WEB), 'CRITICAL', 'the worst grade is not the one shown');
  assert.equal(marks.get(DB), 'CRITICAL');
  assert.equal(marks.size, 2, 'an ARN that is in no group of this policy was marked');
});

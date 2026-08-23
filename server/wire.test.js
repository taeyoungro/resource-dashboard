// The wire form, and the one thing it must never be: a change of content.
//
// Every test here is the same question asked of a different field - is what the model receives the
// same grant the server is holding, written shorter? A notation that loses a fact is not a saving,
// it is a quieter analysis, and the two are indistinguishable from the answer.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validate } from './riskAnalysis.js';
import { wireCandidates, wireDigest } from './wire.js';

const ACCOUNT = '718100330247';
const arn = (type, i) => `arn:aws:ec2:ap-northeast-2:${ACCOUNT}:${type}/${type}-000${i}-8f3a1c`;

const DIGEST = () => ({
  digest_version: 1,
  meta: { account_id: ACCOUNT },
  grants: [{
    p: 'P1',
    name: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
    complete_services: ['ec2'],
    risk_actions: ['ec2:AssociateIamInstanceProfile', 'ec2:RunInstances'],
    non_restrictable: [],
    units: [
      { t: 'ec2:instance', n: 24, scope: '*', truncated: false, sample_complete: false,
        sample: [arn('instance', 0), arn('instance', 1), arn('instance', 2)], cp: [] },
      { t: 'ec2:volume', n: 1, scope: '*', truncated: false, sample_complete: true,
        sample: [arn('volume', 0)], cp: [] },
      // Two regions in one unit. Nothing to fold, and folding half of it would be a second
      // notation to explain for no saving worth having.
      { t: 'ec2:snapshot', n: 2, scope: '*', truncated: false, sample_complete: true,
        sample: ['arn:aws:ec2:us-east-1:1:snapshot/snap-a1b2c3',
                 'arn:aws:ec2:eu-west-1:1:snapshot/snap-d4e5f6'], cp: [] },
    ],
  }],
  budget: {
    dropped: [
      { what: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess ec2 action names', count: 498,
        why: 'ec2:* is granted whole and complete_services says so', recoverable: true },
      { what: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess elasticloadbalancing action names',
        count: 61, why: 'ec2:* is granted whole and complete_services says so', recoverable: true },
    ],
  },
});

const CANDIDATE = () => ({
  id: 'C1',
  edge: 'takeover-identity',
  outcome: 'credentials_of',
  why: 'the identity a running thing carries can be replaced, so the caller chooses which role the '
    + 'workload runs as',
  policy: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
  policy_id: 'P1',
  target: { type: 'ec2:instance', count: 24, scope: '*', truncated: false,
            sample: [arn('instance', 0), arn('instance', 1)], sample_complete: false },
  control_plane: [],
  steps: [{ capability: 'replace_identity', actions: ['ec2:AssociateIamInstanceProfile'] }],
  also_granted: [],
  reservations: [],
});

// ---- the digest -------------------------------------------------------------------------------

test('a folded ARN reconstructs to the byte it came from', () => {
  const unit = wireDigest(DIGEST()).grants[0].units[0];
  assert.equal(unit.arn_prefix, `arn:aws:ec2:ap-northeast-2:${ACCOUNT}:instance/`);
  assert.deepEqual(unit.sample.map((tail) => unit.arn_prefix + tail),
                   DIGEST().grants[0].units[0].sample);
});

test('ARNs that do not share a prefix are left whole', () => {
  const [, single, mixed] = wireDigest(DIGEST()).grants[0].units;
  // One ARN has no shared prefix worth naming - the prefix would be longer than the saving.
  assert.equal('arn_prefix' in single, false);
  assert.deepEqual(single.sample, [arn('volume', 0)]);
  // Two regions. A partial fold would be a second notation for nothing.
  assert.equal('arn_prefix' in mixed, false);
  assert.equal(mixed.sample[0], 'arn:aws:ec2:us-east-1:1:snapshot/snap-a1b2c3');
});

test('everything the unit says apart from the ARNs is untouched', () => {
  const before = DIGEST().grants[0].units[0];
  const after = wireDigest(DIGEST()).grants[0].units[0];
  for (const key of ['t', 'n', 'scope', 'truncated', 'sample_complete']) {
    assert.deepEqual(after[key], before[key], `${key} changed`);
  }
});

test('the dropped list says its reason once and names the grant by its digest id', () => {
  const { budget } = wireDigest(DIGEST());
  assert.deepEqual(budget.dropped.map((d) => d.what),
                   ['P1 ec2 action names', 'P1 elasticloadbalancing action names']);
  // Both entries carry the same code, and the code resolves to the sentence they used to repeat.
  assert.equal(budget.dropped[0].why, budget.dropped[1].why);
  assert.equal(budget.why[budget.dropped[0].why],
               'ec2:* is granted whole and complete_services says so');
  // Counts are the finding. They are never folded.
  assert.deepEqual(budget.dropped.map((d) => d.count), [498, 61]);
});

test('the digest the server holds is not touched', () => {
  // The reason this matters is one function: forbiddenNames() walks unit.sample for the resource
  // names a narrative may not contain, and it needs whole ARNs. So does the card the page draws.
  const digest = DIGEST();
  wireDigest(digest);
  assert.deepEqual(digest.grants[0].units[0].sample, DIGEST().grants[0].units[0].sample);
  assert.equal('arn_prefix' in digest.grants[0].units[0], false);
  assert.equal(digest.budget.dropped[0].what,
               'arn:aws:iam::aws:policy/AmazonEC2FullAccess ec2 action names');
});

test('one assessment folds once, however many batches ask for it', () => {
  const digest = DIGEST();
  assert.equal(wireDigest(digest), wireDigest(digest));
});

// ---- the candidates ---------------------------------------------------------------------------

test('the three fields that were already in the request go', () => {
  const [wired] = wireCandidates([CANDIDATE()]);
  assert.equal('why' in wired, false, 'the edge sentence is a legend in the frame now');
  assert.equal('policy' in wired, false, 'policy_id names the same grant');
  assert.equal('sample' in wired.target, false, 'the unit carries these ARNs already');
  assert.equal('sample_complete' in wired.target, false);
});

test('what the verdict is judged on stays', () => {
  const [wired] = wireCandidates([CANDIDATE()]);
  assert.equal(wired.id, 'C1');
  assert.equal(wired.edge, 'takeover-identity');
  assert.equal(wired.policy_id, 'P1');
  // T-6: truncated travels with the target, and unknown is null rather than absent.
  assert.deepEqual(wired.target, { type: 'ec2:instance', count: 24, scope: '*', truncated: false });
  // The citation contract reads these. Losing one would make an honest citation a fabrication.
  assert.deepEqual(wired.steps, CANDIDATE().steps);
  assert.deepEqual(wired.reservations, []);
});

test('a candidate that reaches nothing keeps saying so', () => {
  const [wired] = wireCandidates([{ ...CANDIDATE(), target: null }]);
  assert.equal(wired.target, null);
});

test('every target names a unit the wire digest still carries', () => {
  // The lookup the frame promises. A candidate says "ec2:instance"; the ARNs are on the digest unit
  // whose t is that string. If the two ever drift the model is told to look somewhere empty.
  const wired = wireDigest(DIGEST());
  const units = new Set(wired.grants.flatMap((g) => g.units.map((u) => `${g.p}/${u.t}`)));
  for (const candidate of wireCandidates([CANDIDATE()])) {
    if (!candidate.target) continue;
    assert.ok(units.has(`${candidate.policy_id}/${candidate.target.type}`),
              `${candidate.target.type} is on no unit of ${candidate.policy_id}`);
  }
});

test('a narrative naming a sampled resource is still caught', () => {
  // The end-to-end version of "the server is not touched". The model never sees these ARNs whole
  // any more; the check that a verdict did not name one reads the digest, not the wire form.
  const digest = DIGEST();
  wireDigest(digest);
  const { dropped } = validate([{
    candidate_id: 'C1', real: true, human_error: false, mechanism: 'existing_resource',
    preconditions: [], final_impact: '역할 자격 증명을 얻는다', evidence_sufficient: true,
    cited_actions: ['ec2:AssociateIamInstanceProfile'], category: 'ESCALATION',
    proposed_grade: 'HIGH', title: '인스턴스 프로파일 교체',
    narrative: `instance-0000-8f3a1c 인스턴스의 프로파일을 교체하면 역할 자격 증명을 얻는다`,
    containment: { deny_actions: ['ec2:AssociateIamInstanceProfile'], breaks: '배포가 막힌다',
                   blocked_elsewhere: false },
  }], { candidates: [CANDIDATE()], digest });
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].why, /names a resource/);
});

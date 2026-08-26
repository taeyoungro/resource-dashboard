// The rule engine, against the acceptance criteria the design shipped with.
//
// Every test below is one line of IMPLEMENTATION.md §2, plus the two the condensed input forces:
// a rule that needs its actions on ONE resource cannot be CONFIRMED on a unit the producer built
// by unioning statements, and a grade may not move on a match against a name.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RULES, RULES_SHA256, RULE_ACTIONS, RuleError, validate } from './rules.js';
import { evaluateGrant, findings, sections, sortFindings, summary } from './findings.js';

const ACCOUNT = '718100330247';
const arn = (type, i) => `arn:aws:${type.split(':')[0]}:us-east-1:${ACCOUNT}:${type.split(':')[1]}/r${i}`;

/** A digest unit: a resource-type group, its action indices, and what it can prove. */
function unit(type, actions, riskActions, over = {}) {
  const total = over.n ?? 3;
  return {
    t: type,
    n: total,
    scope: '*',
    colocation: 'sound',
    attribution: 'resource_type',
    sensitive: 0,
    truncated: false,
    omitted: null,
    sample: Array.from({ length: Math.min(total, 8) }, (_, i) => arn(type, i)),
    sample_complete: total <= 8,
    cp: [],
    acts: actions.map((a) => riskActions.indexOf(a)).filter((i) => i >= 0),
    folded: 0,
    reads: 0,
    ...over,
  };
}

function grant(name, riskActions, units, over = {}) {
  return {
    p: over.p ?? 'P1',
    name: `arn:aws:iam::aws:policy/${name}`,
    source: 'aws_managed',
    version: 'v7',
    is_baseline: false,
    restrictable: true,
    unreadable: null,
    as_written: riskActions,
    complete_services: [],
    risk_actions: riskActions,
    non_restrictable: [],
    units,
    ...over,
  };
}

function digest(grants, over = {}) {
  return {
    digest_version: 1,
    meta: { account_id: ACCOUNT, rules_sha256: RULES_SHA256 },
    protected_actions: [],
    passrole_grants: [],
    grants,
    coverage: {
      complete: true, policies_unreadable: [], actions_unbounded: [], actions_unresolved: [],
    },
    ...over,
  };
}

const only = (list, id) => list.filter((f) => f.id === id);

// ---- the rule file --------------------------------------------------------------------------

test('the rule file loads, and every action a rule names is exported for the digest to keep', () => {
  // The digest folds a wholly-granted service down to a count, and keeps rule-named actions by
  // name because the engine matches exact strings. That contract is this set.
  assert.ok(RULES.length >= 12);
  assert.equal(RULES_SHA256.length, 64);
  for (const action of ['iam:PassRole', 'lambda:CreateFunction', 'ec2:ModifyInstanceAttribute',
                        'dynamodb:ExportTableToPointInTime', 'iam:ListRoles']) {
    assert.ok(RULE_ACTIONS.has(action), `${action} is named by a rule and was not exported`);
  }
});

test('a malformed rule file is refused rather than started with', () => {
  // §2 line 1. An empty rule set reports every grant as clean, which is the page a clean grant
  // produces - so there is no version of this that falls back.
  const good = { schemaVersion: '0.1', rules: [RULES[0]], sort: {}, sectionOrder: ['ESCALATION'] };
  assert.ok(validate(good));

  assert.throws(() => validate({ schemaVersion: '0.1', rules: [] }), RuleError, 'empty rule set');
  assert.throws(() => validate({ rules: [RULES[0]] }), RuleError, 'no schemaVersion');
  assert.throws(() => validate({
    schemaVersion: '0.1',
    // A wildcard would not throw at match time. It would match nothing, silently, forever.
    rules: [{ ...RULES[0], predicate: { action: 'ec2:*' } }],
    sectionOrder: ['ESCALATION'],
  }), RuleError, 'wildcard action');
  assert.throws(() => validate({
    schemaVersion: '0.1', rules: [{ ...RULES[0], evaluatedOn: 'perAccount' }],
    sectionOrder: ['ESCALATION'],
  }), RuleError, 'unknown scope');
  assert.throws(() => validate({
    schemaVersion: '0.1', rules: [RULES[0], RULES[0]], sectionOrder: ['ESCALATION'],
  }), RuleError, 'duplicate id');
  assert.throws(() => validate({
    schemaVersion: '0.1', rules: [{ ...RULES[0], relatedTo: ['E-9'] }],
    sectionOrder: ['ESCALATION'],
  }), RuleError, 'relatedTo names a rule that is not here');
  assert.throws(() => validate({
    schemaVersion: '0.1', rules: [RULES[0]], sectionOrder: ['ESCALATION'],
    // T-7 as data: the file forbids the key and the loader enforces it.
    sort: { keys: ['assetImpactGrade:desc'], forbiddenKeys: ['assetImpactGrade'] },
  }), RuleError, 'forbidden sort key');
});

// ---- scope separation -----------------------------------------------------------------------

test('E-1 fires across resources, because the grant is where the union lives', () => {
  // §2 line 3. iam:PassRole on a role and lambda:CreateFunction on a function is one path, and
  // neither action is on the other resource. Evaluated on the grant, not on a unit.
  const actions = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction'];
  const d = digest([grant('Escalate', actions, [
    unit('iam:role', ['iam:PassRole'], actions),
    unit('lambda:function', ['lambda:CreateFunction', 'lambda:InvokeFunction'], actions),
  ])], { passrole_grants: [{ name: 'Escalate', services: ['lambda.amazonaws.com'],
                             resources: ['*'], unconditioned: true }] });

  const [found] = only(findings(d), 'E-1');
  assert.ok(found, 'E-1 did not fire across two resource types');
  assert.equal(found.escalationGrade, 'CRITICAL');
  assert.deepEqual(found.triggerActions,
                   ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction']);
  assert.equal(found.status, 'CONFIRMED');
});

test('E-3 does not fire on actions the input never put on one resource', () => {
  // §2 line 2. Stop and Start on instances, Modify on something else entirely. The policy's union
  // holds all three; no single unit does. A rule scoped to resourceActionSet must not read the
  // union - that is the false positive the scope exists to prevent.
  const actions = ['ec2:StopInstances', 'ec2:StartInstances', 'ec2:ModifyInstanceAttribute'];
  const d = digest([grant('Split', actions, [
    unit('ec2:instance', ['ec2:StopInstances', 'ec2:StartInstances'], actions),
    unit('ec2:volume', ['ec2:ModifyInstanceAttribute'], actions),
  ])]);
  assert.deepEqual(only(findings(d), 'E-3'), []);
});

test('a rule needing one resource is not CONFIRMED on a unit built by union', () => {
  // The condensed input's own limit, stated rather than hidden. The producer unions the actions of
  // every statement into one group per resource type, so a policy granting Stop on instance A and
  // Modify on instance B produces a single unit holding both - and E-3 would fire on a co-location
  // that does not exist. The digest marks it, and this refuses to call it CONFIRMED.
  const actions = ['ec2:StopInstances', 'ec2:StartInstances', 'ec2:ModifyInstanceAttribute'];
  const listed = unit('ec2:instance', actions, actions, { scope: 'listed', colocation: 'union' });
  const [found] = only(findings(digest([grant('Listed', actions, [listed])])), 'E-3');
  assert.ok(found, 'E-3 did not fire at all - the path may be real and has to be shown');
  assert.equal(found.status, 'UNVERIFIED');
  assert.equal(found.escalationGrade, 'HIGH', 'the grade is the rule\'s and does not move');
  assert.ok(found.blockedBy.some((r) => r.includes('different resources')));

  // Unscoped is the sound case: every action reaches every resource of the type.
  const wide = unit('ec2:instance', actions, actions);
  const [sound] = only(findings(digest([grant('Wide', actions, [wide])])), 'E-3');
  assert.equal(sound.status, 'CONFIRMED');
});

test('a unit whose actions were attributed by service cannot be CONFIRMED', () => {
  // attribution='service' is the producer saying it did not know which resource type the action
  // applies to, so it attached every resource of the service. The target list may be wrong, which
  // is a different objection from co-location and gets its own sentence.
  const actions = ['ec2:TerminateInstances'];
  const guessed = unit('ec2:instance', actions, actions, { attribution: 'service' });
  const [found] = only(findings(digest([grant('Guessed', actions, [guessed])])), 'D-3');
  assert.equal(found.status, 'UNVERIFIED');
  assert.ok(found.blockedBy.some((r) => r.includes('could not resolve which resource type')));
});

test('R-1 is evaluated on the declaration path, and is not restrictable', () => {
  // The reads that a policy reduction cannot block, because they are how the pipeline itself
  // establishes what a permission set contains. A finding that claimed to be restrictable here
  // would be promising an approver something the restriction cannot deliver.
  const nonRestrictable = ['iam:GetRole', 'iam:ListRoles', 'iam:ListAttachedRolePolicies'];
  const d = digest([grant('Recon', [], [], { non_restrictable: nonRestrictable })]);
  const [found] = only(findings(d), 'R-1');
  assert.ok(found);
  assert.equal(found.restrictable, false);
  assert.deepEqual(found.relatedTo, ['E-1']);
  // Nothing in the grant's own action list, so a policyActionUnion rule sees the declaration path
  // too - it is granted, and it is what E-1's reconnaissance half rests on.
  assert.deepEqual(found.targets, []);
});

// ---- status, bounds, truncation ---------------------------------------------------------------

test('an unreadable policy body leaves E-1 UNVERIFIED at CRITICAL', () => {
  // §2 line 4. The grade is the rule's statement about the path; the status is what this input can
  // prove about its ceiling. They are independent, and a missing ceiling never lowers the grade.
  const actions = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:AddPermission'];
  const d = digest([grant('Escalate', actions, [unit('iam:role', actions, actions)])], {
    passrole_grants: [{ name: 'Escalate', services: [], resources: ['*'], unconditioned: true }],
    coverage: { policies_unreadable: ['arn:aws:iam::aws:policy/SomeOtherPolicy'],
                actions_unbounded: [], actions_unresolved: [] },
  });
  const [found] = only(findings(d), 'E-1');
  assert.equal(found.escalationGrade, 'CRITICAL');
  assert.equal(found.status, 'UNVERIFIED');
  assert.ok(found.blockedBy.some((r) => r.includes('SomeOtherPolicy')));
});

test('an unknown passable role set leaves E-1 UNVERIFIED', () => {
  // The rule bounds itself on passableRoleSet. An assessment that recorded no PassRole grant, or
  // recorded one without its Resource list, does not carry the bound - and the bound is the
  // finding's whole reach.
  const actions = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction'];
  const units = [unit('iam:role', actions, actions)];

  const none = only(findings(digest([grant('Escalate', actions, units)])), 'E-1')[0];
  assert.equal(none.status, 'UNVERIFIED');
  assert.ok(none.blockedBy.some((r) => r.includes('passable role set is unknown')));

  const unknown = only(findings(digest([grant('Escalate', actions, units)], {
    passrole_grants: [{ name: 'Escalate', services: [], resources: null, unconditioned: true }],
  })), 'E-1')[0];
  assert.equal(unknown.status, 'UNVERIFIED');
});

test('a truncated resource list reaches the finding, and unknown truncation is not false', () => {
  // §2 line 5 and T-6. A list that was cut off means the reach of the finding is unbounded below
  // what it shows; a list whose completeness was never recorded is not the same as a complete one,
  // and writing false here would silently promote a finding to CONFIRMED.
  const actions = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction'];
  const cut = unit('iam:role', actions, actions, { truncated: true, n: 4000 });
  const [found] = only(findings(digest([grant('Escalate', actions, [cut])], {
    passrole_grants: [{ name: 'Escalate', services: [], resources: ['*'], unconditioned: true }],
  })), 'E-1');
  assert.equal(found.truncated, true);
  assert.equal(found.status, 'NOT_ASSESSABLE', 'the rule file says NOT_ASSESSABLE on truncation');

  const unknown = unit('iam:role', actions, actions, { truncated: null });
  const [second] = only(findings(digest([grant('Escalate', actions, [unknown])], {
    passrole_grants: [{ name: 'Escalate', services: [], resources: ['*'], unconditioned: true }],
  })), 'E-1');
  assert.equal(second.truncated, null);
  assert.notEqual(second.truncated, false);
});

test('unbounded actions make every finding unverified, because no action list is complete', () => {
  const actions = ['dynamodb:DeleteTable'];
  const d = digest([grant('Wide', actions, [unit('dynamodb:table', actions, actions)])], {
    coverage: { policies_unreadable: [], actions_unresolved: [],
                actions_unbounded: ['s3:*'] },
  });
  const [found] = only(findings(d), 'D-1');
  assert.equal(found.status, 'UNVERIFIED');
  assert.ok(found.blockedBy.some((r) => r.includes('could not bound')));
});

test('one rule throwing does not stop the others', () => {
  // T-3. A rule engine that stops at the first exception reports fewer findings than there are,
  // and reports that as a clean result.
  const actions = ['dynamodb:DeleteTable'];
  const d = digest([grant('Wide', actions, [unit('dynamodb:table', actions, actions)])]);
  const broken = { ...RULES.find((r) => r.id === 'D-1'), id: 'Z-1', evaluatedOn: 'nonsense' };
  const list = evaluateGrant(d.grants[0], d, [broken, RULES.find((r) => r.id === 'D-1')]);
  const [failed] = only(list, 'Z-1');
  assert.equal(failed.status, 'NOT_ASSESSABLE');
  assert.ok(failed.blockedBy[0].includes('could not be evaluated'));
  assert.equal(only(list, 'D-1').length, 1, 'the rule after the broken one did not run');
});

// ---- T-4: no grade, no sentence, from a name -------------------------------------------------

test('renaming every resource and tag changes nothing but the ARNs', () => {
  // §2 line 6, asserted by construction rather than by inspection. If a name reached a grade or a
  // narrative, this diff would not be empty.
  const actions = ['ec2:TerminateInstances', 'ec2:CreateSnapshot'];
  const plain = unit('ec2:instance', actions, actions);
  const renamed = {
    ...plain,
    sample: plain.sample.map((a) => a.replace(/r\d+$/, 'i-approval-store-lock-table')),
  };
  const strip = (list) => list.map(({ targets, ...rest }) => rest);
  assert.deepEqual(
    strip(findings(digest([grant('Ec2', actions, [renamed])]))),
    strip(findings(digest([grant('Ec2', actions, [plain])]))),
  );
  for (const found of findings(digest([grant('Ec2', actions, [renamed])]))) {
    assert.equal(found.narrative, RULES.find((r) => r.id === found.id).narrative,
                 'the narrative was composed rather than copied');
  }
});

test('a prefix match does not move the asset grade; a configured one does', () => {
  // The asset axis, resolved the only way T-4 allows: a match against a value this deployment was
  // configured with, or an ARN an operator declared. opt-* is a name the pipeline issues, which is
  // still a name - it is labelled and it does not count.
  const actions = ['dynamodb:PutItem', 'dynamodb:DeleteTable'];
  const table = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/opt-approval-store`;

  const byName = unit('dynamodb:table', actions, actions,
                      { cp: [{ arn: table, role: 'approval_store', basis: 'prefix' }] });
  assert.equal(only(findings(digest([grant('Ddb', actions, [byName])])), 'D-1')[0].assetImpactGrade,
               'UNDETERMINED');

  const configured = unit('dynamodb:table', actions, actions,
                          { cp: [{ arn: table, role: 'approval_store', basis: 'configured' }] });
  const [found] = only(findings(digest([grant('Ddb', actions, [configured])])), 'D-1');
  assert.equal(found.assetImpactGrade, 'CRITICAL');
  assert.deepEqual(found.assetEvidence,
                   [{ arn: table, role: 'approval_store', basis: 'configured' }]);
});

// ---- ordering and shape ----------------------------------------------------------------------

test('sorting is by grade, then status, then id - and never by the asset axis', () => {
  // §2 line 7. UNDETERMINED dominates the asset axis, so sorting by it would rank almost nothing.
  const list = [
    { id: 'D-1', escalationGrade: 'LOW', status: 'CONFIRMED', assetImpactGrade: 'CRITICAL', policyId: 'P1' },
    { id: 'E-1', escalationGrade: 'CRITICAL', status: 'UNVERIFIED', assetImpactGrade: 'UNDETERMINED', policyId: 'P1' },
    { id: 'E-2', escalationGrade: 'HIGH', status: 'CONFIRMED', assetImpactGrade: 'UNDETERMINED', policyId: 'P1' },
    { id: 'E-3', escalationGrade: 'HIGH', status: 'NOT_ASSESSABLE', assetImpactGrade: 'CRITICAL', policyId: 'P1' },
  ];
  assert.deepEqual(sortFindings(list).map((f) => f.id), ['E-1', 'E-2', 'E-3', 'D-1']);
  // Same order with the asset axis inverted.
  const flipped = list.map((f) => ({
    ...f, assetImpactGrade: f.assetImpactGrade === 'CRITICAL' ? 'UNDETERMINED' : 'CRITICAL',
  }));
  assert.deepEqual(sortFindings(flipped).map((f) => f.id), sortFindings(list).map((f) => f.id));
});

test('trigger actions are the names as written, and sections come out in the stated order', () => {
  // §2 line 8. Casing and prefix intact, no abbreviation, no "and others" - an approver has to be
  // able to see what made the card appear.
  const actions = ['ec2:GetConsoleOutput', 'ec2:TerminateInstances', 'lambda:UpdateFunctionCode'];
  const list = findings(digest([grant('Mixed', actions, [
    unit('ec2:instance', ['ec2:GetConsoleOutput', 'ec2:TerminateInstances'], actions),
    unit('lambda:function', ['lambda:UpdateFunctionCode'], actions),
  ])]));
  const trigger = new Set(list.flatMap((f) => f.triggerActions));
  for (const action of actions) assert.ok(trigger.has(action), action);
  assert.deepEqual(sections(list).map((s) => s.category), ['ESCALATION', 'EXPOSURE', 'DESTRUCTIVE']);

  const counts = summary(list);
  assert.equal(counts.total, list.length);
  assert.equal(counts.byGrade.HIGH, only(list, 'E-3').length);
});

test('the baseline is evaluated like any other grant, and marked', () => {
  // The widest policy in the account and the one nobody reads. "It was already true" is a fact for
  // the approver to weigh, not a reason to drop the finding.
  const actions = ['ec2:TerminateInstances'];
  const d = digest([grant('ReadOnlyAccess', actions, [unit('ec2:instance', actions, actions)],
                          { is_baseline: true })]);
  const [found] = only(findings(d), 'D-3');
  assert.equal(found.isBaseline, true);
});

// ---- the empty account: a rule that names a capability must still fire ------------------------

test('E-2 falls back to policy scope when the account enumerated nothing', () => {
  // On an account with resources, the unit pass is what makes the target list precise - E-2 fires
  // on the lambda unit and names the functions. With nothing enumerated it produced no scopes at
  // all and went silent, in exactly the account where "this grant can open an unauthenticated
  // invoke path to whatever gets created" is the whole finding.
  const empty = digest([grant('AWSLambda_FullAccess', ['lambda:CreateFunctionUrlConfig'], [])]);
  const found = findings(empty).find((f) => f.id === 'E-2');
  assert.ok(found, 'the rule is silent on an empty account');
  assert.deepEqual(found.triggerActions, ['lambda:CreateFunctionUrlConfig']);
  assert.deepEqual(found.targets, []);
  // Nothing established that the target list is whole, so completeness is UNKNOWN - never false.
  // Saying false would report a capability-only finding as a complete enumeration.
  assert.equal(found.truncated, null);
  assert.equal(summary(findings(empty)).enumerationIncomplete, 1);
});

test('the fallback does not widen a finding on an account that has resources', () => {
  // The regression this must not become: policy scope attaches every unit the grant touches,
  // including resources of other services, which is a wider answer to a narrower question.
  const actions = ['lambda:CreateFunctionUrlConfig'];
  const riskActions = [...actions, 's3:GetObject'];
  const full = digest([grant('AWSLambda_FullAccess', riskActions,
                             [unit('lambda:function', actions, riskActions),
                              unit('s3:bucket', ['s3:GetObject'], riskActions)])]);
  const found = findings(full).find((f) => f.id === 'E-2');
  assert.equal(found.targets.length, 1, 'the unit pass was replaced by the policy-scope one');
  assert.equal(found.truncated, false, 'a real enumeration was reported as unknown');
});

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
import { capabilitiesOf, referenceIndex } from './capabilities.js';
import { blockOffer, containmentState } from './blockPath.js';

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

/**
 * One rule's findings on ONE axis, defaulting to the resource axis.
 *
 * Every rule is now evaluated twice - once over the units (what this grant reaches in the account
 * as it is) and once over the grant's own action list (what it lets somebody do, which needs no
 * inventory). Most tests below are about the first, and asking for both would make each of them
 * assert two things at once. The axis is named where the test is about the second.
 */
const only = (list, id, axis = 'resource') =>
  list.filter((f) => f.id === id && f.axis === axis);

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
  // The ACTION axis, and only that one. policyNonRestrictable attaches no units and never did -
  // R-1's card has always said "대상 없음, 부여된 능력입니다" - so filing it under what the grant
  // reaches was describing a capability as a reach. See axesFor.
  const [found] = only(findings(d), 'R-1', 'action');
  assert.ok(found);
  assert.deepEqual(only(findings(d), 'R-1', 'resource'), [],
                   'a rule that attaches no resource is being reported as a resource finding');
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
  // RECON is here because ec2:GetConsoleOutput is reconnaissance and is now filed as such. It used
  // to fire X-3 under EXPOSURE, in one card that also narrated disk copies - see R-2.
  assert.deepEqual(sections(list).map((s) => s.category),
                   ['ESCALATION', 'RECON', 'DESTRUCTIVE']);

  const counts = summary(list);
  assert.equal(counts.total, list.length);
  // E-3 is the only HIGH rule here and it fires on both axes - once naming the lambda function it
  // reaches, once saying the grant can rewrite the code of whatever comes to exist. The summary
  // counts findings, so it counts both.
  assert.equal(counts.byGrade.HIGH,
               only(list, 'E-3').length + only(list, 'E-3', 'action').length);
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

// ---- the two axes ------------------------------------------------------------------------------
//
// A grant carries two risks and they were reported as one. 영향 자원 위험 is what it reaches in the
// account as it is; Action 자체 위험 is what it lets somebody do, which needs no inventory. Only the
// first existed, and eleven of thirteen rules are evaluated over units - so an account with nothing
// in it had no units, no scopes, and no findings, which is the account a preventive control is
// written for.

test('every rule is asked both questions, and the answers are marked', () => {
  const actions = ['lambda:CreateFunctionUrlConfig'];
  const full = digest([grant('AWSLambda_FullAccess', actions,
                             [unit('lambda:function', actions, actions)])]);
  const [reach] = only(findings(full), 'E-2');
  const [capability] = only(findings(full), 'E-2', 'action');

  assert.ok(reach, 'the enumerated answer is gone');
  assert.equal(reach.targets.length, 1, 'the unit pass was replaced by the policy-scope one');
  assert.deepEqual(reach.targets[0].sample.length > 0, true);
  assert.equal(reach.truncated, false, 'a real enumeration was reported as unknown');

  assert.ok(capability, 'the capability answer is missing on an account that HAS resources');
  assert.deepEqual(capability.targets, [], 'the action axis attached ARNs');
  // Nothing established that any target list is whole because no list was made. T-6: unknown is
  // null, never false - a false here would report a capability as a complete enumeration.
  assert.equal(capability.truncated, null);

  // Each points at its twin, so two areas showing one rule does not read as two findings.
  assert.equal(reach.alsoOnOtherAxis, true);
  assert.equal(capability.alsoOnOtherAxis, true);
});

test('an empty account gets the whole action axis, not three rules of it', () => {
  // The measured gap. Every one of these rules is evaluated over units, and an account with nothing
  // in it has none - so this grant produced NO finding at all, and the page an approver saw for a
  // brand new account was blank.
  const actions = ['ec2:ReplaceIamInstanceProfileAssociation', 'ec2:CreateRoute',
                   'ec2:CreateSnapshot', 'ec2:TerminateInstances', 'dynamodb:DeleteTable'];
  const empty = digest([grant('AmazonEC2FullAccess', actions, [],
                              { unscoped_actions: actions })]);
  const list = findings(empty);
  assert.deepEqual(list.map((f) => f.id).sort(), ['D-1', 'D-3', 'E-3', 'X-2', 'X-5']);
  assert.ok(list.every((f) => f.axis === 'action'), 'a resource axis finding with no resources');
  assert.ok(list.every((f) => f.targets.length === 0), 'the action axis attached ARNs');
  // Nothing to point at: there is no resource-axis twin, and saying there is would send a reader
  // to an area that does not hold it.
  assert.ok(list.every((f) => f.alsoOnOtherAxis === false));
});

test('the action axis does not inherit the resource axis\'s co-location claim', () => {
  // The error this must not become. E-3's allOf needs Stop, Modify and Start on ONE instance, and
  // over a policy-wide action list nothing says they meet - that is exactly the union-of-statements
  // false positive the unit scope exists to prevent, arriving through the other door.
  const triple = ['ec2:StopInstances', 'ec2:ModifyInstanceAttribute', 'ec2:StartInstances'];
  const [unproven] = only(findings(digest([grant('Split', triple, [])])), 'E-3', 'action');
  assert.ok(unproven, 'E-3 is silent on an empty account');
  assert.equal(unproven.status, 'UNVERIFIED');
  assert.ok(unproven.blockedBy.some((r) => r.includes('granted on named ARNs')));

  // Unscoped is what settles it, and it is a fact about the DOCUMENT rather than the inventory -
  // which is why it can settle it in an account holding nothing. Actions granted on '*' are all
  // available on every instance that comes to exist.
  const [sound] = only(
    findings(digest([grant('Wide', triple, [], { unscoped_actions: triple })])), 'E-3', 'action');
  assert.equal(sound.status, 'CONFIRMED');

  // A single-action hit needs no co-location at all and must not be dragged down with it.
  const one = ['ec2:ReplaceIamInstanceProfileAssociation'];
  const [lone] = only(findings(digest([grant('One', one, [])])), 'E-3', 'action');
  assert.equal(lone.status, 'CONFIRMED');
});

test('a truncated enumeration is not a doubt about a capability', () => {
  // The action axis makes no enumeration, so there is no list to be short. Carrying the resource
  // axis's truncation reservation onto it would be inventing doubt about a claim it never made.
  const actions = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction'];
  const cut = unit('lambda:function', actions, actions, { truncated: true });
  const d = digest([grant('Wide', actions, [cut], { unscoped_actions: actions })],
                   { passrole_grants: [{ name: 'Wide', services: [], resources: ['*'],
                                         unconditioned: true }] });
  const [reach] = only(findings(d), 'E-1');
  const [capability] = only(findings(d), 'E-1', 'action');
  assert.ok(reach.blockedBy.some((r) => r.includes('truncated')));
  assert.ok(!capability.blockedBy.some((r) => r.includes('truncated')),
            'a capability was marked doubtful because a resource list it never used was short');
});

// ---- a rule that fires on what an action DOES ---------------------------------------------------
//
// The rules named 33 action names against 12,328 mutating actions, and a name is only in a
// predicate if somebody wrote it down. X-2 knew ec2:CreateRoute and not
// ec2:ReplaceRouteTableAssociation - which reaches the same place, and calls none of X-2's four.

const reference = (rows) => referenceIndex({
  action_reference: {
    services: Object.entries(rows).reduce((acc, [action, row]) => {
      const [service, name] = action.split(':');
      acc[service] = { ...(acc[service] ?? {}), [name]: [row.level ?? 'Write', row.types ?? []] };
      return acc;
    }, {}),
    allow_only: Object.entries(rows).filter(([, r]) => r.refuse).reduce((acc, [action, row]) => {
      const [service, name] = action.split(':');
      acc[service] = { ...(acc[service] ?? {}), [name]: { refuse: row.refuse } };
      return acc;
    }, {}),
  },
});

test('X-4 fires on a rebinding nobody named, and names the action in full', () => {
  // The case that asked for this. Re-associating a subnet with a route table whose default route
  // points at an internet gateway makes the subnet public, and no action in X-2's predicate is
  // called. The rule fires on the structural fact instead: the request names an association id and
  // the object at the other end is resolved from it, which projection 6 already recorded.
  const action = 'ec2:ReplaceRouteTableAssociation';
  const ref = reference({ [action]: { types: ['route-table', 'subnet'],
                                      refuse: 'deref:AssociationId' } });
  const d = digest([grant('AmazonEC2FullAccess', [action], [], { unscoped_actions: [action] })]);

  const [found] = only(findings(d, undefined, ref), 'X-4', 'action');
  assert.ok(found, 'the rebinding fires no rule at all');
  assert.equal(found.escalationGrade, 'HIGH');
  assert.deepEqual(found.triggerActions, [action], 'the trigger action is not shown in full');

  // Without the reference nothing classifies it, and the rule is silent - which is the state this
  // fixes, and what a regression looks like.
  assert.deepEqual(only(findings(d), 'X-4', 'action'), []);
});

test('a capability term returns every action that satisfied it, not the first', () => {
  // An approver writing a restriction needs all of them, and T-7 says a trigger list is never
  // abbreviated. anyOf short-circuits on the first branch that hits; a capability branch is one
  // branch that can hit many actions at once.
  const acts = ['ec2:ReplaceRouteTableAssociation', 'ec2:ReplaceNetworkAclAssociation'];
  const ref = reference({
    'ec2:ReplaceRouteTableAssociation': { types: ['route-table'], refuse: 'deref:AssociationId' },
    'ec2:ReplaceNetworkAclAssociation': { types: ['network-acl'], refuse: 'deref:AssociationId' },
  });
  const [found] = only(findings(digest([grant('X', acts, [])]), undefined, ref), 'X-4', 'action');
  assert.deepEqual(found.triggerActions.sort(), acts.slice().sort());
});

test('a deref that is not a re-pointing does not become one', () => {
  // Measured against the shipped table: 18 ec2 actions carry `deref:` and only three re-point a
  // binding. Eight REMOVE one, and the rest merely take an attachment id as an input -
  // ec2:CreateTransitGatewayMeteringPolicy names MiddleboxAttachmentIds and re-points nothing.
  // All eighteen are correctly unsafe for allow_only, which is what the flag was computed for.
  const acts = ['ec2:CreateTransitGatewayMeteringPolicy', 'ec2:DisassociateRouteTable',
                'ec2:DetachNetworkInterface'];
  const ref = reference({
    'ec2:CreateTransitGatewayMeteringPolicy': { types: ['transit-gateway'],
                                                refuse: 'deref:MiddleboxAttachmentIds' },
    'ec2:DisassociateRouteTable': { types: ['route-table'], refuse: 'deref:AssociationId' },
    'ec2:DetachNetworkInterface': { types: ['network-interface'], refuse: 'deref:AttachmentId' },
  });
  assert.deepEqual(only(findings(digest([grant('X', acts, [])]), undefined, ref), 'X-4', 'action'),
                   [], 'the rebinding rule fires on actions that rebind nothing');
});

test('X-2 keeps its named actions and gains the ones nobody named', () => {
  // The capability terms are added BESIDE the four names rather than replacing them. Removing the
  // names would make the rule depend entirely on a classification, and a service whose actions the
  // reference budget dropped would silently stop firing a rule that used to fire on a literal.
  const named = only(findings(digest([grant('X', ['ec2:CreateRoute'], [])])), 'X-2', 'action');
  assert.equal(named.length, 1, 'a rule that fired on a literal stopped firing');
  assert.deepEqual(named[0].triggerActions, ['ec2:CreateRoute']);
});

test('a rule may not name a capability that does not exist', () => {
  // Same reason a wildcard action is refused: it would not throw at match time, it would quietly
  // match nothing, forever.
  const bad = {
    schemaVersion: '0.1', sectionOrder: ['ESCALATION'], sort: {},
    rules: [{ ...RULES[0], predicate: { capability: 'rebnid' } }],
  };
  assert.throws(() => validate(bad), (e) => e instanceof RuleError && /rebnid/.test(e.message));
});

// ---- anyOf is a list of alternatives, and every one of them has to be reported -----------------
//
// It used to return the FIRST branch that hit. That was a defect on the decision path, not a
// cosmetic one: AmazonEC2FullAccess grants all five of the old X-3's actions, the card reported
// ec2:GetConsoleOutput alone, the 차단 dialog offered that alone, an approver denied it and the
// card went green - while ec2:CreateImage, a full copy of the disk, stayed granted. Seven of
// thirteen rules had the hole.

test('every branch that matched is reported, not the first', () => {
  const acts = ['ec2:CreateSnapshot', 'ec2:CreateImage'];
  const [found] = only(findings(digest([grant('AmazonEC2FullAccess', acts, [])])), 'X-5', 'action');
  assert.ok(found, 'the rule did not fire at all');
  assert.deepEqual(found.triggerActions.sort(), acts.slice().sort(),
                   'a granted action is missing from the trigger list, so the block dialog will '
                   + 'not offer it and the containment badge can go green while it stands');
});

test('a card offers everything that made it appear, so blocking it really blocks it', () => {
  // The end-to-end shape of the same defect, through the two functions that consume triggerActions.
  const acts = ['ec2:CreateSnapshot', 'ec2:CreateImage'];
  const [found] = only(findings(digest([grant('AmazonEC2FullAccess', acts, [])])), 'X-5', 'action');
  const offered = blockOffer(found).map((o) => o.action);
  assert.deepEqual(offered.sort(), acts.slice().sort());
  const denied = [{ policy: found.policyName, intent: 'deny_action', actions: offered }];
  assert.equal(containmentState(found, denied), 'full');
  // And denying only what the old code offered must NOT read as complete.
  const partial = [{ policy: found.policyName, intent: 'deny_action', actions: ['ec2:CreateSnapshot'] }];
  assert.equal(containmentState(found, partial), 'partial');
});

test('one branch needing co-location does not impose it on the alternatives', () => {
  // E-3 is anyOf[ UpdateFunctionCode, ReplaceIamInstanceProfileAssociation, allOf[Stop,Modify,Start] ].
  // Collecting every branch means several actions are reported, and the naive reading of that -
  // "several actions, so they must meet on one resource" - would downgrade a finding that a SINGLE
  // action already establishes. The branches are alternatives.
  const acts = ['lambda:UpdateFunctionCode', 'ec2:StopInstances', 'ec2:ModifyInstanceAttribute',
                'ec2:StartInstances'];
  const [mixed] = only(findings(digest([grant('Wide', acts, [])])), 'E-3', 'action');
  assert.ok(mixed.triggerActions.length > 1, 'the branches were not collected');
  assert.equal(mixed.status, 'CONFIRMED',
               'a rule one action satisfies was marked unverified for lacking co-location');

  // With ONLY the conjunction granted there is no atomic alternative, and the doubt is real again.
  const triple = acts.slice(1);
  const [conj] = only(findings(digest([grant('Triple', triple, [])])), 'E-3', 'action');
  assert.equal(conj.status, 'UNVERIFIED');
  assert.ok(conj.blockedBy.some((r) => r.includes('granted on named ARNs')));
});

// ---- one card, one mechanism --------------------------------------------------------------------

test('reading boot output and copying a disk are different findings', () => {
  // They were one rule, one grade and one sentence - "부팅 출력에 남은 구성값을 읽거나 볼륨 사본을
  // 생성할 수 있다" - printed whichever of the five actions fired. A grant holding only
  // ec2:GetConsoleOutput was told it could copy volumes, and was graded MEDIUM EXPOSURE for a read
  // that yields network topology and an account number.
  const acts = ['ec2:GetConsoleOutput', 'ec2:GetPasswordData', 'ec2:CreateImage'];
  const list = findings(digest([grant('AmazonEC2FullAccess', acts, [])]));
  const at = (id) => list.find((f) => f.id === id);

  assert.equal(at('R-2').category, 'RECON', 'reading boot output is filed as exposure');
  assert.equal(at('R-2').escalationGrade, 'LOW');
  assert.deepEqual(at('R-2').triggerActions, ['ec2:GetConsoleOutput']);
  // And it says what is actually in there, without claiming a credential is.
  assert.ok(at('R-2').narrative.includes('출력한 경우에만'),
            'the narrative asserts a credential is in the boot output');
  assert.ok(!at('R-2').narrative.includes('사본'), 'a boot-output read still narrates disk copies');

  assert.equal(at('X-3').escalationGrade, 'MEDIUM');
  assert.deepEqual(at('X-3').triggerActions, ['ec2:GetPasswordData']);
  assert.equal(at('X-5').category, 'EXPOSURE');
  assert.deepEqual(at('X-5').triggerActions, ['ec2:CreateImage']);
});

// ---- a connection is a claim about THIS account -------------------------------------------------

test('relatedTo is only shown for rules that actually fired on the same policy', () => {
  // The card printed "E-1 과 같은 정책에서 함께 성립합니다" whenever relatedTo was non-empty, so
  // R-1 said it on every policy carrying the four IAM reads - including ones where E-1 never
  // fired. R-1's own note asks for the conditional; nothing was applying it.
  const reads = ['iam:GetRole', 'iam:ListRoles', 'iam:ListAttachedRolePolicies'];
  const alone = digest([grant('Recon', [], [], { non_restrictable: reads })]);
  const [quiet] = only(findings(alone), 'R-1', 'action');
  assert.deepEqual(quiet.relatedTo, ['E-1'], 'the rule file still says what it connects to');
  assert.deepEqual(quiet.relatedFired, [], 'a connection was claimed to a rule that did not fire');

  const escalation = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:InvokeFunction'];
  const both = digest([grant('Recon', escalation, [], { non_restrictable: reads })]);
  const [linked] = only(findings(both), 'R-1', 'action');
  assert.deepEqual(linked.relatedFired, ['E-1']);
});

test('sharing a disk copy out of the account is its own rule, linked to making one', () => {
  // The other half of X-5, and the half that leaves. Making a copy keeps the data inside the
  // account; sharing it does not, and un-sharing does not recall what the recipient already
  // copied. It is graded above X-5 for that irreversibility rather than for being harder.
  const share = ['ec2:ModifySnapshotAttribute', 'ec2:ModifyImageAttribute'];
  const [alone] = only(findings(digest([grant('P', share, [])])), 'X-6', 'action');
  assert.ok(alone, 'sharing a snapshot externally fires no rule');
  assert.equal(alone.escalationGrade, 'HIGH');
  assert.deepEqual(alone.triggerActions.sort(), share.slice().sort());
  // Nothing to link to: the grant cannot make a copy, so the chain is not here.
  assert.deepEqual(alone.relatedFired, []);

  // Both halves in one policy: each card points at the other, and only then.
  const both = ['ec2:CreateSnapshot', ...share];
  const list = findings(digest([grant('AmazonEC2FullAccess', both, [])]));
  const at = (id) => list.find((f) => f.id === id);
  assert.deepEqual(at('X-6').relatedFired, ['X-5']);
  assert.deepEqual(at('X-5').relatedFired, ['X-6'], 'the link is one-directional');
});

test('replacing the root volume succeeds to the role without stopping anything', () => {
  // ec2:CreateReplaceRootVolumeTask. The instance keeps its id, addresses, interfaces, role and
  // elastic IP while the whole operating system is swapped, so it is E-3's own narrative reached by
  // one call - not the Stop/Modify/Start triple, and not a lambda code push.
  //
  // Verified against the current request model rather than taken on trust: it accepts VolumeId,
  // documented as "the ID of the volume to use as the replacement root volume", constrained only to
  // the same availability zone, the available state, and matching encryption. The catalogue that
  // named this path asserted arbitrary volume injection was impossible; AWS widened the API since.
  const action = 'ec2:CreateReplaceRootVolumeTask';
  const [found] = only(findings(digest([grant('AmazonEC2FullAccess', [action], [])])),
                       'E-3', 'action');
  assert.ok(found, 'root volume replacement fires no escalation rule');
  assert.equal(found.escalationGrade, 'HIGH');
  assert.deepEqual(found.triggerActions, [action]);
  // A single-action branch, so no co-location doubt is imposed on it.
  assert.equal(found.status, 'CONFIRMED');
});

test('severing a shared network path is graded above deleting one resource', () => {
  // Removing a gateway, an attachment or a route table cuts everything behind it. The rule named
  // only DeleteVpc and DeleteSubnet, at LOW, so an approver reading it was told the widest
  // availability action in the service was the mildest kind of finding.
  const severing = ['ec2:DetachInternetGateway', 'ec2:DeleteNatGateway',
                    'ec2:DeleteTransitGatewayVpcAttachment'];
  const [found] = only(findings(digest([grant('AmazonEC2FullAccess', severing, [])])),
                       'D-4', 'action');
  assert.ok(found, 'cutting a shared path fires nothing');
  assert.equal(found.escalationGrade, 'MEDIUM');
  assert.deepEqual(found.triggerActions.sort(), severing.slice().sort(),
                   'the trigger list is short, so the block dialog will not offer them all');
});

// ---- a finding whose subject is not a reach -----------------------------------------------------

test('a cost finding attaches no resources, because a bill is not bounded by them', () => {
  // Measured on a real plan. ec2:RunInstances names eighteen resource types, so the resource axis
  // dutifully produced "이 비용 경로가 이 키페어 2개에 닿는다" - a card answering a question nobody
  // asked with resources that have nothing to do with the answer.
  const acts = ['ec2:RunInstances', 'ec2:RequestSpotFleet'];
  const withUnits = digest([grant('AmazonEC2FullAccess', acts, [
    unit('ec2:key-pair', acts, acts), unit('ec2:subnet', acts, acts),
  ])]);
  assert.deepEqual(only(findings(withUnits), 'C-1'), [],
                   'a cost path was attached to the key pairs it happens to name');
  const [capability] = only(findings(withUnits), 'C-1', 'action');
  assert.ok(capability, 'the cost finding is gone entirely');
  assert.deepEqual(capability.targets, []);
});

test('a rule may not name an axis that does not exist', () => {
  const bad = {
    schemaVersion: '0.1', sectionOrder: ['ESCALATION'], sort: {},
    rules: [{ ...RULES[0], axes: ['resource', 'everything'] }],
  };
  assert.throws(() => validate(bad), (e) => e instanceof RuleError && /axes must be/.test(e.message));
});

test('the enumeration-incomplete count is about enumerations', () => {
  // The cards suppress the warning on an action-axis finding because it made no list; the metric
  // did not, so a plan whose capability half held 13 findings reported "열거 미확인 13" - a doubt
  // about a list none of them ever had.
  const acts = ['ec2:CreateSnapshot', 'ec2:CreateImage'];
  const d = digest([grant('AmazonEC2FullAccess', acts, [])]);
  const list = findings(d);
  assert.ok(list.length > 0 && list.every((f) => f.axis === 'action'), 'fixture has a resource axis');
  assert.equal(summary(list).enumerationIncomplete, 0,
               'capability findings are counted as incomplete enumerations');
});

test('a function is taken over without passing any role', () => {
  // The thing that makes Lambda different from EC2, and the reason a governance model built on the
  // iam:PassRole edge alone misses it entirely. UpdateFunctionCode's request carries no role member
  // at all - the target function's existing execution role is inherited - so nothing about this
  // path involves passing anything. UpdateFunctionConfiguration is the same escalation by another
  // door: leave the code alone and move the layers, handler or runtime.
  for (const action of ['lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration']) {
    const d = digest([grant('AWSLambda_FullAccess', [action], [unit('lambda:function', [action], [action])])]);
    const [found] = only(findings(d), 'E-3', 'resource');
    assert.ok(found, `${action} reaches no takeover finding`);
    assert.equal(found.escalationGrade, 'HIGH');
  }
});

test('an event source mapping is a wake-up call, and starting a machine is both at once', () => {
  // Both were silent. E-1 required one of four invoke-shaped actions beside CreateFunction, and a
  // mapping is none of them - yet its poller calls the new function under the passed role by
  // itself, repeatedly, with no invoke permission anywhere in the grant. RunMicrovm is the other
  // shape: its request carries executionRoleArn AND starts the thing, so demanding a separate
  // wake-up action would have excluded the most direct path of all.
  const mapping = ['iam:PassRole', 'lambda:CreateFunction', 'lambda:CreateEventSourceMapping'];
  assert.ok(only(findings(digest([grant('P', mapping, [unit('lambda:function', mapping, mapping)])])), 'E-1').length,
            'passing a role to a function woken by a queue reaches no finding');
  const microvm = ['iam:PassRole', 'lambda:RunMicrovm'];
  assert.ok(only(findings(digest([grant('P', microvm, [unit('lambda:function', microvm, microvm)])])), 'E-1').length,
            'passing a role into a started execution environment reaches no finding');
});

test('re-pointing an alias is a rebinding, not a code change', () => {
  // It belongs to X-4 and not to E-3, and the distinction is not cosmetic: UpdateAlias replaces
  // neither code nor boot configuration - it writes the alias's own version field - so E-3's
  // sentence would be false on the card that printed it. The capability cannot be derived either;
  // the request names the function and the alias rather than resolving an association id, so it
  // fails the deref: test and only the curated entry reaches it.
  const acts = ['lambda:UpdateAlias', 'lambda:UpdateEventSourceMapping'];
  const d = digest([grant('P', acts, [unit('lambda:function', acts, acts)])]);
  const [found] = only(findings(d), 'X-4', 'resource');
  assert.ok(found, 'neither re-pointing reaches the rebinding finding');
  assert.deepEqual(found.triggerActions, acts);
  assert.deepEqual(only(findings(d), 'E-3'), [], 'a rebinding was reported as a code replacement');
});

test('a guardrail can be rewritten to pass instead of switched off', () => {
  // Four names reach one control. Deleting the attachment is the obvious one; rewriting the config
  // while it stays attached is the one a check that only asks "is signing enforced" never sees.
  // The account-wide public-access switch is the same shape - it refuses nothing itself and is the
  // reason a later AddPermission with a wildcard principal succeeds.
  for (const action of ['lambda:DeleteFunctionCodeSigningConfig', 'lambda:UpdateCodeSigningConfig',
    'lambda:PutFunctionCodeSigningConfig', 'lambda:PutPublicAccessBlockConfig']) {
    const d = digest([grant('P', [action], [unit('lambda:function', [action], [action])])]);
    assert.ok(only(findings(d), 'V-2').length, `${action} reaches no guardrail finding`);
  }
});

test('stopping a function without deleting it is its own finding', () => {
  // D-5 leaves evidence: the function is gone. These seven leave the function sitting there looking
  // healthy while nothing arrives, which is why they are graded and worded apart from it.
  const acts = ['lambda:RemovePermission', 'lambda:DeleteEventSourceMapping', 'lambda:DeleteAlias'];
  const d = digest([grant('P', acts, [unit('lambda:function', acts, acts)])]);
  const [found] = only(findings(d), 'D-6', 'resource');
  assert.ok(found, 'severing every path into a function reaches no finding');
  assert.deepEqual(only(findings(d), 'D-5'), [], 'D-5 fired without a delete action');
});

test('reading a function configuration is reading its secrets', () => {
  // The response carries the environment variables in plaintext on every call, so this is X-3's
  // shape - a read whose response IS the material - rather than R-2's, where the content is
  // incidental. The list forms take no target and answer for every function at once.
  const acts = ['lambda:ListFunctions'];
  const d = digest([grant('P', acts, [unit('lambda:function', acts, acts)])]);
  const [found] = only(findings(d), 'X-8', 'resource');
  assert.ok(found, 'a targetless read of every environment variable reaches no finding');
  assert.equal(found.escalationGrade, 'MEDIUM');
});

test('a session onto a running execution environment needs no role passed', () => {
  // E-4's separation from E-3: nothing is replaced and nothing is configured. The token attaches to
  // something already running, and if that thing carries an execution role the session carries it.
  for (const action of ['lambda:CreateMicrovmAuthToken', 'lambda:CreateMicrovmShellAuthToken']) {
    const d = digest([grant('P', [action], [unit('lambda:function', [action], [action])])]);
    const [found] = only(findings(d), 'E-4', 'resource');
    assert.ok(found, `${action} reaches no session finding`);
    assert.equal(found.escalationGrade, 'HIGH');
  }
});

test('revoking a policy is never offered as a way to share one', () => {
  // A live false positive rather than a gap. The reference gives RemovePermission and
  // DeleteResourcePolicy access level 'Permissions management' on a non-principal type, which
  // derives share-external - so an action whose whole effect is to DELETE a policy was classified
  // as one that opens contents to an outside principal, and candidatePaths lists share-external in
  // the exfiltrate edge. The curated entries override the derivation in the right direction.
  for (const action of ['lambda:RemovePermission', 'lambda:DeleteResourcePolicy',
    'lambda:RemoveLayerVersionPermission']) {
    const { caps, source } = capabilitiesOf(action);
    assert.equal(source, 'curated', `${action} is left to the derivation`);
    assert.deepEqual(caps, ['delete'], `${action} is classified as a share`);
  }
  // And the three that genuinely do open a resource keep saying so.
  for (const action of ['lambda:AddPermission', 'lambda:PutResourcePolicy',
    'lambda:AddLayerVersionPermission']) {
    assert.ok(capabilitiesOf(action).caps.includes('share-external'), action);
  }
});

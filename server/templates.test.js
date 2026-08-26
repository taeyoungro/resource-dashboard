// That a template is a pre-filled form and never a policy nobody approved.
//
// The two properties worth pinning are the ones that would make it the other thing: what it may
// contain (only what says something without an inventory, so it means the same in every account),
// and what happens to a row this account cannot honour (dropped and NAMED, never silently).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  TemplateError, loadTemplates, mergeTemplate, seedFromTemplate, validateTemplate,
} from './templates.js';

const SHIPPED = JSON.parse(
  readFileSync(new URL('./restriction-templates.json', import.meta.url), 'utf8'),
);

const policy = (identifier, actions, over = {}) => ({
  identifier,
  source: 'aws_managed',
  default_version_id: 'v1',
  is_baseline: false,
  restrictable: true,
  unreadable: null,
  actions_granted: actions,
  actions_offerable: actions,
  actions_non_restrictable: [],
  affected: [],
  ...over,
});

const assessment = (policies, over = {}) => ({
  account_id: '718100330247',
  protected_actions: ['iam:CreateRole'],
  policies,
  action_reference: { services: {} },
  ...over,
});

test('the shipped file loads and every template in it is valid', () => {
  const list = loadTemplates(SHIPPED);
  assert.ok(list.length >= 3, 'the shipped set shrank');
  // Every template must say WHY in a sentence an approver reads before agreeing, because that is
  // the whole substitute for the conversation a hand-written restriction would have had.
  for (const template of list) assert.ok(template.why.length > 20, template.id);
});

test('a template may only carry what means the same thing in every account', () => {
  // allow_only and deny_only name ARNs, and an ARN is an account fact. A template carrying one
  // would either name a resource that does not exist in the account being approved or would have
  // to be rewritten per account, which is not a template.
  for (const intent of ['allow_only', 'deny_only']) {
    assert.throws(
      () => validateTemplate({ id: 't', title: 't', why: 'w',
                               restrictions: [{ intent, actions: ['s3:GetObject'] }] }),
      TemplateError, intent,
    );
  }
  // A wildcard would resolve differently in every account, so what the template SAYS would depend
  // on where it landed - and an approver has to read exactly what they are agreeing to.
  assert.throws(
    () => validateTemplate({ id: 't', title: 't', why: 'w',
                             restrictions: [{ intent: 'deny_action', actions: ['s3:*'] }] }),
    /never with a wildcard/,
  );
  // And the condition intents need their condition.
  assert.throws(
    () => validateTemplate({ id: 't', title: 't', why: 'w',
                             restrictions: [{ intent: 'tag_condition', actions: ['s3:GetObject'] }] }),
    /tag_key and tag_values/,
  );
});

test('seeding binds each action to the policies that actually grant it', () => {
  // The binding is per plan and cannot be otherwise: a template is written once, for an
  // organisation, and cannot know which attached policy grants what in this account.
  const template = SHIPPED.templates.find((t) => t.id === 'no-audit-tampering');
  const { restrictions, dropped } = seedFromTemplate(template, assessment([
    policy('arn:aws:iam::aws:policy/A', ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail']),
    policy('arn:aws:iam::aws:policy/B', ['cloudtrail:StopLogging']),
  ]));
  // One restriction per (policy, action) - the shape the editor and the writer already use, so a
  // seeded row is indistinguishable from one an approver ticked.
  const pairs = restrictions.map((r) => `${r.policy.split('/').pop()} ${r.actions[0]}`).sort();
  assert.deepEqual(pairs, ['A cloudtrail:DeleteTrail', 'A cloudtrail:StopLogging',
                           'B cloudtrail:StopLogging']);
  assert.ok(restrictions.every((r) => r.intent === 'deny_action' && r.actions.length === 1));
  // The three nobody grants are reported, not removed in silence.
  assert.deepEqual(dropped.map((d) => d.action).sort(),
                   ['config:DeleteConfigurationRecorder', 'config:StopConfigurationRecorder',
                    'guardduty:DeleteDetector']);
  assert.ok(dropped.every((d) => d.why === 'not_granted'));
});

test('a protected action is dropped by name, and so is a dead tag condition', () => {
  const withProtected = seedFromTemplate(
    { id: 't', title: 't', why: 'w'.repeat(30),
      restrictions: [{ intent: 'deny_action', actions: ['iam:CreateRole', 's3:GetObject'] }] },
    assessment([policy('arn:aws:iam::aws:policy/A', ['iam:CreateRole', 's3:GetObject'])]),
  );
  assert.deepEqual(withProtected.restrictions.map((r) => r.actions[0]), ['s3:GetObject']);
  assert.deepEqual(withProtected.dropped, [{ action: 'iam:CreateRole', why: 'protected' }]);

  // A tag condition on an action AWS reads no resource tag for is recorded and never evaluated,
  // and the decision route refuses it. Dropped here so a template cannot compose a decision that
  // is refused at submit time, after the approver believed it applied.
  const dead = seedFromTemplate(
    { id: 't', title: 't', why: 'w'.repeat(30),
      restrictions: [{ intent: 'tag_condition', actions: ['iam:AttachGroupPolicy'],
                       tag_key: 'env', tag_values: ['prod'] }] },
    assessment([policy('arn:aws:iam::aws:policy/A', ['iam:AttachGroupPolicy'])],
               { action_reference: { services: {}, no_resource_tag: ['iam:AttachGroupPolicy'] } }),
  );
  assert.deepEqual(dead.restrictions, []);
  assert.deepEqual(dead.dropped, [{ action: 'iam:AttachGroupPolicy', why: 'no_resource_tag' }]);
});

test('a template defaults to the closed form, and says so on the wire', () => {
  // A template is written once and read on every plan, so the form that fails safe is the one to
  // default to - and the operator travels explicitly rather than relying on a parse default,
  // because a stored tag decision with no operator means the OPEN form.
  const { restrictions } = seedFromTemplate(
    { id: 't', title: 't', why: 'w'.repeat(30),
      restrictions: [{ intent: 'tag_condition', actions: ['s3:PutBucketPolicy'],
                       tag_key: 'Environment', tag_values: ['production'] }] },
    assessment([policy('arn:aws:iam::aws:policy/A', ['s3:PutBucketPolicy'])]),
  );
  assert.equal(restrictions[0].condition_operator, 'StringNotEquals');
  assert.deepEqual(restrictions[0].tag_values, ['production']);
});

test('an unreadable or unrestrictable policy is never bound to', () => {
  const { restrictions, dropped } = seedFromTemplate(
    { id: 't', title: 't', why: 'w'.repeat(30),
      restrictions: [{ intent: 'deny_action', actions: ['s3:GetObject'] }] },
    assessment([
      policy('arn:aws:iam::aws:policy/A', ['s3:GetObject'], { restrictable: false }),
      policy('arn:aws:iam::aws:policy/B', ['s3:GetObject'], { unreadable: 'AccessDenied' }),
    ]),
  );
  assert.deepEqual(restrictions, []);
  assert.deepEqual(dropped, [{ action: 's3:GetObject', why: 'not_granted' }]);
});

test('applying a template replaces an earlier decision on the same action, never appends', () => {
  // The editor's own rule is one action, one section. An appended duplicate would be the
  // contradiction that rule exists to prevent - the same semantics as the block dialog's merge.
  const existing = [
    { policy: 'A', intent: 'allow_only', actions: ['s3:GetObject'], resources: ['arn:aws:s3:::b'] },
    { policy: 'A', intent: 'deny_only', actions: ['s3:PutObject'], resources: ['arn:aws:s3:::b'] },
  ];
  const seeded = [{ policy: 'A', intent: 'deny_action', actions: ['s3:GetObject'] }];
  const merged = mergeTemplate(existing, seeded);
  assert.equal(merged.filter((r) => r.actions.includes('s3:GetObject')).length, 1);
  assert.equal(merged.find((r) => r.actions.includes('s3:GetObject')).intent, 'deny_action');
  // Untouched decisions survive.
  assert.ok(merged.some((r) => r.intent === 'deny_only' && r.actions[0] === 's3:PutObject'));
  // And a row emptied by the replacement is removed rather than left with no actions - the route
  // refuses a restriction with an empty action list.
  const emptied = mergeTemplate(
    [{ policy: 'A', intent: 'allow_only', actions: ['s3:GetObject'], resources: [] }], seeded);
  assert.equal(emptied.length, 1);
  assert.equal(emptied[0].intent, 'deny_action');
});

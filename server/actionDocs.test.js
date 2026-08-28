// Action names on a finding card link to AWS's own page for the action.
//
// The risk is one-sided and it is not "no link": it is a link that 404s. An approver who clicks one
// dead link stops clicking the live ones, and the live ones are the point. So a service this table
// does not carry, and an action that gates rather than names an operation, both render as plain
// text - and this pins that they do.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACTION_DOC_OVERRIDES, API_REFERENCES, actionDocUrl } from './actionDocs.js';
import { RULE_ACTIONS } from './rules.js';
import { CURATED } from './capabilities.js';

test('the reported pair resolve to the pages the request named', () => {
  assert.equal(actionDocUrl('lambda:UpdateFunctionCode'),
    'https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionCode.html');
  assert.equal(actionDocUrl('lambda:UpdateFunctionConfiguration'),
    'https://docs.aws.amazon.com/lambda/latest/api/API_UpdateFunctionConfiguration.html');
});

test('an action that gates rather than names an operation has no page', () => {
  // iam:PassRole is evaluated while another service creates a resource; it is not an API call and
  // there is nothing to open. The same is true of the other four in the override table, and each
  // of them appears on real cards - E-1 prints iam:PassRole every time it fires.
  for (const action of ['iam:PassRole', 'lambda:InvokeFunctionUrl', 's3:GetObjectVersion',
    'dynamodb:PartiQLSelect', 'states:RevealSecrets']) {
    assert.equal(actionDocUrl(action), null, action);
  }
});

test('an action whose page is spelled differently goes to the right page', () => {
  // IAM says InvokeFunction; the operation and its page are Invoke.
  assert.equal(actionDocUrl('lambda:InvokeFunction'),
    'https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html');
  // Lambda splits its newer surfaces into separate references under the same product.
  assert.equal(actionDocUrl('lambda:RunMicrovm'),
    'https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html');
  assert.equal(actionDocUrl('lambda:CreateMicrovmShellAuthToken'),
    'https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmShellAuthToken.html');
  assert.equal(actionDocUrl('lambda:CreateNetworkConnector'),
    'https://docs.aws.amazon.com/lambda/latest/lambda-core/API_CreateNetworkConnector.html');
  // And a plain lambda action is not dragged into either of them.
  assert.equal(actionDocUrl('lambda:DeleteFunction'),
    'https://docs.aws.amazon.com/lambda/latest/api/API_DeleteFunction.html');
});

test('an unknown service is null, never a guessed URL', () => {
  assert.equal(actionDocUrl('quantum:Entangle'), null);
  assert.equal(actionDocUrl('lambda:*'), null, 'a wildcard is not an action');
  assert.equal(actionDocUrl('lambda:'), null);
  assert.equal(actionDocUrl('nocolon'), null);
  assert.equal(actionDocUrl(''), null);
});

test('every link is an https docs.aws.amazon.com URL with the action substituted', () => {
  // The name goes into a URL, so the shape of what it goes into is worth pinning: a template that
  // lost its placeholder would send every action of that service to one page.
  for (const [service, template] of Object.entries(API_REFERENCES)) {
    assert.ok(template.startsWith('https://docs.aws.amazon.com/'), service);
    assert.ok(template.includes('{Action}'), `${service} template has no {Action}`);
    assert.ok(template.endsWith('.html'), service);
  }
  for (const [action, url] of Object.entries(ACTION_DOC_OVERRIDES)) {
    if (url === null) continue;
    assert.ok(url.startsWith('https://docs.aws.amazon.com/'), action);
    assert.ok(!url.includes('{Action}'), `${action} override was not substituted`);
  }
});

test('every action a rule can print is decided rather than left to chance', () => {
  // The set that actually reaches a card: what a predicate names, and what the capability table
  // classifies. Each one either resolves to a page or is in the override table saying why it has
  // none. An action reaching neither means a service was added to the rules without deciding what
  // its name should link to - which would ship a dead link rather than no link.
  const printable = [...new Set([...RULE_ACTIONS, ...Object.keys(CURATED)])].sort();
  const undecided = printable.filter(
    (a) => actionDocUrl(a) === null && !(a in ACTION_DOC_OVERRIDES),
  );
  assert.deepEqual(undecided, [],
    'these actions print on cards and neither link nor are recorded as having no page');
});

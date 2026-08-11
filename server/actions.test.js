// The action catalogue: what it accepts, what it refuses, and that a bad file cannot stop the server.
//
// The last one is the point of most of this file. The catalogue is an input aid - the decision route
// and the inline writer both check every chosen action independently - so a typo in a convenience
// file must degrade the screen to a text box rather than take the approval path down with it.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCESS_LEVELS, CATALOGUE_PATH, load, parse } from './actions.js';

const silent = { info: () => {}, warn: () => {} };

function doc(overrides = {}) {
  return JSON.stringify({
    schema: 1,
    services: {
      sqs: {
        label: 'Amazon SQS',
        actions: [
          { action: 'sqs:SendMessage', access: 'Write', resource: 'queue' },
          { action: 'sqs:ListQueues', access: 'List', resource: '*' },
        ],
      },
    },
    ...overrides,
  });
}

test('the shipped file parses, and it covers sqs', () => {
  // Read from disk rather than a fixture: a file that does not parse ships a screen with no list on
  // it, and nothing else in this suite would notice.
  const catalogue = load({ log: silent });
  assert.equal(catalogue.all().error, null);
  assert.deepEqual(catalogue.covered(), ['sqs']);
  assert.ok(catalogue.size() >= 15, `only ${catalogue.size()} actions`);
});

test('every shipped action belongs to the service it is listed under', () => {
  for (const [service, body] of Object.entries(load({ log: silent }).all().services)) {
    for (const entry of body.actions) {
      assert.ok(entry.action.startsWith(`${service}:`), `${entry.action} under ${service}`);
      assert.ok(ACCESS_LEVELS.includes(entry.access), `${entry.action}: ${entry.access}`);
    }
  }
});

test('an action that names no resource is marked account level', () => {
  // generator/restriction.py refuses these for an allow_only restriction, because a NotResource list
  // can never contain "*" - the statement would deny the action outright rather than narrow it. The
  // screen greys them out for that intent, and this flag is what it reads.
  const sqs = load({ log: silent }).forService('sqs');
  const list = sqs.find((a) => a.action === 'sqs:ListQueues');
  assert.equal(list.account_level, true);
  const send = sqs.find((a) => a.action === 'sqs:SendMessage');
  assert.equal(send.account_level, false);
});

test('actions come back sorted, so the screen order is not the file order', () => {
  // localeCompare, not the default sort. The default compares UTF-16 code units, where T is below s,
  // so it would put sqs:ListQueueTags before sqs:ListQueues - correct for a machine and wrong for the
  // person reading the list.
  const names = load({ log: silent }).forService('sqs').map((a) => a.action);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.ok(names.indexOf('sqs:ListQueues') < names.indexOf('sqs:ListQueueTags'));
});

test('a service the file does not cover answers empty rather than throwing', () => {
  // The screen keeps a text box for these. An uncovered service has to stay restrictable.
  assert.deepEqual(load({ log: silent }).forService('s3'), []);
  assert.deepEqual(load({ log: silent }).forService('nonsense'), []);
});

test('a schema this server does not know is refused', () => {
  assert.throws(() => parse(doc({ schema: 2 })), /schema is 2/);
});

test('an action listed under the wrong service is refused', () => {
  // Otherwise it renders under the wrong heading, which nobody would notice.
  const wrong = JSON.stringify({
    schema: 1,
    services: { sqs: { actions: [{ action: 's3:GetObject', access: 'Read', resource: 'bucket' }] } },
  });
  assert.throws(() => parse(wrong), /listed under sqs/);
});

test('an unknown access level is refused', () => {
  // A typo here lands the action in a group the screen never renders, so it silently disappears.
  const wrong = JSON.stringify({
    schema: 1,
    services: { sqs: { actions: [{ action: 'sqs:SendMessage', access: 'Writes' }] } },
  });
  assert.throws(() => parse(wrong), /access "Writes"/);
});

test('a duplicated action is refused', () => {
  const wrong = JSON.stringify({
    schema: 1,
    services: {
      sqs: {
        actions: [
          { action: 'sqs:SendMessage', access: 'Write' },
          { action: 'sqs:SendMessage', access: 'Read' },
        ],
      },
    },
  });
  assert.throws(() => parse(wrong), /listed twice/);
});

test('a name that is not an action name is refused', () => {
  for (const action of ['sendmessage', 'sqs:', ':SendMessage', 'sqs:Send Message', 42, null]) {
    const wrong = JSON.stringify({
      schema: 1,
      services: { sqs: { actions: [{ action, access: 'Write' }] } },
    });
    assert.throws(() => parse(wrong), Error, `accepted ${JSON.stringify(action)}`);
  }
});

test('a service with no actions is refused', () => {
  assert.throws(() => parse(JSON.stringify({ schema: 1, services: { sqs: { actions: [] } } })),
                /no actions/);
});

test('a file that cannot be read leaves the catalogue empty and the server running', () => {
  // The whole reason load() does not throw. An approval path that stops because a convenience file
  // has a typo would be a worse system than one that asks somebody to type an action.
  const warnings = [];
  const catalogue = load({
    path: '/nonexistent/aws-actions.json',
    log: { info: () => {}, warn: (...a) => warnings.push(a.join(' ')) },
  });
  assert.deepEqual(catalogue.covered(), []);
  assert.equal(catalogue.size(), 0);
  assert.ok(catalogue.all().error, 'the reason has to travel to the page');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /falls back to a typed action/);
});

test('the path points inside the server directory', () => {
  // Read from disk at startup, so it has to ship with the code rather than be somewhere deployment
  // has to remember to create.
  assert.match(CATALOGUE_PATH, /server\/data\/aws-actions\.json$/);
});

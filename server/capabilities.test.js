// The curated capability table, against the mistakes that make an entry do nothing.
//
// Everything else about this table is exercised through findings.test.js, which is the right place:
// a capability matters when a rule fires on it. What cannot be caught there is an entry that is
// silently not in the table at all - the rule simply does not fire, which looks identical to the
// rule being wrong.
//
//     npm run check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CAP, CURATED, capabilitiesOf } from './capabilities.js';

test('no curated action is written twice', () => {
  // Two entries for one key is not an error in JavaScript - the later one wins and the earlier one
  // vanishes - so a curation can look present in the file and do nothing. It has happened twice:
  // ecs:StartTask was given run-as-role beside ecs:RunTask while an older [invoke] entry further
  // down kept overriding it, and lambda:GetFunction lost the read-secret added for X-8 the same
  // way. The symptom both times was a rule that should have fired and did not, with the reason
  // sitting in plain sight in the table.
  //
  // Read from the SOURCE, because the imported object has already collapsed them.
  const text = readFileSync(new URL('./capabilities.js', import.meta.url), 'utf8');
  const keys = [...text.matchAll(/^ {2}'([a-z0-9-]+:[A-Za-z0-9]+)':/gm)].map((m) => m[1]);
  assert.ok(keys.length > 250,
            `only ${keys.length} entries matched, so the scan is not reading the table`);
  const seen = new Set();
  const twice = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
  assert.deepEqual([...new Set(twice)].sort(), [],
                   'these actions are curated twice - the later entry silently wins');
});

test('every curated capability is one the vocabulary defines', () => {
  // The closed vocabulary is what rules.js validates predicates against, so a capability spelled
  // only here would be reachable by no rule and would look like a classification that exists.
  const vocabulary = new Set(Object.values(CAP));
  for (const [action, caps] of Object.entries(CURATED)) {
    assert.ok(Array.isArray(caps) && caps.length > 0, `${action} carries no capability`);
    for (const cap of caps) {
      assert.ok(vocabulary.has(cap), `${action} carries ${cap}, which is not in CAP`);
    }
    assert.equal(new Set(caps).size, caps.length, `${action} names a capability twice`);
  }
});

test('the launch actions that complete a role-passing escalation carry run-as-role', () => {
  // The bar, restated where it can fail: one call names a role AND starts arbitrary code under it.
  // The request models are the evidence - ecs:RunTask and ecs:StartTask carry
  // overrides.taskRoleArn with overrides.containerOverrides[].command, ec2:RunInstances carries
  // IamInstanceProfile with UserData, lambda:RunMicrovm carries executionRoleArn and starts.
  for (const action of ['ecs:RunTask', 'ecs:StartTask', 'ec2:RunInstances', 'lambda:RunMicrovm']) {
    assert.ok(capabilitiesOf(action).caps.includes(CAP.RUN_AS_ROLE), action);
  }
  // Defining a workload is not running one. These need something else to wake them, and E-1 names
  // that pairing per service rather than through the capability.
  for (const action of ['ecs:RegisterTaskDefinition', 'lambda:CreateFunction']) {
    assert.ok(!capabilitiesOf(action).caps.includes(CAP.RUN_AS_ROLE), action);
  }
  // And the gate is not the launch: a rule asking for both must not be satisfiable by one action.
  assert.ok(!capabilitiesOf('iam:PassRole').caps.includes(CAP.RUN_AS_ROLE));
});

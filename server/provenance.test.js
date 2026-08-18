// Where a resource came from, and the row that used to print two hundred characters to say it.
//
//     npm run check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { provenance, remainingTags } from './provenance.js';

const STACK = {
  'aws:cloudformation:logical-id': 'InspectorLogGroup',
  'aws:cloudformation:stack-id':
    'arn:aws:cloudformation:us-east-1:718100330247:stack/opt-stack-ecs-runtime/'
    + 'eb4deb10-9623-11f1-b69a-0affc8320de1',
  'aws:cloudformation:stack-name': 'opt-stack-ecs-runtime',
};

const MEMBER = {
  'aws:cloudformation:logical-id': 'IamRoleEventRule',
  'aws:cloudformation:stack-id':
    'arn:aws:cloudformation:us-east-1:718100330247:stack/'
    + 'StackSet-event-ingestion-71897b43-633f-48a8-ad26-04c214adb8e2/'
    + '45e12990-9645-11f1-846d-0ed6c0a24375',
  'aws:cloudformation:stack-name': 'StackSet-event-ingestion-71897b43-633f-48a8-ad26-04c214adb8e2',
};

test('a stack-managed resource names its stack', () => {
  assert.deepEqual(provenance(STACK), { kind: 'stack', name: 'opt-stack-ecs-runtime' });
});

test('a stack set member names the SET, not the member stack', () => {
  // The tags name the member stack - StackSet-event-ingestion-<uuid> - and that name is an
  // implementation detail nobody administers. The stack set is what somebody deployed.
  assert.deepEqual(provenance(MEMBER), { kind: 'stackset', name: 'event-ingestion' });
});

test('the uuid is matched as a uuid, not as "after the last hyphen"', () => {
  // A set called event-ingestion and one called event produce member stack names that differ only
  // in a hyphen. Cutting at the last hyphen names the wrong set for both.
  const one = provenance({ 'aws:cloudformation:stack-name':
    'StackSet-event-71897b43-633f-48a8-ad26-04c214adb8e2' });
  assert.deepEqual(one, { kind: 'stackset', name: 'event' });
  // A stack a person happened to call StackSet-something is a stack: no uuid, no match.
  assert.deepEqual(provenance({ 'aws:cloudformation:stack-name': 'StackSet-mine' }),
                   { kind: 'stack', name: 'StackSet-mine' });
});

test('no CloudFormation tags means it was not made by CloudFormation', () => {
  // 'manual' rather than 'unknown', and the difference matters: CloudFormation tags everything it
  // creates, so absence is a fact about the resource. The pipeline's own mirror roles are
  // terraform's and land here correctly.
  assert.deepEqual(provenance({ env: 'prod' }), { kind: 'manual', name: null });
  assert.deepEqual(provenance({}), { kind: 'manual', name: null });
  assert.deepEqual(provenance(null), { kind: 'manual', name: null });
  assert.deepEqual(provenance(undefined), { kind: 'manual', name: null });
});

test('the stack id alone is enough, so one missing tag is not "made by hand"', () => {
  const { 'aws:cloudformation:stack-name': _dropped, ...rest } = STACK;
  assert.deepEqual(provenance(rest), { kind: 'stack', name: 'opt-stack-ecs-runtime' });
});

test('the three CloudFormation tags are consumed, and everything else still shows', () => {
  assert.deepEqual(remainingTags({ ...STACK, env: 'prod', owner: 'platform' }),
                   { env: 'prod', owner: 'platform' });
  assert.deepEqual(remainingTags(STACK), {});
});

test('the row shows the summary and not the raw tags it was made from', () => {
  // The regression this guards is a one-word edit: rendering resource.tags again puts the two
  // hundred characters back, and the summary beside them makes it worse rather than better.
  const source = readFileSync(new URL('../src/components/Impact.tsx', import.meta.url), 'utf8');
  assert.match(source, /배포: /, 'the row no longer says where the resource came from');
  assert.match(source, /remainingTags\(resource\.tags\)/,
               'the row is not filtering the CloudFormation tags out of the tag list');
  assert.ok(!/Object\.entries\(resource\.tags\)/.test(source),
            'the raw tag bag is being printed again');
});

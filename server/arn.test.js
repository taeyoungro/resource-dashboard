// The ARN reader: names out of the shapes Resource Explorer actually inventories, null for
// anything else - and never an empty name, because the page falls back to the raw string on null
// and an empty name would render as nothing.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArn, resourceId } from './arn.js';
import { idOf } from './graph.js';

test('the shapes the assessment actually carries', () => {
  for (const [arn, expected] of [
    ['arn:aws:lambda:us-east-1:718100330247:function:testLambda',
      { service: 'lambda', region: 'us-east-1', account: '718100330247',
        name: 'testLambda', qualifier: null }],
    // The fifteen-stacks case that motivated this file: the name is the identity, the uuid is
    // console furniture.
    ['arn:aws:cloudformation:us-east-1:718100330247:stack/opt-stack-event-queue/644582c0-9616-11f1-8c51-0ef01c253109',
      { service: 'cloudformation', region: 'us-east-1', account: '718100330247',
        name: 'opt-stack-event-queue', qualifier: '644582c0-9616-11f1-8c51-0ef01c253109' }],
    // A KMS key's name IS a uuid. Splitting it as a qualifier would leave nothing, so it stays.
    ['arn:aws:kms:us-east-1:718100330247:key/09033323-c94a-4134-b30b-bd0d57ea594a',
      { service: 'kms', region: 'us-east-1', account: '718100330247',
        name: '09033323-c94a-4134-b30b-bd0d57ea594a', qualifier: null }],
    // No region, no account, no type token - the bucket name is the whole REST.
    ['arn:aws:s3:::my-data-bucket',
      { service: 's3', region: 'global', account: '', name: 'my-data-bucket', qualifier: null }],
    // No type token either - an SQS queue name follows the account directly.
    ['arn:aws:sqs:us-east-1:718100330247:opt-iam-event-queue',
      { service: 'sqs', region: 'us-east-1', account: '718100330247',
        name: 'opt-iam-event-queue', qualifier: null }],
    // The path is part of how a person tells roles apart, so it stays in the name.
    ['arn:aws:iam::718100330247:role/service-role/lambda-x',
      { service: 'iam', region: 'global', account: '718100330247',
        name: 'service-role/lambda-x', qualifier: null }],
    // REST containing ':' - only the leading token goes.
    ['arn:aws:logs:us-east-1:718100330247:log-group:/aws/lambda/testLambda:*',
      { service: 'logs', region: 'us-east-1', account: '718100330247',
        name: '/aws/lambda/testLambda:*', qualifier: null }],
    ['arn:aws:ec2:us-east-1:718100330247:instance/i-0abc12345def67890',
      { service: 'ec2', region: 'us-east-1', account: '718100330247',
        name: 'i-0abc12345def67890', qualifier: null }],
    ['arn:aws:dynamodb:us-east-1:718100330247:table/opt-tf-state-lock',
      { service: 'dynamodb', region: 'us-east-1', account: '718100330247',
        name: 'opt-tf-state-lock', qualifier: null }],
    ['arn:aws:states:us-east-1:718100330247:stateMachine:order-flow',
      { service: 'states', region: 'us-east-1', account: '718100330247',
        name: 'order-flow', qualifier: null }],
    // A leading '/' means there is no type token to strip.
    // The policy identifiers the impact panel renders: an AWS managed policy carries the 'aws'
    // pseudo-account and its name is what the summary line shows. A customer managed policy
    // arrives as a bare name, which parseArn refuses (not an ARN) - the caller shows it as-is.
    ['arn:aws:iam::aws:policy/AWSLambda_FullAccess',
      { service: 'iam', region: 'global', account: 'aws',
        name: 'AWSLambda_FullAccess', qualifier: null }],
    ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      { service: 'iam', region: 'global', account: 'aws',
        name: 'service-role/AWSLambdaBasicExecutionRole', qualifier: null }],
    ['arn:aws:apigateway:us-east-1::/restapis/a1b2c3',
      { service: 'apigateway', region: 'us-east-1', account: '',
        name: '/restapis/a1b2c3', qualifier: null }],
  ]) {
    assert.deepEqual(parseArn(arn), expected, arn);
  }
});

test('what does not parse comes back null, so the page shows the raw string instead', () => {
  for (const bad of [
    'mirror-cmp-Reporting', // a customer managed policy identifier is a bare name
    'not an arn',
    '',
    'arn:aws:s3',                       // five fields
    'arn:aws::us-east-1:1:thing',       // no service
    'arn:aws:s3:::',                    // empty REST
  ]) {
    assert.equal(parseArn(bad), null, JSON.stringify(bad));
  }
});

test('a parse never produces an empty name', () => {
  // The one shape that could: REST that is ONLY a type token and a separator.
  assert.equal(parseArn('arn:aws:ec2:us-east-1:1:instance/'), null);
});

test('one resource has one short id, whichever screen prints it', () => {
  // Two functions used to answer this and agreed only on `type/name` ARNs, which was every ARN the
  // relationship picture drew while it drew EC2 alone. Drawing any policy put a colon-form ARN on a
  // plate: the plate said `db:opt-main` and the panel that opens from clicking it said `opt-main`.
  assert.equal(resourceId('arn:aws:rds:us-east-1:1:db:opt-main'), 'opt-main');
  assert.equal(resourceId('arn:aws:lambda:us-east-1:1:function:opt-planner'), 'opt-planner');
  // And every shape that already worked still answers what it answered.
  assert.equal(resourceId('arn:aws:ec2:us-east-1:1:instance/i-0aaa111'), 'i-0aaa111');
  assert.equal(resourceId('arn:aws:iam::1:role/opt-ApplierRole'), 'opt-ApplierRole');
  assert.equal(resourceId('arn:aws:s3:::opt-logs'), 'opt-logs');
  assert.equal(resourceId('arn:aws:sqs:us-east-1:1:opt-events'), 'opt-events');
  assert.equal(resourceId('arn:aws:logs:us-east-1:1:log-group:/aws/lambda/foo'), 'foo');
  assert.equal(resourceId(null), '');
  // The picture's export IS this function rather than a copy that agrees with it today.
  assert.equal(idOf, resourceId);
});

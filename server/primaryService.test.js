// Which service a managed policy is about - the answer that picks the icon, the count on the policy
// line, and which impact groups get folded behind "연관".
//
// Wrong here is not cosmetic in either direction. A missed answer renders no icon and buries the
// three functions an approver came for under fifteen stacks; a wrong answer folds the thing they
// came for out of sight. So both are pinned: the shapes that must resolve, and the shapes that must
// stay null.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { primaryService } from './primaryService.js';
import { serviceIconPath } from './serviceIcons.js';

const AWS = (name) => `arn:aws:iam::aws:policy/${name}`;

/** What the panel passes: the patterns as written, and every service the policy touches at all. */
const resolve = (name, granted, extra = []) => primaryService(
  AWS(name), granted,
  [...granted.map((a) => a.split(':', 1)[0]).filter((s) => s && !s.includes('*')), ...extra],
);

test('a name that decomposes to a service the policy names is believed', () => {
  assert.equal(resolve('AmazonS3FullAccess', ['s3:*', 's3-object-lambda:*']), 's3');
  assert.equal(resolve('AmazonEC2FullAccess',
    ['ec2:*', 'elasticloadbalancing:*', 'cloudwatch:*', 'autoscaling:*',
     'iam:CreateServiceLinkedRole']), 'ec2');
  // Longest first, so the policy about the derived service does not resolve to its parent.
  assert.equal(resolve('AmazonS3ObjectLambdaExecutionRolePolicy',
    ['s3-object-lambda:WriteGetObjectResponse', 's3:GetObject']), 's3-object-lambda');
});

test('a name that decomposes to a service the policy never names is NOT believed', () => {
  // The guard that keeps the name from inventing an answer. This policy is named for Route 53 and
  // touches none of it, so the name yields nothing - and with two services named and neither
  // granted in full, nothing else speaks either.
  assert.equal(resolve('AmazonRoute53FullAccess', ['ec2:DescribeVpcs', 's3:GetBucketWebsite']),
               null);
});

test('a candidate AWS spelled with a capital still matches', () => {
  // AWS writes "S3:GetBucketPolicy" in its own policy documents. A candidate that keeps its capital
  // matches no name, no resource group and no icon, so everything is lowercased on the way in.
  assert.equal(resolve('AmazonS3ReadOnlyAccess', ['S3:Get*', 'S3:List*']), 's3');
});

test('a brand the name spells and IAM does not resolves from what the policy grants', () => {
  // The reported failures. "ecr" is three letters and never appears in the name; "msk" is not a
  // prefix at all. Both used to render no icon, no count and no fold.
  assert.equal(resolve('AmazonEC2ContainerRegistryFullAccess', ['ecr:*']), 'ecr');
  assert.equal(resolve('AmazonMSKFullAccess', [
    'kafka:*', 'ec2:DescribeSubnets', 'ec2:DescribeVpcs', 'ec2:CreateVpcEndpoint',
    'iam:AttachRolePolicy', 'iam:CreateServiceLinkedRole', 'iam:PutRolePolicy',
    'kms:DescribeKey', 'kms:CreateGrant', 'cloudwatch:GetMetricData', 'logs:CreateLogDelivery',
    'S3:GetBucketPolicy', 'firehose:TagDeliveryStream',
  ]), 'kafka');
  // And the read-only halves of the same brands, which grant nothing wholesale but name one service.
  assert.equal(resolve('AmazonEC2ContainerRegistryReadOnly', [
    'ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability', 'ecr:DescribeRepositories',
    'ecr:ListImages', 'ecr:BatchGetImage',
  ]), 'ecr');
});

test('exactly one is the whole statement - two of anything stays null', () => {
  // Two services named and neither granted in full: the policy is about a job, not a service.
  // AWSLambdaVPCAccessExecutionRole is that shape, and folding either half would be a lie.
  assert.equal(resolve('AWSLambdaVPCAccessExecutionRole', [
    'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents',
    'ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DeleteNetworkInterface',
  ]), null);
  // Two granted wholesale is the same refusal - nothing says which of them the policy is for.
  assert.equal(resolve('AWSSomeBundle', ['glacier:*', 'backup:*']), null);
});

test('one service named settles it even when the name says nothing', () => {
  // AWSLambdaBasicExecutionRole names its job, not a service, and touches CloudWatch Logs alone.
  // Saying "logs" is what the policy says; the old name-only reading said nothing at all.
  assert.equal(resolve('AWSLambdaBasicExecutionRole',
    ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents']), 'logs');
});

test('a brand alias is the last resort, and only for a service the policy names', () => {
  // EventBridge is events:*, and this policy grants four services without granting any in full -
  // the one shape the grants cannot settle.
  assert.equal(resolve('AmazonEventBridgeReadOnlyAccess', [
    'events:DescribeRule', 'events:ListRules', 'scheduler:GetSchedule', 'scheduler:ListSchedules',
    'pipes:DescribePipe', 'schemas:DescribeSchema', 'schemas:ListSchemas',
  ]), 'events');
  // Never against a policy that does not name the aliased prefix.
  assert.equal(resolve('AmazonEventBridgeSomething', ['s3:GetObject', 'sqs:SendMessage']), null);
});

test('a full-wildcard grant is not a service', () => {
  // `*` has no service half, and AdministratorAccess is about everything - which is not a fold.
  assert.equal(resolve('AdministratorAccess', ['*']), null);
  assert.equal(resolve('PowerUserAccess', ['*', 'iam:CreateServiceLinkedRole']), 'iam');
});

test('only AWS managed policies are read this way', () => {
  // A customer policy's name is whatever its author typed, and the platform writes those names
  // itself - mirror-cmp-Reporting is not a statement about a service.
  assert.equal(primaryService('arn:aws:iam::718100330247:policy/mirror-cmp-s3', ['s3:*'], ['s3']),
               null);
  assert.equal(primaryService('', ['s3:*'], ['s3']), null);
});

test('missing or empty inputs are null rather than a throw', () => {
  assert.equal(primaryService(AWS('AmazonMSKFullAccess'), undefined, undefined), null);
  assert.equal(primaryService(AWS('AmazonMSKFullAccess'), [], []), null);
  // "" is a prefix of every name, so a candidate that flattens to nothing must never be compared -
  // it would answer for the whole policy and then filter every group away.
  assert.equal(primaryService(AWS('AmazonMSKFullAccess'), ['kafka:*'], ['*', '', 'kafka']),
               'kafka');
});

test('every service these policies resolve to has an icon to render', () => {
  // The half the resolution cannot see: a correct prefix with no entry in the icon table renders
  // exactly as a missed one does, which is how AmazonAuroraDSQLReadOnlyAccess reached the screen
  // with no image while resolving perfectly well.
  for (const prefix of ['ecr', 'kafka', 'dsql', 'events', 'logs', 'states', 's3', 'ec2']) {
    assert.ok(serviceIconPath(prefix), `${prefix} resolves but has no icon`);
  }
});

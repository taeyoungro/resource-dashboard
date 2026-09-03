// What a wildcard action covers, and the three questions the preview asks of it.
//
// The defect these are about, in one line: no entry in an assessment's action_reference is called
// "s3:Delete*", so every lookup by name answered "no" for a wildcard - and the writer, which holds
// the table and expands the pattern, wrote a different document from the one on screen.
//
//     npm run check
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  coveredNames, coversProtected, createdFormats, reachesInside, splitAction, swallowedByExemption,
  wildcardMatch,
} from './actionPattern.js';
import { creationExemption } from './inlinePreview.js';

const ACCOUNT = '718100330247';

// A cut-down action_reference in the shape impact.json carries: services[service][name] is
// [level, types] and nested_types names the types that sit under another one.
const REFERENCE = {
  services: {
    s3: {
      GetObject: ['Read', ['object']],
      DeleteObject: ['Write', ['object']],
      DeleteBucket: ['Write', ['bucket']],
      GetBucketPolicy: ['Read', ['bucket']],
      CreateBucket: ['Write', ['bucket'], true],
    },
    ssm: {
      GetParameter: ['Read', ['parameter']],
      GetParameters: ['Read', ['parameter']],
    },
    athena: {
      GetDataCatalog: ['Read', ['datacatalog']],
      DeleteDataCatalog: ['Write', ['datacatalog']],
      CreateDataCatalog: ['Write', ['datacatalog'], true],
    },
  },
  nested_types: { s3: ['object', 'accesspoint'] },
  created_formats: {
    s3: { CreateBucket: ['arn:${Partition}:s3:::*'] },
    athena: { CreateDataCatalog: ['arn:${Partition}:athena:*:${Account}:datacatalog/*'] },
  },
};

test('the matcher treats only the star as a metacharacter', () => {
  // A policy is caller-controlled text. fnmatch would make [ ] and ? mean something, and a RegExp
  // built from the string would make . and ( mean something - both are ways to match an action
  // nobody typed.
  assert.equal(wildcardMatch('s3:GetObject', 's3:Get*', { foldCase: true }), true);
  assert.equal(wildcardMatch('s3:GetObject', 's3:*Object', { foldCase: true }), true);
  assert.equal(wildcardMatch('s3:GetObject', 's3:G*t*ject', { foldCase: true }), true);
  assert.equal(wildcardMatch('s3:GetObject', 's3:[DG]etObject', { foldCase: true }), false);
  assert.equal(wildcardMatch('s3:GetObject', 's3:G?tObject', { foldCase: true }), false);
  assert.equal(wildcardMatch('s3:GetObject', 's3:getobject', { foldCase: true }), true);
  // ARNs are case SENSITIVE, so folding them would treat two different buckets as one.
  assert.equal(wildcardMatch('arn:aws:s3:::Prod', 'arn:aws:s3:::prod'), false);
  assert.equal(wildcardMatch('anything', '*'), true);
});

test('a concrete action covers itself and a wildcard covers what it matches', () => {
  assert.deepEqual(coveredNames('s3:GetObject', Object.keys(REFERENCE.services.s3)), ['GetObject']);
  assert.deepEqual(coveredNames('s3:Delete*', Object.keys(REFERENCE.services.s3)).sort(),
                   ['DeleteBucket', 'DeleteObject']);
  // Unknown to the reference is still itself - the caller's other lookups answer "unknown", and
  // inventing an expansion here would hide that.
  assert.deepEqual(coveredNames('s3:Nonesuch', Object.keys(REFERENCE.services.s3)), ['Nonesuch']);
  assert.deepEqual(splitAction('s3:GetObject'), { service: 's3', name: 'GetObject' });
  assert.deepEqual(splitAction('nocolon'), { service: '', name: '' });
});

test('a wildcard reaches inside the container when any action it covers does', () => {
  // The deployed bug: deny_only s3:Delete* listed the bucket alone and denied no object in it,
  // and allow_only s3:Get* kept the bucket alone and denied every object inside the bucket it was
  // there to keep.
  assert.equal(reachesInside(REFERENCE, 's3:DeleteObject'), true);
  assert.equal(reachesInside(REFERENCE, 's3:Delete*'), true);
  assert.equal(reachesInside(REFERENCE, 's3:GetBucketPolicy'), false);
  // ssm has no child type at all - a parameter named /prod and one named /prod/db are two
  // parameters - so the pattern under it is a permission nobody granted.
  assert.equal(reachesInside(REFERENCE, 'ssm:Get*'), false);
  assert.equal(reachesInside(null, 's3:Delete*'), false);
});

test('the exemptions of a wildcard are the union over what it covers', () => {
  assert.deepEqual(createdFormats(REFERENCE, 's3:CreateBucket'), ['arn:${Partition}:s3:::*']);
  assert.deepEqual(createdFormats(REFERENCE, 's3:*'), ['arn:${Partition}:s3:::*']);
  assert.deepEqual(createdFormats(REFERENCE, 's3:Delete*'), []);
  assert.deepEqual(createdFormats(null, 's3:*'), []);
});

test('protected actions are matched as patterns, not as strings', () => {
  // The B-1 gate on this side: `Set.has` is exact, so iam:Create* walked past it and denied
  // iam:CreateRole - and the denial only became visible after the approval, in the account.
  const protectedActions = new Set(['iam:CreateRole', 'iam:CreatePolicy', 'iam:AttachRolePolicy']);
  assert.deepEqual(coversProtected('iam:Create*', protectedActions).sort(),
                   ['iam:CreatePolicy', 'iam:CreateRole']);
  assert.deepEqual(coversProtected('iam:CreateRole', protectedActions), ['iam:CreateRole']);
  assert.deepEqual(coversProtected('s3:Get*', protectedActions), []);
  // Case folded, because IAM matches action names case-insensitively.
  assert.deepEqual(coversProtected('IAM:createrole', protectedActions), ['iam:CreateRole']);
});

test('an exemption that keeps the type it claims to scope is reported', () => {
  const catalog = `arn:aws:athena:us-east-1:${ACCOUNT}:datacatalog/AwsDataCatalog`;
  // athena:* covers CreateDataCatalog, so the statement must exempt datacatalog/* - and that
  // pattern matches every other catalog in the account. "Only this catalog" then permits deleting
  // all of them, which is why the writer refuses the decision.
  const hit = swallowedByExemption(REFERENCE, 'athena:*', [catalog], creationExemption);
  assert.equal(hit?.action, 'athena:CreateDataCatalog');
  assert.equal(hit?.resource, catalog);
  assert.equal(hit?.pattern, `arn:aws:athena:*:${ACCOUNT}:datacatalog/*`);

  // A concrete action never reaches this - it is refused earlier, by the created-type gate.
  assert.equal(swallowedByExemption(REFERENCE, 'athena:DeleteDataCatalog', [catalog],
                                    creationExemption), null);
  // And a wildcard whose exemptions do not reach the picked ARN is a real control: s3:*'s bucket
  // exemption does not match an athena catalog.
  assert.equal(swallowedByExemption(REFERENCE, 's3:Delete*',
                                    ['arn:aws:s3:::keep'], creationExemption), null);
  assert.equal(swallowedByExemption(REFERENCE, 'athena:*', [], creationExemption), null);
});

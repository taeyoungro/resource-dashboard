// The service icon table: every entry must point at an icon that actually exists on disk, because
// the page trusts the path enough to render an <img> with it - and a broken image beside every
// lambda policy is worse than no icon at all.
//
//     npm run check
//
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  RESOURCE_TYPE_ICONS, SERVICE_ICONS, resourceIconPath, serviceIconPath,
} from './serviceIcons.js';

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'aws-icons');

test('every mapped icon exists among the extracted files', () => {
  const files = new Set(readdirSync(ICON_DIR));
  for (const [prefix, name] of Object.entries(SERVICE_ICONS)) {
    assert.ok(files.has(`${name}.svg`), `${prefix} -> ${name}.svg is not in public/aws-icons - `
      + 're-run tools/extract-aws-icons.mjs or fix the entry');
  }
  for (const [type, name] of Object.entries(RESOURCE_TYPE_ICONS)) {
    assert.ok(files.has(`${name}.svg`), `${type} -> ${name}.svg is not in public/aws-icons`);
  }
});

test('a type whose brand differs from its prefix gets its own product icon', () => {
  // The reported case: ec2:vpc rendered with the EC2 icon because IAM files VPC under ec2.
  assert.equal(resourceIconPath('ec2', 'ec2:vpc'), '/aws-icons/Amazon-Virtual-Private-Cloud.svg');
  assert.equal(resourceIconPath('ec2', 'ec2:volume'), '/aws-icons/Amazon-Elastic-Block-Store.svg');
  // A type that IS its prefix's product falls back to the service icon.
  assert.equal(resourceIconPath('ec2', 'ec2:instance'), '/aws-icons/Amazon-EC2.svg');
  // No type at all - the policy summary line - is exactly the service lookup.
  assert.equal(resourceIconPath('ec2'), '/aws-icons/Amazon-EC2.svg');
  assert.equal(resourceIconPath('quantum', 'quantum:thing'), null);
});

test('the override table carries only types that change the answer', () => {
  // An entry equal to its service icon is dead weight that hides the real overrides.
  for (const [type, name] of Object.entries(RESOURCE_TYPE_ICONS)) {
    const service = type.split(':', 1)[0];
    assert.notEqual(name, SERVICE_ICONS[service],
      `${type} maps to its own service icon - remove the entry, the fallback already does this`);
  }
});

test('the services the impact panel showed in real assessments all resolve', () => {
  for (const prefix of ['lambda', 'ec2', 's3', 'cloudformation', 'kms', 'iam', 'logs',
    'cloudwatch', 'states', 'xray', 'athena', 'bedrock', 'elasticache', 'dynamodb',
    'securityhub', 'events']) {
    assert.ok(serviceIconPath(prefix), prefix);
  }
});

test('the path is under the site origin and an unknown prefix is null, never a guess', () => {
  assert.equal(serviceIconPath('lambda'), '/aws-icons/AWS-Lambda.svg');
  assert.equal(serviceIconPath('LAMBDA'), '/aws-icons/AWS-Lambda.svg');
  assert.equal(serviceIconPath('quantum'), null);
  assert.equal(serviceIconPath(''), null);
});

test('every extracted file is a standalone svg, not a fragment', () => {
  // Spot the property the <img> tag depends on across the whole set, not per mapped entry.
  const files = readdirSync(ICON_DIR);
  assert.ok(files.length >= 250, `only ${files.length} icons extracted`);
  for (const f of files) {
    assert.ok(f.endsWith('.svg'), f);
  }
});

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

import { SERVICE_ICONS, serviceIconPath } from './serviceIcons.js';

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'aws-icons');

test('every mapped icon exists among the extracted files', () => {
  const files = new Set(readdirSync(ICON_DIR));
  for (const [prefix, name] of Object.entries(SERVICE_ICONS)) {
    assert.ok(files.has(`${name}.svg`), `${prefix} -> ${name}.svg is not in public/aws-icons - `
      + 're-run tools/extract-aws-icons.mjs or fix the entry');
  }
});

test('the services the impact panel showed in real assessments all resolve', () => {
  for (const prefix of ['lambda', 'ec2', 's3', 'cloudformation', 'kms', 'iam', 'logs',
    'cloudwatch', 'states', 'xray', 'athena', 'bedrock', 'elasticache', 'dynamodb']) {
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

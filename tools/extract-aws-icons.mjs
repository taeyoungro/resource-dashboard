// Extract the AWS service icons out of the official Architecture Icons deck.
//
//     node tools/extract-aws-icons.mjs path/to/AWS-Architecture-Icons-Deck_For-Light-BG_*.pptx
//
// The deck is a ZIP; every icon is embedded twice (PNG fallback + SVG vector), and the SVGs
// self-identify: each carries <g id="Icon-Architecture/64/Arch_<Name>_64"> inside. That id - not
// the meaningless imageN.svg filename, and not the slide labels - is the source of truth here, so
// extraction needs no slide parsing at all.
//
// Only the 64px ARCHITECTURE (service) icons are taken. The deck also carries ~470 48px resource
// icons (Res_*) - finer-grained than the panel currently renders - and category/group icons; if a
// finer level is ever wanted, this is the file to widen.
//
// Output goes to public/aws-icons/<Name>.svg, which vite copies into dist verbatim and the page
// loads per-icon via <img src>. That is the point of static files over bundling: 291 icons sit on
// disk (~450 KB), and a viewer downloads only the handful the current assessment actually shows.
//
// The 21 MB deck itself is NOT committed to this branch and NOT read at build time - this tool is
// run by hand against a downloaded deck when AWS releases a new icon set, and the extracted SVGs
// are committed. server/serviceIcons.test.js pins that every mapped icon file exists, so an
// extraction that drops one fails the suite rather than a page render.

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const deck = process.argv[2];
if (!deck) {
  console.error('usage: node tools/extract-aws-icons.mjs <deck.pptx>');
  process.exit(1);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'aws-icons');
mkdirSync(outDir, { recursive: true });

// Node has no zip reader in the standard library; unzip -p streams one entry without touching
// disk. The entry list first, then each SVG.
const entries = execFileSync('unzip', ['-Z1', deck], { maxBuffer: 1 << 24 })
  .toString('utf-8')
  .split('\n')
  .filter((n) => n.startsWith('ppt/media/') && n.endsWith('.svg'));

const ARCH = /<g id="Icon-Architecture\/64\/Arch_(.+?)_64"/;

const seen = new Map();
let skipped = 0;
for (const entry of entries) {
  const svg = execFileSync('unzip', ['-p', deck, entry], { maxBuffer: 1 << 22 }).toString('utf-8');
  const match = ARCH.exec(svg);
  if (!match) {
    skipped += 1;
    continue;
  }
  const name = match[1];
  // The same icon appears on several slides; first occurrence wins, and a name that reappears
  // with DIFFERENT bytes is reported rather than silently overwritten or dropped.
  if (seen.has(name)) {
    if (seen.get(name) !== svg) console.warn(`differs across slides, first kept: ${name}`);
    continue;
  }
  seen.set(name, svg);
  writeFileSync(join(outDir, `${name}.svg`), svg);
}

console.log(`extracted ${seen.size} service icons to public/aws-icons (${skipped} non-Arch svgs skipped)`);

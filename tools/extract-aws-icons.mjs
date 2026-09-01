// Extract the AWS service icons out of the official Architecture Icons deck.
//
//     node tools/extract-aws-icons.mjs path/to/AWS-Architecture-Icons-Deck_For-Light-BG_*.pptx
//
// The deck is a ZIP; every icon is embedded twice (PNG fallback + SVG vector), and the SVGs
// self-identify: each carries <g id="Icon-Architecture/64/Arch_<Name>_64"> inside. That id - not
// the meaningless imageN.svg filename, and not the slide labels - is the source of truth here, so
// extraction needs no slide parsing at all.
//
// Three families are taken, and the asymmetry between them is deliberate.
//
//   Arch_*_64    EVERY one. The impact panel renders an icon per service and it cannot know in
//                advance which services an account holds, so the whole set has to be on disk.
//                291 files, ~450 KB, and a viewer downloads only the handful one assessment shows.
//   Group_*_32   THE THREE the resource diagram frames with. AWS-Cloud, Region, VPC.
//   Res_*_48     AN ALLOWLIST, named one by one below.
//
// The last two are allowlisted rather than taken wholesale because the deck carries ~470 Res_*
// icons and the diagram names eighteen. Extracting all of them would put 450 files in a diff
// nobody can review to add a picture that renders eighteen, and every unused file is one more
// thing a future reader has to decide is dead. A named list is a list somebody can check against
// server/ec2Topology.js - and its test does exactly that, in both directions.
//
// The Res_ and Group_ output names are PREFIXED (Res-*.svg, Group-*.svg) so they cannot collide
// with the Arch-derived names the service table keys on: Res_Amazon-EC2_Instance_48 and
// Arch_Amazon-EC2_64 would otherwise both want to be Amazon-EC2.svg, and the second write would
// silently replace the icon every policy summary line renders.
//
// Output goes to public/aws-icons/<Name>.svg, which vite copies into dist verbatim; the page loads
// service icons per-icon via <img src> and the diagram's via SVG <image href>.
//
// The 21 MB deck IS committed (both at the repository root and under the extracted directory) but
// is NOT read at build time - this tool is run by hand when AWS releases a new icon set, and the
// extracted SVGs are what CI and the page use. server/serviceIcons.test.js and
// server/ec2Topology.test.js each pin that every icon their table names exists on disk, so an
// extraction that drops one fails the suite rather than a page rendering a blank box.

/** The frames the resource diagram draws. Public-subnet_32 and Private-subnet_32 are deliberately
 *  NOT here: the assessment carries nothing that tells a public subnet from a private one, and a
 *  badge asserting either would be the dashboard claiming a routing fact it never measured. */
const GROUPS = ['AWS-Cloud', 'Region', 'Virtual-private-cloud-VPC'];

/**
 * Names the deck carries TWICE with different bytes, and which copy this repository takes.
 *
 * An id that appears more than once is a choice, and it was being made by the order entries happen
 * to sit in the zip's central directory - which PowerPoint reassigns on every save and which
 * carries no meaning at all. Two live cases:
 *
 *   AWS-Cloud                     the deck states the rule on slide 25 in so many words: "use the
 *                                 group with the AWS logo except in Regions where the AWS logo
 *                                 cannot be used. You may use the group with the cloud icon in
 *                                 those cases." Ordering had picked the cloud-icon variant - the
 *                                 China-Regions exception - for the outermost frame of every
 *                                 diagram this repository draws.
 *   Amazon-Kinesis-Video-Streams  published under two categories, so two background fills: Media
 *                                 Services #ED7100 and Analytics #8C4FFF. AWS states no rule, so
 *                                 this is ours: Analytics, because every other Kinesis tile in the
 *                                 set carries it and one orange sibling in a policy summary list
 *                                 reads as a distinction nobody made.
 *
 * The value is a marker that must appear in the chosen copy - for AWS-Cloud the first path of the
 * "aws" swoosh, which the cloud outline does not have. Matching on exact geometry is deliberate: a
 * deck that redraws the glyph fails this tool loudly instead of silently re-picking, and a person
 * then looks at both and decides again. Anything ambiguous and NOT named here exits 1 for the same
 * reason. Before this, a name that appeared twice printed a warning to stderr and exited 0.
 */
const PINNED = {
  'Group-AWS-Cloud': 'd="M32.6982 23.9008',
  'Amazon-Kinesis-Video-Streams': 'Icon-Architecture-BG/64/Analytics',
};

/** One per node the diagram draws, keyed to server/ec2Topology.js's EC2_SLOTS. Res_Internet_48 is
 *  the far end of the diagram's one link. There is no key-pair, launch-template, placement-group,
 *  host, fleet, reserved-instances, dhcp-options, prefix-list, security-group-rule,
 *  capacity-reservation or transit-gateway glyph in this deck - those twelve slots render their
 *  label and no glyph, which is the same contract the service table keeps: nothing rather than a
 *  guessed icon. (Res_AWS-Transit-Gateway_Attachment_48 is the transit gateway ATTACHMENT, which is
 *  a different slot and is allowlisted below.) */
const RESOURCES = [
  'Amazon-EC2_Instance',
  'Amazon-EC2_Spot-Instance',
  'Amazon-EC2_AMI',
  'Amazon-EC2_Elastic-IP-Address',
  'Amazon-VPC_Internet-Gateway',
  'Amazon-VPC_NAT-Gateway',
  'Amazon-VPC_Router',
  'Amazon-VPC_Network-Access-Control-List',
  'Amazon-VPC_Endpoints',
  'Amazon-VPC_Peering-Connection',
  'Amazon-VPC_VPN-Gateway',
  'Amazon-VPC_VPN-Connection',
  'Amazon-VPC_Customer-Gateway',
  'Amazon-VPC_Elastic-Network-Interface',
  'AWS-Transit-Gateway_Attachment',
  'Amazon-Elastic-Block-Store_Volume',
  'Amazon-Elastic-Block-Store_Snapshot',
  'Internet',
];

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
const GROUP = /<g id="Icon-Architecture-Group\/32\/(.+?)_32"/;
const RES = /<g id="Icon-Resource\/[^/]+\/Res_(.+?)_48"/;

const wantedGroups = new Set(GROUPS);
const wantedResources = new Set(RESOURCES);

/** The output name for one embedded SVG, or null when this file is not one of the three families
 *  - or is a Res_/Group_ icon outside the allowlists above. */
function named(svg) {
  const arch = ARCH.exec(svg);
  if (arch) return arch[1];
  const group = GROUP.exec(svg);
  if (group) return wantedGroups.has(group[1]) ? `Group-${group[1]}` : null;
  const res = RES.exec(svg);
  if (res) return wantedResources.has(res[1]) ? `Res-${res[1].replaceAll('_', '-')}` : null;
  return null;
}

// The id is XML text, so entities arrive encoded (&amp;), and two icon names contain characters
// Windows refuses in filenames (AWS-re:Post). A repository that cannot be checked out on Windows is
// broken for half its users, so the name is decoded and sanitised before it becomes a filename.
// The mapping tables and the MISSING check below both reference the sanitised name - they used to
// disagree, which would have reported a correctly-written file as missing for any allowlist entry
// carrying one of these characters.
const filename = (name) => name.replaceAll('&amp;', '&').replace(/[:*?"<>|\\/]/g, '-');

const seen = new Map();
/** Names the deck carries twice with different bytes and PINNED does not decide. */
const ambiguous = new Set();
let skipped = 0;
for (const entry of entries) {
  const svg = execFileSync('unzip', ['-p', deck, entry], { maxBuffer: 1 << 22 }).toString('utf-8');
  const found = named(svg);
  if (!found) {
    skipped += 1;
    continue;
  }
  const name = filename(found);
  const pin = PINNED[name];
  // A pinned name takes the copy that carries its marker, whichever order the entries arrive in.
  if (pin !== undefined) {
    if (!svg.includes(pin)) continue;
    seen.set(name, svg);
    writeFileSync(join(outDir, `${name}.svg`), svg);
    continue;
  }
  // The same icon appears on several slides. Byte-identical copies are the ordinary case and the
  // first is kept. A name that reappears with DIFFERENT bytes is a CHOICE, and this tool does not
  // get to make it by zip order - it is collected and the run fails below.
  if (seen.has(name)) {
    if (seen.get(name) !== svg) ambiguous.add(name);
    continue;
  }
  seen.set(name, svg);
  writeFileSync(join(outDir, `${name}.svg`), svg);
}

// Named rather than counted, because a MISSING allowlisted icon is the failure this tool can see
// and the test suite would only see later. An id AWS renamed between decks silently produces one
// fewer file, and a diagram slot then renders its label with no glyph - which is a legal state, so
// nothing downstream would complain.
const wanted = [
  ...GROUPS.map((g) => filename(`Group-${g}`)),
  ...RESOURCES.map((r) => filename(`Res-${r.replaceAll('_', '-')}`)),
];
const missing = wanted.filter((n) => !seen.has(n));
const unpinned = [...Object.keys(PINNED)].filter((n) => !seen.has(n));
const arch = [...seen.keys()].filter((n) => !n.startsWith('Group-') && !n.startsWith('Res-')).length;
console.log(`extracted ${arch} service icons, ${seen.size - arch} diagram icons to `
            + `public/aws-icons (${skipped} svgs skipped)`);
if (missing.length > 0) {
  console.error(`MISSING from the deck, so the allowlist and the deck disagree:\n  `
                + missing.join('\n  '));
}
if (unpinned.length > 0) {
  console.error(`PINNED names whose chosen copy is not in this deck - the marker no longer `
                + `matches, so look at the variants and decide again:\n  ` + unpinned.join('\n  '));
}
if (ambiguous.size > 0) {
  console.error(`AMBIGUOUS - the deck carries these twice with different bytes and nothing decides `
                + `which. Add an entry to PINNED:\n  ` + [...ambiguous].join('\n  '));
}
if (missing.length > 0 || unpinned.length > 0 || ambiguous.size > 0) process.exit(1);

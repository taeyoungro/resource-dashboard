// What the page must not stop doing.
//
// These read the .tsx sources as text. That is a poor way to test a component and the right way to
// test these particular things: the test runner cannot load TypeScript, and every rule below is a
// rule about what the RENDERED page contains rather than about a function's return value. The
// alternative - a browser harness in CI - would cover more and does not exist, and until it does an
// assertion that fails when somebody abbreviates an action list is worth more than none.
//
// One of these has already shipped broken once in this codebase, in the other direction: the server
// was taught to accept the assessment digest on a plain approval while the page still had it nested
// under the restriction conditional, so the fence was never dispatched and nothing said why. Every
// rule here is the same shape - a contract between two files that no type checks.
//
//     npm run check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RULES, SECTION_ORDER } from './rules.js';

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
const PANEL = read('components/RiskAnalysis.tsx');
const CSS = read('styles.css');
const DETAIL = read('components/PlanDetail.tsx');
const PAGE = read('components/PlanPage.tsx');

test('a grade modifier styles the badge and never the card it sits on', () => {
  // Shipped broken once, and every check that existed passed. The card root carries
  // `finding grade-critical` so its left edge can take the grade's colour, and the badge carries
  // `grade grade-critical`. An unscoped `.grade-critical { color: #fff }` therefore hit BOTH, and
  // every descendant of the card inherited white text on a light panel - measured at 1.05:1.
  //
  // The rule: a .grade-* declaration that paints text or background is scoped to .grade.
  for (const [, selector, body] of CSS.matchAll(/^(\.[^{\n]*grade-[^{\n]*)\{([^}]*)\}/gm)) {
    if (!/(^|[^-])color\s*:|background/.test(body)) continue;
    assert.ok(/\.grade\.grade-/.test(selector),
              `${selector.trim()} paints without being scoped to .grade, so it also paints the `
              + 'card that carries the same modifier');
  }
});

test('the sort is grade, status, id - and the asset grade is not in it', () => {
  // T-7. UNDETERMINED dominates the asset axis, so a sort that used it would rank almost nothing.
  const compare = PANEL.slice(PANEL.indexOf('function compare('),
                              PANEL.indexOf('const policyName'));
  assert.ok(compare.includes('GRADE_ORDER'), 'the comparator no longer orders by grade');
  assert.ok(compare.includes('STATUS_ORDER'), 'the comparator no longer orders by status');
  assert.ok(compare.includes('id.localeCompare'), 'the comparator no longer breaks ties by id');
  assert.ok(!compare.includes('assetImpactGrade'),
            'assetImpactGrade became a sort key, which T-7 forbids');
});

test('the sections are in the order the rules file states', () => {
  // The rule file owns the order and the page follows it. A page that ordered them by count would
  // put whatever is noisiest first, which is not the same as worst.
  const order = [...PANEL.matchAll(/category: "([A-Z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, SECTION_ORDER);
  // Everything that could not be assessed comes after all four, as its own list with a visible
  // length - scattered through the sections it reads as absence.
  assert.ok(PANEL.indexOf('평가 불가 <span') > PANEL.lastIndexOf('SECTIONS.map'));
});

test('every action that fired a finding is rendered, and none of it is summarised', () => {
  // T-7 again, and the reason it is a rule: an approver has to be able to see WHY a card appeared.
  // A count cannot answer that, and "등" is a count with a nicer face.
  assert.match(PANEL, /finding\.triggerActions\.map/,
               'the trigger actions are no longer rendered one by one');
  const rendered = PANEL.slice(PANEL.indexOf('발화 동작'), PANEL.indexOf('<Targets'));
  assert.ok(!/\bslice\(|\.length\s*>\s*\d+\s*\?|등\b/.test(rendered),
            'the action list is being truncated, capped or abbreviated');
});

test('a card carries the grade, the id, the title, the narrative and the restrictable badge', () => {
  const card = PANEL.slice(PANEL.indexOf('function Card('), PANEL.indexOf('function Summary('));
  for (const required of ['GRADE_CLASS[finding.escalationGrade]', 'finding.id', 'finding.title',
                          'finding.narrative', 'finding.restrictable', 'STATUS_LABEL']) {
    assert.ok(card.includes(required), `the card no longer shows ${required}`);
  }
  // status !== CONFIRMED must show the reason AND blockedBy. A grade whose evidence nobody could
  // establish, shown without saying so, is the failure this whole two-axis design exists to avoid.
  assert.ok(card.includes('finding.status !== "CONFIRMED"'));
  assert.ok(card.includes('finding.blockedBy'));
});

test('unknown enumeration completeness is shown as unknown, never as complete', () => {
  // T-6. `truncated !== false` is the guard, not `=== true`: null means nobody established it, and
  // a page that only warned on true would silently present an unverified list as the whole list.
  assert.match(PANEL, /finding\.truncated\s*!==\s*false/);
  assert.ok(PANEL.includes('열거 완전성 미확인'));
});

test('the asset axis says undetermined rather than showing nothing', () => {
  // An approver who sees no asset grade assumes there is nothing to weigh. What is true is that
  // nothing here established what the resource is worth - and only configuration may establish it.
  assert.ok(PANEL.includes('자산 등급 미판정'));
  assert.ok(PANEL.includes('grade === "UNDETERMINED"'));
  // A prefix hit is labelled as a prefix hit, because it is a match against a NAME (T-4).
  assert.ok(PANEL.includes('basis === "prefix"'));
});

test('the page tells a rule finding from a model finding', () => {
  // They are read differently. One is reproducible from the assessment alone; the other is a
  // model's judgement of a proposed path, and merging them into one undifferentiated list would
  // borrow the rules' authority for the model's sentences.
  assert.ok(PANEL.includes('finding.source === "model"'));
  assert.ok(PANEL.includes('모델 판정'));
  assert.ok(PANEL.includes('"규칙"'));
});

test('rejected candidates and dropped verdicts are on the page, not only in the log', () => {
  // A run that answered four candidates of sixty is a different answer from one that answered
  // sixty. Both of these being absent is how a partial analysis reads as a clean one.
  assert.ok(PANEL.includes('model.rejected'));
  assert.ok(PANEL.includes('model.dropped'));
  assert.ok(PANEL.includes('model.failures'));
  assert.ok(PANEL.includes('discarded'), 'a discarded run is not reported to the reader');
});

test('the analysis is not run by opening a plan', () => {
  // It costs money and takes seconds. The panel exposes a button and no effect that fires on mount.
  assert.ok(PANEL.includes('api.analyse(planId)'));
  assert.ok(!/useEffect\([^)]*api\.analyse/s.test(PANEL),
            'the analysis is being run from an effect, so opening a plan bills for one');
});

test('the citation travels with a decision, and only for the assessment it answered about', () => {
  // The gap this shape closes: the server verifies the digest and refuses a citation naming another
  // assessment, but a page that sent a citation from the PREVIOUS plan would only find that out
  // after the reviewer pressed the button.
  assert.match(
    PAGE,
    /analysis\.impact_sha256\s*===\s*detail\.assessment_sha256[\s\S]{0,80}risk_analysis: analysis/,
    'PlanPage no longer gates the citation on it naming the assessment this decision carries',
  );
  assert.match(DETAIL, /useEffect\(\(\) => \{ setAnalysis\(null\); \}, \[detail\.plan_id/,
               'the citation is no longer dropped when the plan changes');
});

test('a discarded run is never cited on a decision', () => {
  // Caught by driving the page in a browser rather than by reading it: a run thrown away for citing
  // an action granted nowhere still carried a findings digest, and the page offered it. The record
  // would then say a decision was taken while reading an analysis that does not exist.
  assert.match(PANEL, /next\.analysis && !next\.analysis\.discarded/,
               'the citation is no longer gated on the run not having been discarded');
});

test('the panel is mounted where the assessment is, and says so when there is none', () => {
  assert.ok(DETAIL.includes('<RiskAnalysis'));
  assert.ok(DETAIL.includes('ready={!!detail.assessment}'));
  assert.ok(PANEL.includes('영향도 평가를 입력으로 씁니다'));
});

test('the rules are shown as soon as they arrive, and the model half is polled for', () => {
  // The 504. The analysis was one POST that called the model once per batch in sequence, so a real
  // assessment held the connection open for minutes and whatever terminates TLS in front answered
  // first. Both halves of the fix have to stay: the POST puts the rule findings up immediately,
  // and a separate short GET collects the model half.
  assert.ok(PANEL.includes('api.analysisRun('),
            'the page no longer polls for the model half, so it is back to one long request');
  assert.match(PANEL, /run\?\.state === "running"[\s\S]{0,200}poll\(\)/,
               'a running run no longer schedules the next poll');
  const start = PANEL.slice(PANEL.indexOf('const run = async'), PANEL.indexOf('if (!ready)'));
  assert.ok(start.includes('setAnswer(next)'),
            'the POST result is no longer shown, so the rule findings wait for the model again');
});

test('the poll stops when the reviewer opens another plan', () => {
  // Otherwise the answer for the plan they just left arrives and overwrites the one in front of
  // them - with a grade, a card list and a citation that belong to a different grant.
  assert.match(PANEL, /useEffect\(\(\) => \{[\s\S]{0,240}return stopPolling;\s*\}, \[planId\]\)/,
               'the poll is no longer abandoned when the plan changes');
  assert.ok(PANEL.includes('polling.current.stopped'),
            'a poll in flight has no way to find out it was abandoned');
});

test('a running analysis says so rather than looking like an empty result', () => {
  // The rule findings are on screen while the model is still working. Without a line saying the
  // other half is coming, that screen is indistinguishable from "the model found nothing".
  assert.ok(PANEL.includes('규칙 판정을 먼저 표시합니다'));
  assert.ok(PANEL.includes('progress.batches'), 'the page no longer shows how far along the run is');
});

test('a card is folded shut, and the fold shows what decides whether to open it', () => {
  // Thirty-eight cards open at once is a page nobody reads to the end. What must survive the fold
  // is everything the reader needs to decide WHICH to open - the grade, the id, the title, and the
  // badges that say whether it can be restricted at all and whether a rule already found it.
  const card = PANEL.slice(PANEL.indexOf('function Card('), PANEL.indexOf('function Summary('));
  assert.match(card, /<details className=\{`finding grade-/,
               'the card is no longer a details element, so it cannot be collapsed');
  assert.ok(!/<details[^>]*\bopen\b/.test(card), 'cards render expanded, which is what this avoids');
  const fold = card.slice(card.indexOf('<summary'), card.indexOf('</summary>'));
  for (const required of ['GRADE_CLASS[finding.escalationGrade]', 'finding.id', 'finding.title',
                          'finding.restrictable', 'alreadyFoundBy', 'STATUS_LABEL']) {
    assert.ok(fold.includes(required), `${required} fell below the fold`);
  }
  // The narrative and the containment are the body - if they were in the summary the fold would
  // save nothing.
  assert.ok(!fold.includes('finding.narrative'));
  assert.ok(!fold.includes('<Containment'));
});

test('a folded card can be opened from the keyboard', () => {
  // The default marker is hidden so the arrow can sit inside the flex row. Hiding it without
  // restoring a focus ring leaves a control an approver on a keyboard cannot see they have reached.
  assert.match(CSS, /\.finding > summary\s*\{[^}]*list-style:\s*none/);
  assert.match(CSS, /\.finding > summary:focus-visible\s*\{[^}]*outline:/,
               'the summary has no focus ring, so keyboard users cannot see what they are on');
});

test('a card that names actions to deny also names what denying them breaks', () => {
  // The whole point of the containment block. An approver given a list of actions and no cost
  // denies, finds out at the next deploy, and reverts - and the analysis has then produced a worse
  // outcome than saying nothing. So the cost is not behind a conditional of its own: if there are
  // deny actions there is a 막히는 일 row.
  const block = PANEL.slice(PANEL.indexOf('function Containment('), PANEL.indexOf('function Card('));
  assert.ok(block.includes('c.denyActions.map'), 'the actions to deny are no longer rendered');
  assert.ok(block.includes('막히는 일'), 'the card no longer says what denying them breaks');
  assert.ok(block.includes('{c.breaks}'), 'the cost row is no longer filled from the verdict');
  assert.ok(/denyActions\.length === 0\) return null/.test(block),
            'the block is rendered with no actions in it, which reads as "nothing to do"');
});

test('a deny action on the declaration path is struck through and never quietly dropped', () => {
  // Two failures avoided at once. Offering it as deniable locks the user out of the pipeline that
  // governs the permission set; removing it from the list without a word turns a qualified answer
  // into a shorter one, and the reader cannot tell which they are looking at.
  const block = PANEL.slice(PANEL.indexOf('function Containment('), PANEL.indexOf('function Card('));
  assert.ok(block.includes('c.notRestrictable'), 'the block no longer reads the forbidden set');
  assert.ok(!/denyActions\.filter\([^)]*\)\.map/.test(block),
            'the deny list is being filtered before rendering, so a forbidden action vanishes');
  assert.match(CSS, /\.deny-forbidden\s*\{[^}]*line-through/,
               'the forbidden action is distinguished by colour alone');
});

test('a path the rules already found says so on the card', () => {
  // Both halves run over the same digest and collide - measured at twelve of twenty-one candidates
  // on one assessment, twice at two different grades. Unlabelled, the reader counts one path as two
  // findings and has to decide which half of their own tool to believe.
  assert.ok(PANEL.includes('finding.alreadyFoundBy'),
            'the page no longer shows which rules already cover a model finding');
  assert.ok(PANEL.includes('중복'));
});

test('every rule id the file defines can appear on a card', () => {
  // Not a rendering rule - a wiring one. The page keys cards by id and groups by category, so a
  // category the page has no section for would render a finding nowhere at all.
  const categories = new Set(RULES.map((r) => r.category));
  for (const category of categories) {
    assert.ok(PANEL.includes(`category: "${category}"`),
              `the page has no section for ${category}, so its findings would not be shown`);
  }
});

// ---- the inline policy an administrator is about to approve -------------------------------------

const IMPACT = readFileSync(new URL('../src/components/Impact.tsx', import.meta.url), 'utf8');

test('the inline policy preview is over every policy, not one at a time', () => {
  // The permission set has ONE inline document and every Deny in it spends one 10,240 character
  // quota, whatever policy prompted it. A per-policy preview would show four documents that do not
  // exist and hide the one that does.
  assert.ok(IMPACT.includes('<InlinePreview'), 'the preview is gone');
  const mounted = IMPACT.slice(IMPACT.indexOf('<InlinePreview'), IMPACT.indexOf('<PolicyBlock'));
  assert.ok(mounted.includes('restrictions={restrictions}'),
            "the preview was given one policy's restrictions rather than all of them");
  assert.ok(IMPACT.indexOf('<InlinePreview') < IMPACT.indexOf('<PolicyBlock'));
});

test('the page does not compose the policy itself', () => {
  // A web tier that authors IAM content is a web tier that can grant, which is why decisions cross
  // the wire and not documents. The preview is composed by server/inlinePreview.js, which a fixture
  // test pins byte-for-byte against generator/restriction.py - a preview that differed from what
  // gets written would be a wrong answer with a screenshot.
  assert.ok(/composeInline/.test(IMPACT) && /server\/inlinePreview\.js/.test(IMPACT),
            'Impact.tsx no longer uses the pinned composer');
  assert.ok(!/Sid: `AdminDeny/.test(IMPACT),
            'Impact.tsx builds statements of its own again, which is the drift the module removed');
});

test('the preview says it is a preview, and shows the fence', () => {
  const block = IMPACT.slice(IMPACT.indexOf('function InlinePreview('),
                             IMPACT.indexOf('const INTENT_LABEL'));
  assert.ok(block.includes('미리보기'), 'the preview no longer says the writer is the authority');
  assert.ok(block.includes('fenceServices'),
            'the fence is not in the preview, so the deployed document would have a statement the '
            + 'approver never saw');
  assert.ok(block.includes('INLINE_LIMIT'), 'the quota is not shown beside the size');
});

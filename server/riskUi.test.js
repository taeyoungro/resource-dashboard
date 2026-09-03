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
  // Anchored on the LABEL as it is rendered, not on the first place those two words appear. The
  // window used to start at the first "발화 동작" anywhere in the file, so a comment mentioning the
  // label pushed the start earlier and swept 8,000 characters of unrelated components into the
  // scan - which then failed on a ternary belonging to the containment block.
  const rendered = PANEL.slice(PANEL.indexOf('>발화 동작<'), PANEL.indexOf('<Targets'));
  assert.ok(rendered.length > 0 && rendered.length < 600,
            'the anchor no longer bounds the action list alone');
  assert.ok(!/\bslice\(|\.length\s*>\s*\d+\s*\?|등\b/.test(rendered),
            'the action list is being truncated, capped or abbreviated');
});

test('a card carries the grade, the id, the title, the narrative and the restrictable badge', () => {
  const card = PANEL.slice(PANEL.indexOf('export function RiskFindingCard('), PANEL.indexOf('function Summary('));
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
  // It costs money and takes seconds. The panel exposes two buttons - 정책 기반 분석 and AI 분석 -
  // and no effect that fires on mount for either.
  assert.ok(PANEL.includes('api.analyse(planId, "ai", policy)'));
  assert.ok(PANEL.includes('api.analyse(planId, "rules", policy)'));
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
  // The findings are dropped with it, and for the same reason: the resource diagram draws them
  // per resource, and findings about the plan an approver just left would be a lie with no way to
  // see it.
  assert.match(DETAIL, /useEffect\(\(\) => \{ setAnalysis\(null\); setFindings\(\{\}\); \}, \[detail\.plan_id/,
               'the citation and the findings are no longer dropped when the plan changes');
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
  assert.match(PANEL, /useEffect\(\(\) => \{[\s\S]{0,240}return stopPolling;\s*\}, \[planId, policy\]\)/,
               'the poll is no longer abandoned when the plan or the scope changes');
  assert.ok(PANEL.includes('polling.current.stopped'),
            'a poll in flight has no way to find out it was abandoned');
});

test('a running analysis says so rather than looking like an empty result', () => {
  // The rule findings are on screen while the model is still working. Without a line saying the
  // other half is coming, that screen is indistinguishable from "the model found nothing".
  assert.ok(PANEL.includes('규칙 판정을 먼저 표시합니다'));
  assert.ok(PANEL.includes('progress.batches'), 'the page no longer shows how far along the run is');
});

// ---- 정책 기반 분석 / AI 분석: two buttons, and pressing both looks like the one button used to ---

test('two independent buttons, not a relabelled single one', () => {
  assert.ok(PANEL.includes('정책 기반 분석'), 'the rules button is gone');
  assert.ok(PANEL.includes('AI 분석'), 'the AI button is gone');
  assert.match(PANEL, /onClick=\{\(\) => run\("rules"\)\}[\s\S]{0,40}disabled=\{busyRules\}/,
               'the rules button no longer has a request and a busy state of its own');
  assert.match(PANEL, /onClick=\{\(\) => run\("ai"\)\}[\s\S]{0,40}disabled=\{busyAi\}/,
               'the AI button no longer has a request and a busy state of its own');
});

test('the two buttons are toggles that compose, not a two-way choice', () => {
  // wantRules and wantAi are each set by their own button and never cleared by the other -
  // pressing one does not undo the other having been pressed.
  assert.match(PANEL, /const \[wantRules, setWantRules\] = useState\(false\)/);
  assert.match(PANEL, /const \[wantAi, setWantAi\] = useState\(false\)/);
  assert.ok(!/setWantRules\(false\)/.test(PANEL.slice(PANEL.indexOf('const run = async'))),
            'something past run() turns 정책 기반 분석 off again');
  assert.ok(!/setWantAi\(false\)/.test(PANEL.slice(PANEL.indexOf('const run = async'))),
            'something past run() turns AI 분석 off again');
  assert.match(PANEL,
               /const view: View \| null = wantRules && wantAi \? "both" : wantRules \? "rules" : wantAi \? "ai" : null;/,
               'both buttons pressed no longer composes into "both"');
});

test('정책 기반 분석 never starts or stops the model poll', () => {
  // The entire reason two buttons exist rather than one relabelled: pressing the free one must not
  // touch the paid one's lifecycle, whether that means starting it or - the easier mistake to make -
  // silently killing an AI 분석 poll that was already running.
  const run = PANEL.slice(PANEL.indexOf('const run = async'),
                          PANEL.indexOf('// Which half or halves are on screen'));
  const rulesBranch = run.slice(run.indexOf('setWantRules(true);'));
  assert.ok(!rulesBranch.includes('stopPolling()'), '정책 기반 분석 stops the AI poll');
  assert.ok(!rulesBranch.includes('poll()'), '정책 기반 분석 starts its own poll');
  assert.ok(!rulesBranch.includes('onAnalysis('),
            '정책 기반 분석 touches the citation - only a model answer has anything new to cite');
  // It reads the request body's engine field so the server knows not to bill the model.
  assert.ok(PANEL.includes('api.analyse(planId, "rules", policy)'));
});

test('a rules-only response cannot regress an AI run that is already in flight', () => {
  // If it simply replaced `answer`, a rules click landing while the model is being polled would
  // overwrite analysis/run with the rules-only response's null versions and the page would show
  // "not running" under a run that is very much still running.
  const run = PANEL.slice(PANEL.indexOf('const run = async'),
                          PANEL.indexOf('// Which half or halves are on screen'));
  const rulesBranch = run.slice(run.indexOf('setWantRules(true);'));
  assert.match(rulesBranch,
               /analysis: prev\.analysis, analysis_error: prev\.analysis_error, run: prev\.run/,
               'the rules response no longer preserves the AI half already on screen');
});

test('everything about the model is hidden in the rules-only view', () => {
  // Each of these read something false or pointed at something invisible when 정책 기반 분석 alone
  // was on screen, before they were gated: the "still running" notice, "규칙 판정만 표시합니다"
  // when the model was never asked, the discarded-run banner, the rejected-candidates list, and the
  // model's own rows inside 판정 범위.
  for (const gated of [
    'answer?.run?.state === "running"',
    'answer.analysis_error',
    'model?.discarded',
    'model && model.rejected.length > 0',
    'model && model.failures.length > 0',
    'model && model.dropped.length > 0',
  ]) {
    assert.ok(PANEL.includes(`view !== "rules" && ${gated}`),
              `${gated} is no longer scoped away from the rules-only view`);
  }
});

test('the overlap sentence only appears when both halves are actually shown', () => {
  // "그중 N건은 규칙이 이미 찾은 경로" exists to reconcile two VISIBLE lists so their counts do not
  // look like a contradiction. In the AI-only view there are no rule cards on screen for it to
  // reconcile against, so it would be pointing at something the reader cannot see.
  assert.match(PANEL, /view === "both" && \(answer\.candidates_covered_by_rules \?\? 0\) > 0/,
               'the overlap line is shown outside the combined view');
});

test('the findings a view shows are filtered by finding.source, and "both" filters nothing', () => {
  assert.match(PANEL, /view === "ai" \? combined\.filter\(\(f\) => f\.source === "model"\)/);
  assert.match(PANEL, /view === "rules" \? combined\.filter\(\(f\) => f\.source !== "model"\)/);
  assert.match(PANEL, /:\s*combined;/, '"both" no longer falls through to the unfiltered list');
});

test('the meta line is built from parts filtered by view, not one conditional string', () => {
  // Unrolled specifically so a view can drop a LEADING fragment without leaving a stray " · " at
  // the front of the line - a single template string with the separator baked into each fragment
  // cannot do that once the fragment that used to come first is hidden.
  const meta = PANEL.slice(PANEL.indexOf('function metaParts('), PANEL.indexOf('function Summary('));
  for (const [label, needle] of [
    ['rule count', 'if (view !== "ai") parts.push(`규칙 ${answer.rule_findings.length}건`)'],
    ['model verdict count', 'view !== "rules" && model'],
    ['digest size', '질의 크기 ${(answer.digest_bytes / 1024).toFixed(1)} KB'],
    ['model timing', 'view !== "rules" && model?.timing'],
    ['rules sha', 'if (view !== "ai") parts.push(<>규칙 <code>{answer.rules_sha256.slice(0, 12)}</code></>)'],
  ]) {
    assert.ok(meta.includes(needle), `${label} fragment is missing or no longer view-scoped`);
  }
});

test('a card is folded shut, and the fold shows what decides whether to open it', () => {
  // Thirty-eight cards open at once is a page nobody reads to the end. What must survive the fold
  // is everything the reader needs to decide WHICH to open - the grade, the id, the title, and the
  // badges that say whether it can be restricted at all and whether a rule already found it.
  const card = PANEL.slice(PANEL.indexOf('export function RiskFindingCard('), PANEL.indexOf('function Summary('));
  assert.match(card, /<details className=\{`finding grade-/,
               'the card is no longer a details element, so it cannot be collapsed');
  // Collapsed BY DEFAULT. The fold is now a prop, because the diagram's popup shows one card and
  // wants it open - but the default is false and nothing on THIS page passes it, so the list of
  // thirty-eight is exactly as folded as it was.
  assert.ok(card.includes('defaultOpen = false') && card.includes('open={defaultOpen || undefined}'),
            'the fold is not a defaulted-shut prop, so a caller could open the whole list');
  const page = PANEL.slice(PANEL.indexOf('function RiskScope('));
  assert.ok(!page.includes('defaultOpen'), 'this page opens its own cards, which is what this avoids');
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
                             IMPACT.indexOf('function PolicyInlinePreview('));
  assert.ok(block.length > 0 && block.length < IMPACT.length, 'the slice caught the wrong component');
  assert.ok(block.includes('미리보기'), 'the preview no longer says the writer is the authority');
  assert.ok(block.includes('fenceGrants'),
            'the fence is not in the preview, so the deployed document would have a statement the '
            + 'approver never saw');
  assert.ok(block.includes('INLINE_LIMIT'), 'the quota is not shown beside the size');
});

const PICKER = readFileSync(new URL('../src/components/ActionPicker.tsx', import.meta.url), 'utf8');
// The four intents' one home - Impact's editor, its ActionPicker and the block-path dialog all
// import from it, so a restriction reads the same whichever door it came through.
const INTENTS = readFileSync(new URL('../src/components/intents.ts', import.meta.url), 'utf8');
const BLOCK = readFileSync(new URL('../src/components/BlockPath.tsx', import.meta.url), 'utf8');

test('the five sections compose - a policy is not one intent at a time', () => {
  // It was one dropdown, so a policy carried exactly one intent and choosing a second meant giving
  // up the first. That was never a property of the statements: the permission set holds ONE inline
  // document and each decision composes its own statement into it, so "이 버킷만 남기고, 그리고
  // DeleteBucket은 아예 막는다" is two statements and always was.
  assert.ok(!/<select[\s\S]{0,200}INTENT_LABEL/.test(IMPACT),
            'the intent is a dropdown again, so the sections are mutually exclusive');
  assert.match(INTENTS, /export const SECTIONS: Restriction\["intent"\]\[\] = \[\s*"allow_only", "deny_only", "deny_action", "tag_condition", "key_condition",/,
               'the five sections are not declared as a list the editor renders one block per');
  // One home for the vocabulary. The editor and the block-path dialog composing from two copies is
  // how the same decision ends up reading as two different things depending on the door.
  assert.ok(IMPACT.includes('from "./intents"'), 'the editor stopped importing the shared intents');
  assert.ok(BLOCK.includes('from "./intents"'),
            'the block dialog carries its own intent vocabulary');
  assert.match(IMPACT, /SECTIONS\.map\(\(intent\) => \{/,
               'the editor no longer renders a block per section');
  // The draft is per section, and every section composes into the same emitted list.
  assert.match(IMPACT, /type Draft = Record<Restriction\["intent"\], Choice\[\]>/,
               'the editor holds one intent and one action list again');
  assert.match(IMPACT, /SECTIONS\.flatMap\(\(intent\) => next\[intent\]\.map/,
               'compose no longer walks every section, so a section would be silently dropped');
});

test('an action a resource list cannot scope has a section of its own', () => {
  // It used to be a fold at the bottom of every picker: the right data in the wrong place, because
  // ticking it composed a statement of a different KIND from everything else in the dialog and the
  // fold's own paragraph had to say so. It is a decision, not a side effect - and it is the only
  // way to say "this user may not call lambda:CreateFunction at all".
  assert.ok(!PICKER.includes('flatDenyBlock'),
            'the fold is back inside the picker, so the section is a second way to say one thing');
  assert.ok(INTENTS.includes('deny_action: "동작 자체 거부"'), 'the section has no name');
  // The scoped sections do not offer them at all. offeringFor is what removes them.
  assert.match(IMPACT, /const offeringFor = \(intent: Restriction\["intent"\]\) => \{[\s\S]{0,200}if \(intent === "deny_action"\) return \{ offering: covered, hidden: 0, unsafe: 0 \}/,
               '동작 자체 거부 is being filtered like the scoped sections, so it offers nothing');
  assert.match(IMPACT, /!o\.account_level && !o\.creates_target/,
               'the scoped offering is filtered on only one of the two reasons');
  // Not left missing. An approver who cannot find an action has to learn where it went.
  assert.ok(IMPACT.includes('elsewhere={hidden > 0'), 'the count of what went is not passed on');
  assert.ok(PICKER.includes('자원 목록으로 좁힐 수 없는 동작'),
            'the dialog does not say what is missing from its offering');
  assert.match(CSS, /\.pick-elsewhere\b/, 'the line saying so has no style');
});

test('one action is never in two sections at once', () => {
  // 이 자원만 허용 on s3:GetObject and 동작 자체 거부 on s3:GetObject compose a NotResource
  // statement the flat Deny beside it makes moot - bytes spent to say nothing, and a document an
  // approver cannot read. Refused at the pick rather than reconciled afterwards, and the row says
  // WHICH section has it, because that is the answer to the question a disabled checkbox raises.
  assert.match(IMPACT, /const heldElsewhere = \(intent: Restriction\["intent"\]\) => \(action: string\) => \{/,
               'nothing answers which other section holds an action');
  assert.ok(IMPACT.includes('cannotHold={heldElsewhere(intent)}'),
            'the picker is not given the rule, so a second section can take the same action');
  assert.ok(IMPACT.includes('이미 "${INTENT_LABEL[other]}"에 있다'),
            'the refusal does not name the section that has it');
  assert.match(PICKER, /const taken = chosenFor \? null : cannotHold\(action\)/,
               'the row no longer asks whether another section holds the action');
  assert.match(PICKER, /disabled=\{off\}/, 'a row another section holds is still tickable');
  // And the typed escape hatch goes through the same gate - it is the one way a scoped section
  // could otherwise take an action its offering never showed.
  assert.match(PICKER, /const typedRefusal = typed\.trim\(\) \? cannotHold\(typed\.trim\(\)\) : null/,
               'a hand-typed name bypasses the rule the checkboxes are held to');
  assert.match(PICKER, /if \(!action \|\| typedRefusal\) return;/, 'the refusal does not stop the add');
});

test('an action that MAKES the resource it names is kept out for its own reason', () => {
  // The second way a list of ARNs is no scope, and the one nothing was checking.
  // Deny lambda:CreateFunction NotResource [testLambda, testLambda2] reads as "you may create a
  // function called testLambda or testLambda2", and both already exist.
  assert.ok(PICKER.includes('creates_target'), 'the offer does not carry the answer');
  assert.match(PICKER, /const flatOnly = \(offer: Offer\) =>[\s\S]{0,80}creates_target/,
               'the two reasons are not sharing one test, so only one of them is kept out');
  // Distinct wording. "자원을 인자로 받지 않는다" beside lambda:CreateFunction is simply false -
  // it does name a resource, and the resource is the one it is about to make.
  assert.ok(PICKER.includes('자원을 인자로 받지'),
            'the line no longer distinguishes the action that HAS no resource');
  assert.ok(PICKER.includes('만드는'), 'the line does not say why the other half is kept out');
  // And every place that asked "can this be scoped" asks the generalised question.
  for (const site of ['return !flatOnly(offer);', '!flatOnly(offer)']) {
    assert.ok(PICKER.includes(site), `a scoping decision still reads account_level alone: ${site}`);
  }
  assert.ok(IMPACT.includes('entry[1].length === 0 || entry[2] === true'),
            'the editor splits on only one of the two reasons');
});

test('전체 선택 on a service does not sweep in what this section cannot hold', () => {
  // The flat denies are no longer in a scoped section's offering at all, so what this guards is
  // the remaining way in: an action another section already holds, and one nothing can scope.
  // Sweeping either in under a button labelled 전체 선택 makes a decision on the administrator's
  // behalf while implying it merely ticked some checkboxes.
  const toggle = PICKER.slice(PICKER.indexOf('const blockToggle ='),
                              PICKER.indexOf('const byLevel ='));
  assert.ok(toggle.includes('!cannotHold(o.action)'),
            '전체 선택 selects actions this section cannot hold');
  assert.ok(toggle.includes('!unreachableAction(o.action)'),
            '전체 선택 selects actions the dialog cannot then write');
});

test('an existing flat deny is read back into the section that owns it', () => {
  // Before 동작 자체 거부 existed the editor emitted these as deny_only with an empty resource list
  // - the only statement one of them ever had. Reading a stored restriction back into the section
  // that now owns it is reading it back as what it is, not a guess. Leaving it in deny_only would
  // put an action in a section whose picker will not offer it, with no checkbox to clear it.
  const seed = IMPACT.slice(IMPACT.indexOf('const seedFrom = (source: Restriction[])'),
                            IMPACT.indexOf('const tagSeed ='));
  assert.match(seed, /flatOnly\(action\) \? "deny_action" : restriction\.intent/,
               'a stored flat deny is seeded into the intent it was written under');
  assert.ok(seed.includes('into === "deny_action" ? []'),
            'resources ride along into a section whose statement has no resource clause');
  // Both reasons, one test. The second is the action that makes what it names.
  const flat = IMPACT.slice(IMPACT.indexOf('const flatOnly = (action: string)'),
                            IMPACT.indexOf('const seedFrom ='));
  assert.ok(flat.includes('entry[1].length === 0 || entry[2] === true'),
            'the editor splits on only one of the two reasons');
  // Unknown is neither. An action the reference does not carry must not be guessed at.
  assert.ok(flat.includes(': false'),
            'an action missing from the reference is being treated as flat-only');
});

test('a section that carries no resource clause sends none', () => {
  // deny_action composes Deny on Resource "*" and tag_condition composes a condition. A resource
  // list on either would be recorded in the marker and never reach the statement - which is what
  // the decision route and generator/restriction.py both refuse by name.
  const compose = IMPACT.slice(IMPACT.indexOf('const compose = (next: Draft'),
                               IMPACT.indexOf('const emit = (next: Draft'));
  assert.match(compose, /isScoped\(intent\)\s*\?\s*\{ resources: choice\.resources \}/,
               'a section that names no resources is being sent a resource list');
  assert.match(compose, /intent === "tag_condition" \? tag : \{\}/,
               'deny_action is being sent a tag, or tag_condition is not being sent one');
  assert.match(INTENTS, /export const isScoped = \(intent: Restriction\["intent"\]\) =>\s*intent === "allow_only" \|\| intent === "deny_only";/,
               'which sections carry a resource list is no longer stated in one place');
});

test('the service wildcard is offered, never applied', () => {
  // The wildcard becomes the administrator's decision and travels as the action. A page that
  // quietly widened [8 names] into athena:* would be restricting actions this approval does not
  // grant, which generator/restriction.py refuses by name - and which after B-1 it can see.
  const offer = IMPACT.slice(IMPACT.indexOf('const foldOffer ='),
                             IMPACT.indexOf('const emitted = compose('));
  assert.ok(offer.includes('serviceFold({'), 'the offer no longer asks the shared module');
  assert.ok(offer.includes('<button'), 'the fold is applied without the administrator choosing it');
  assert.ok(offer.includes('folded.adds'), 'what the wildcard additionally denies is not shown');
  // One resource clause only. A mixed set is several statements and folding them together is a
  // different operation from this one.
  assert.ok(offer.includes('one.size !== 1'),
            'the offer no longer requires a single resource clause');
  assert.ok(offer.includes('intent === "tag_condition"'),
            'a tag condition is being offered a wildcard, where the members carry no tag');
  // Per section, because the fold is a property of one statement and the sections are separate
  // statements. Folding across them would offer one wildcard for two different resource clauses.
  assert.match(IMPACT, /\{foldOffer\(intent, choices\)\}/,
               'the fold offer is no longer rendered per section');
  assert.ok(offer.includes('setSection(intent, [{'),
            'accepting the fold replaces the whole policy rather than the section');
});

test('nothing sizes a document out of one policy\'s restrictions', () => {
  // The permission set has ONE inline document and one 10,240 byte quota, so a figure composed from
  // a subset of the restrictions is not a smaller version of the answer - it is a different number
  // wearing the same label. The editor used to print exactly that: with 60 actions here and 60 on
  // another policy it read 5,889 bytes twenty pixels above 11,770 for the same document, and under
  // its 80% gate it printed nothing, which reads as "it fits".
  const editor = IMPACT.slice(IMPACT.indexOf('function RestrictionEditor('));
  assert.ok(!editor.includes('INLINE_LIMIT'),
            'the editor sizes something again, and it can only see one policy');
  // The RENDERED form, not the string - the comment where the estimate used to be quotes its label
  // so the next reader can find this. A label followed by an interpolated byte count is the thing
  // that must not come back.
  assert.ok(!/인라인 정책 예상 크기[^\n]*\{/.test(IMPACT), 'the per-policy-only estimate is back');

  // The two that remain both compose EVERY policy's restrictions.
  const whole = IMPACT.slice(IMPACT.indexOf('function InlinePreview('),
                             IMPACT.indexOf('function PolicyInlinePreview('));
  assert.match(whole, /composeInline\(active/, 'the document-wide preview stopped composing');
  assert.match(IMPACT, /<InlinePreview[\s\S]{0,200}restrictions=\{restrictions\}/);
  assert.match(IMPACT, /<PolicyInlinePreview[\s\S]{0,400}restrictions=\{restrictions\}/);
});

test('every composition on the page carries the creation-exemption patterns', () => {
  // An allow_only statement on a creating action exempts the whole of every type the call brings
  // into being - without it the Deny matches the resource being created (whose ARN nobody has yet)
  // and 'only into this subnet' denies every ec2:CreateNetworkInterface in the account. The writer
  // composes the exemption from its table; the page has to compose the SAME BYTES from the
  // assessment's created_formats, and a composition this file forgot to hand the map to would show
  // a narrower NotResource than what gets written.
  assert.match(IMPACT, /function createdFormatsOf\(reference: ImpactActionReference \| null\)/,
               'nothing derives the per-action patterns from the reference');
  assert.match(IMPACT, /<InlinePreview[\s\S]{0,400}createdFormats=\{createdFormatsOf\(assessment\.action_reference \?\? null\)\}/,
               'the document-wide preview composes without the exemptions');
  assert.match(IMPACT, /<PolicyInlinePreview[\s\S]{0,500}createdFormats=\{createdFormats\}/,
               'the per-policy excerpt composes without the exemptions');
  // And it reaches policyContribution's options - the attribution key must match the fold's key,
  // exemptions included, or a creating decision drops out of its own policy's excerpt.
  assert.match(IMPACT, /policyContribution\(restrictions, policy,[\s\S]{0,200}createdFormats/,
               'the excerpt attribution is keyed without the exemptions');
  assert.match(IMPACT, /const createdFormats = useMemo\(\(\) => createdFormatsOf\(reference\), \[reference\]\)/,
               'the per-policy map is not memoised, so the excerpt recomposes every render');
});

test('the per-policy view is not recomposed on every keystroke', () => {
  // Its memo takes fenceGrants as a dependency. Called inline inside restrictable.map that is a
  // fresh array identity every render, so the memo never hit: each of N policy blocks recomposed
  // the whole document twice - and serialised every statement - on each character typed into a tag
  // field. The value changes only when the assessment does.
  assert.match(IMPACT, /const fenceGrants = useMemo\(\s*\(\) => fenceGrantsOf\(assessment\.passrole_grants\), \[assessment\.passrole_grants\],\s*\)/,
               'fenceGrants is not memoised, so the per-policy memo never caches');
  assert.ok(!/fenceGrants=\{fenceGrantsOf\(/.test(IMPACT),
            'a fresh array is still being passed down');
  // The other two array-valued dependencies of the same memo, for the same reason.
  assert.match(IMPACT, /const policyFenceServices = useMemo\(/);
  assert.match(IMPACT, /const nested = useMemo\(\(\) => nestedActions\(reference\), \[reference\]\)/);
});

test('the fence is described as being in the figure it is actually in', () => {
  // It is in `total` - the document carries it and the quota counts it - and out of `share`, where
  // it cancels because it stands in both sides of the subtraction. Saying "not in the size above"
  // was true of one number and false of the other, and the false one is the one compared against
  // the limit, so an approver discounted 427 bytes that were really there.
  const block = IMPACT.slice(IMPACT.indexOf('function PolicyInlinePreview('),
                             IMPACT.indexOf('type Draft ='));
  assert.ok(block.includes('늘리는 크기에는 들어 있지 않고'), 'the fence text lost the share half');
  assert.ok(block.includes('문서 전체 크기와 한도에는 들어 있다'),
            'the dialog says the fence is outside the number the quota is compared against');
  assert.ok(!/위의\s*크기 계산에는 들어 있지 않다/.test(block),
            'the old undifferentiated claim is back');
});

test('the empty state does not contradict the fence printed under it', () => {
  // A policy with a PassRole grant puts a statement in the document with nothing ticked, and the
  // fence renders in this same dialog - so "this policy contributes nothing" was printed directly
  // above one of its statements. And with nothing chosen anywhere, InlinePreview renders nothing,
  // so naming it as somewhere to look pointed at a control that is not on the page.
  const block = IMPACT.slice(IMPACT.indexOf('function PolicyInlinePreview('),
                             IMPACT.indexOf('type Draft ='));
  const empty = block.slice(block.indexOf('view.statements.length === 0 ? ('),
                            block.indexOf(') : ('));
  assert.ok(empty.includes('view.fence.length > 0'),
            'the empty state does not check whether the fence is about to render below it');
  assert.ok(empty.includes('totalStatements === 0'),
            'the empty state cannot tell "no document yet" from "all of it is other policies"');
  assert.ok(!empty.includes('인라인 정책 보기'),
            'the empty state points at a control that may not be rendered');
});

test('an action that still needs a resource cannot be committed', () => {
  // generator/restriction.py refuses a decision naming no resource unless every action in it is
  // account-level: allow_only would compose an empty NotResource, which denies everywhere, and
  // deny_only would compose Resource "*", which denies the action outright rather than on the
  // resources the administrator meant. That refusal used to arrive on submit, after the whole
  // restriction was assembled.
  assert.ok(PICKER.includes('const needsResource ='), 'the gate is gone');
  assert.match(PICKER, /const needsPick = draft\.filter\([\s\S]{0,160}needsResource\(c\.action\) === true/,
               'the blocking set no longer asks whether the action needs a resource');
  assert.match(PICKER, /className="commit"[\s\S]{0,120}disabled=\{needsPick\.length > 0\}/,
               '적용 presses while a choice cannot be written');
  // Named in the footer, not counted. "자원 미지정 3개" says something is wrong and not which row.
  assert.ok(PICKER.includes('자원을 지정해야 쓸 수 있다'), 'the footer does not name them');
});

test('an action nothing can ever scope does not hold 적용 shut', () => {
  // The dead end this exists to stop. athena:CreateCapacityReservation names capacity-reservation,
  // the account holds none, so no list of ARNs will ever scope it - and six of them arrived through
  // 전체 선택 66개 and left 적용 grey with no row to go and fix. Waiting on a pick and having
  // nothing to pick are different states and the gate has to tell them apart.
  assert.ok(PICKER.includes('const unreachableAction ='), 'the two states are one state again');
  assert.match(PICKER, /const needsPick = draft\.filter\([\s\S]{0,160}!unreachableAction\(c\.action\)\)/,
               '적용 is still held shut by an action nothing can scope');
  // Dropped rather than written. A flat Deny on "*" is a defensible reading of allow_only and it is
  // not the administrator's - these arrive through 전체 선택, not through a ticked checkbox.
  assert.match(PICKER, /const writable = draft\.filter\(\(c\) => !unreachableAction\(c\.action\)\)/,
               'what cannot be composed is still handed to the container');
  assert.match(PICKER, /onClick=\{\(\) => onCommit\(writable\)\}/, '적용 hands back the whole draft');
  // Said, not silently dropped. Ticking 66 and getting 60 is owed an explanation by name.
  assert.ok(PICKER.includes('닿는 자원이 없어 빠진다'), 'the six that went are not named');
  assert.match(CSS, /\.dropped-actions\b/, 'the line naming them has no style');
  assert.ok(!/\.dropped-actions\s*\{[^}]*--danger/.test(CSS),
            'a line beside a working 적용 is red, which reads as something to fix');
});

test('전체 선택 does not sweep in what nothing can scope', () => {
  // The one way into that dead end: the row's own checkbox is disabled, so 전체 선택 was the only
  // door. Same exclusion as the account-level actions get, for a different reason - those are a
  // different KIND of statement, these are no statement at all.
  const toggle = PICKER.slice(PICKER.indexOf('const blockToggle ='),
                              PICKER.indexOf('const byLevel ='));
  assert.ok(toggle.includes('!unreachableAction(o.action)'),
            '전체 선택 selects actions the dialog cannot then write');
});

test('an account-level action is not asked for a resource it cannot have', () => {
  // The flat Deny is the only shape that restricts one, and it needs no resources. Blocking those
  // would leave no expressible way to restrict them at all.
  assert.ok(PICKER.includes('return !flatOnly(offer);'),
            'account-level actions are being asked for resources');
});

test('an action the reference does not carry is not blocked here', () => {
  // Typed by hand - the escape hatch for what the reference does not cover. Nothing on this page
  // can say whether it names a resource, and the container has a floor list of its own, so the
  // refusal stays where it can be made correctly.
  assert.match(PICKER, /if \(!offer\) return null;/,
               'an unknown action is being judged rather than passed through');
});

test('an action nothing in the assessment reaches is unselectable, and says why', () => {
  // Whatever is ticked there the container refuses. An approver looking for the action needs to
  // find out it is unrestrictable, not fail to find it - so the row is present and disabled.
  assert.match(PICKER, /const dead = unreachableAction\(action\)/);
  assert.match(PICKER, /needsResource\(action\) === true && reachedBy\(action\)\.length === 0/,
               'what counts as unreachable is no longer "takes a resource and can reach none"');
  assert.match(PICKER, /const off = dead \|\| Boolean\(taken\)/,
               'the disabled state no longer covers both reasons a row cannot be ticked');
  assert.ok(PICKER.includes('disabled={off}'), 'the checkbox is still tickable');
  assert.ok(PICKER.includes('닿는 자원 없음'), 'the row does not say why it is disabled');
  assert.match(CSS, /\.pick-item\.dead\b/, 'a disabled row looks the same as an enabled one');
});

test('the per-policy view is read OUT of the whole document, never composed on its own', () => {
  // The permission set has ONE inline document and a Deny in it applies whatever policy prompted
  // it. Four per-policy documents side by side would be four things that do not exist standing in
  // front of the one that does - and each would renumber its Sids, so an approver matching the
  // excerpt against the deployed policy would be matching against a document nobody wrote.
  const block = IMPACT.slice(IMPACT.indexOf('function PolicyInlinePreview('),
                             IMPACT.indexOf('type Draft ='));
  assert.ok(block.length > 0, 'the per-policy view is gone');
  assert.ok(block.includes('policyContribution('),
            'the per-policy view no longer asks the module that reads the composed document');
  assert.ok(!block.includes('composeInline('),
            'the per-policy view composes a document of its own, which is a document nobody writes');
  // It is handed EVERY restriction, not this policy's. That is what makes the Sids real.
  assert.match(IMPACT, /<PolicyInlinePreview[\s\S]{0,400}restrictions=\{restrictions\}/,
               "the per-policy view is given one policy's restrictions, so its Sids are invented");
  assert.ok(!/<PolicyInlinePreview[\s\S]{0,400}restrictions=\{ours\}/.test(IMPACT));
});

test('the per-policy view says the three things that make it honest', () => {
  // Each of these is a place the obvious implementation is wrong, so each has to be on the screen
  // rather than only in a comment.
  const block = IMPACT.slice(IMPACT.indexOf('function PolicyInlinePreview('),
                             IMPACT.indexOf('type Draft ='));
  // The needle is the SENTENCE, not the identifier. `block.includes('Sid')` was matched by
  // `key={statement.Sid}` and `className="sid"` - load-bearing render code no edit removes - so
  // deleting the entire explanatory paragraph left this green. Proven by deletion: the one sentence
  // telling an approver that AdminDeny1 followed by AdminDeny4 is a slice of a bigger document
  // rather than a corrupt one could go, and all 45 tests passed.
  assert.match(block,
               /<code>Sid<\/code> 번호가 중간에 비어 있을 수 있다[\s\S]{0,60}비어 있는 번호는/,
               'nothing explains why the Sid numbers have gaps');
  assert.ok(block.includes('같은 문장'), 'a statement shared with another policy is not marked');
  assert.ok(block.includes('다른 정책'), 'the other policy\'s actions are not distinguished');
  assert.ok(block.includes('더해도'),
            'the page does not say the per-policy sizes do not add up to the document');

  // The one that contradicts what the reader is about to assume. Two policies can make the
  // IDENTICAL decision - one statement both of them produce - and then unticking it here leaves
  // the Deny standing. Silently, and with share=0 beside a statement listed as this policy's.
  assert.ok(block.includes('coOwned'), 'co-owned statements are not separated from shared ones');
  assert.ok(block.includes('여기서\n                  선택을 지워도 그 문장은 남는다')
            || /선택을 지워도 그 문장은 남는다/.test(block),
            'the page does not say that unticking a co-owned action leaves the Deny in place');
  assert.match(CSS, /\.statement-actions \.co-owned\b/,
               'a co-owned action looks exactly like one this policy controls');

  // alsoBy counts POLICIES; others counts ACTIONS. One policy contributing four actions was
  // rendered as "shared with 4 policies" on a permission set that had two.
  assert.ok(block.includes('alsoBy.length}개와 같은 문장'),
            'the policy count is not taken from the policy identities');
  assert.ok(!/others\.length}개와 공유/.test(block),
            'an action count is being printed with the noun 정책');

  // The share is this policy's; the limit is the document's. Colouring the first by the second
  // turned every policy's dialog red the moment any of them was over.
  assert.ok(block.includes('wouldFix'),
            'the dialog does not say whether removing THIS policy would bring the document back');
  assert.ok(!/className=\{view\.total > INLINE_LIMIT \? "error"/.test(block),
            "the document-wide limit is colouring the sentence about this policy's own size");
  // Rendered as a bare array, not a Version/Statement object - an excerpt that is a valid
  // standalone policy is a wrong answer somebody can screenshot.
  assert.ok(block.includes('readableStatements('), 'the excerpt is rendered as a whole document');
  assert.ok(!block.includes('readable('), 'the excerpt is rendered with the document renderer');
  assert.match(CSS, /\.statement-actions \.from-elsewhere\b/,
               "another policy's action in a shared statement looks the same as this policy's");
});

// ---- from a finding card straight to the restriction that cuts it -------------------------------

test('a finding card offers 차단, and only where a restriction can actually land', () => {
  // No button rather than a dead one: a path the policy cannot cut (restrictable false - the card
  // already wears the 차단 불가 badge), a policy the assessment does not hold as restrictable, or a
  // decision already closed.
  const gateStart = PANEL.indexOf('const blockProps =');
  const gate = PANEL.slice(gateStart, PANEL.indexOf('};', gateStart));
  assert.ok(gate.includes('restrictBlocked'), 'the button renders after the decision closed');
  assert.ok(gate.includes('!finding.restrictable'), 'an uncuttable path still gets a button');
  assert.ok(gate.includes('policyOf(finding)'), 'the button renders with no policy to key on');
  // The policy match is the IDENTIFIER the digest wrote into policyName - exact, not a heuristic.
  assert.match(PANEL, /p\.identifier === finding\.policyName && p\.restrictable && !p\.unreadable/,
               'the finding-to-policy match is no longer exact');
  assert.ok(PANEL.includes('이 경로 차단'), 'the card has no block button');
  // And the confirmation after: the card says the actions are in the document, pointing at the one
  // place that shows it - so the reader does not diff a policy block by eye.
  assert.ok(PANEL.includes('alreadyRestricted(finding, restrictions)'),
            'the card cannot say whether its path is already restricted');
  assert.ok(PANEL.includes('제한에 반영되어 있다'), 'applying gives no confirmation on the card');
});

test('a card with no 차단 button says why, instead of losing the row', () => {
  // The defect, as a user met it: 「모든 카드에서 이 경로 차단 버튼이 사라졌다」. Three states
  // withhold the button and all three produced the SAME silent gap - a decision in flight, a
  // decided plan, and standing restrictions nobody can read - so a reader could not tell which it
  // was, or whether the button had ever been there. The gate itself was right in every case; what
  // was wrong was that it said nothing.
  assert.ok(PANEL.includes('지금은 이 경로를 차단할 수 없습니다'),
            'a card without the button gives no reason for it');
  const at = PANEL.indexOf('const blockWhy =');
  const why = PANEL.slice(at, PANEL.indexOf('const containmentOf', at));
  // The per-card reasons come FIRST: they are permanent facts about the policy the finding names,
  // and a reader told 「결정이 진행 중입니다」 about a baseline policy would wait for something that
  // never changes the answer.
  assert.ok(why.indexOf('is_baseline') < why.indexOf('return restrictBlocked'),
            'the plan-wide reason is printed over a policy that can never be restricted');
  for (const [what, text] of [['not in this assessment', '이 평가에는 이 정책이 없습니다'],
                              ['a baseline policy', '기반 정책입니다'],
                              ['an unreadable policy', '문서를 읽지 못했습니다']]) {
    assert.ok(why.includes(text), `a finding on ${what} gets no reason`);
  }
  // The 차단 불가 badge already carries its own reason, so that card gets no second sentence.
  assert.ok(why.includes('if (!finding.restrictable) return null;'),
            'a path that cannot be cut at all is explained twice');
  // And the plan-wide reason is a SENTENCE from PlanDetail rather than a boolean, because the
  // three states it covers are fixed by three different things.
  assert.match(DETAIL, /const restrictBlocked = busy[\s\S]{0,900}: null;/,
               'the plan-wide reason is not composed where the three causes are known');
  assert.ok(DETAIL.includes('restrictBlocked={restrictBlocked}'),
            'the reason does not reach the cards');
});

test('the block dialog writes into the SHARED restriction set, never a copy', () => {
  // The entire point: a restriction born on a card is indistinguishable from one born in the
  // editor by the time it reaches the wire, and 인라인 정책 보기 shows one document either way.
  assert.ok(BLOCK.includes('mergeBlock(restrictions, finding.policyName, additions())'),
            'the dialog no longer merges through the shared blockPath module');
  assert.ok(BLOCK.includes('blockOffer(finding, protectedActions)'),
            'the offer is no longer derived by the tested module');
  assert.ok(!/useState[^\n]*[Rr]estriction\[\]/.test(BLOCK),
            'the dialog holds its own restriction array, which will drift from the shared one');
  // Wired from PlanDetail with the same state Impact edits, and the same disabled gate.
  assert.match(DETAIL, /<RiskAnalysis[\s\S]{0,300}restrictions=\{restrictions\}/,
               'RiskAnalysis is not given the shared restriction set');
  assert.match(DETAIL, /onRestrictions=\{setRestrictions\}/,
               'the dialog cannot write back into the shared set');
  // Both gates by name rather than the whole expression. Pinning the exact string made a STRONGER
  // gate fail the test: closing the editor when nothing can say what is already restricted is an
  // addition, and a test that forbids additions to a safety condition is a test that argues against
  // safety. What has to hold is that neither of these two is dropped.
  const gate = DETAIL.slice(DETAIL.indexOf('const restrictBlocked = busy'),
                            DETAIL.indexOf('// Whose PassRole request'));
  assert.ok(/\bbusy\b/.test(gate), 'the block button survives a write in flight');
  assert.ok(/\bdecided\b/.test(gate), 'the block button outlives the decision');
  assert.ok(DETAIL.includes('restrictBlocked={restrictBlocked}'),
            'the gate no longer reaches RiskAnalysis');
});

test('the editor is closed when nothing can say what is already restricted', () => {
  // The defect, as a user met it: event one restricts, event two opens an EMPTY form, and
  // approving from it replaces the whole AdminDeny family with whatever is ticked - dropping every
  // earlier restriction while the run reports success.
  //
  // The form is now seeded from what stands. When that cannot be established the seed is null, and
  // null is not []: an empty form would be the same lie with a different cause, so the editor is
  // closed instead. Approving with nothing ticked stays open and is safe - a CLOSED editor sends no
  // restrictions key at all, which the writer reads as saying nothing and carries them forward.
  assert.match(DETAIL, /useState<Restriction\[\]>\(\s*\(\)\s*=>\s*detail\.restrictions_in_force \?\? \[\]/,
               'the restriction editor still opens empty, which is the defect itself');
  assert.match(DETAIL, /const inForceUnknown = detail\.restrictions_in_force === null/,
               'null is not distinguished from [], so "nobody has said" reads as "nothing is set"');
  // The three controls that AUTHOR restrictions, by name. Not every disabled gate in the file:
  // approving with nothing ticked stays available on purpose, because an approval carrying no
  // restrictions is read as saying nothing about them and carries the existing ones forward.
  for (const control of ['RestrictionTemplates', 'Impact']) {
    const block = DETAIL.match(new RegExp(`<${control}[\\s\\S]{0,600}?/>`))?.[0] ?? '';
    assert.ok(block, `${control} is no longer rendered here - this test cannot see it`);
    assert.match(block, /disabled=\{[^}]*inForceUnknown[^}]*\}/,
                 `${control} can author restrictions while what they would replace is unknown`);
  }
  // RiskAnalysis takes the REASON rather than the boolean, so the condition is one line up. It
  // has to be the same condition: the cards' 차단 button authors restrictions exactly as the two
  // controls above do.
  const reason = DETAIL.slice(DETAIL.indexOf('const restrictBlocked = busy'),
                              DETAIL.indexOf('// Whose PassRole request'));
  assert.ok(/\binForceUnknown\b/.test(reason),
            'RiskAnalysis can author restrictions while what they would replace is unknown');
  assert.ok(DETAIL.includes('restrictBlocked={restrictBlocked}'),
            'the condition does not reach RiskAnalysis');
  // And the approver is told why, rather than finding a dead form.
  assert.match(DETAIL, /지금 걸려 있는 제한을 확인할 수 없어/,
               'the editor closes with no explanation on screen');
  // Re-seeded per plan. Carrying one permission set's restrictions onto another's form would
  // compose a decision against the wrong document.
  assert.match(DETAIL, /seededFor\.current !== detail\.plan_id/,
               'switching plans keeps the previous plan\'s restrictions in the form');
});

test('an emptied form is a clear, and a closed editor is not', () => {
  // The defect this pins, as a user met it: every restriction unticked, 승인 pressed, the run
  // reports success, and every restriction is still in force. The approver could add and change but
  // never remove - [] and "said nothing" were one value all the way down to the writer's compose().
  //
  // What separates them is whether the editor could be USED. It is closed with no assessment and
  // closed when what stands cannot be read, and in both cases the form is empty because nobody
  // could fill it - reading that as a clear would delete restrictions off a screen that never
  // showed them. So the answer is null there and the array (empty or not) otherwise.
  assert.match(
    DETAIL,
    /const decidable = decision === "approve" && !!detail\.assessment && !inForceUnknown/,
    'an empty form is sent as a clear without establishing that the editor was live - a screen '
    + 'that could not show the restrictions in force would delete them',
  );
  assert.match(
    DETAIL,
    /const active = decidable && \(chosen\.length > 0 \|\| standing\.length > 0\) \? chosen : null;/,
    'the emit is not three-valued: null and [] are the same answer again. The empty answer travels '
    + 'only when something stands to be cleared - with nothing standing the two answers have the '
    + 'same outcome, and "says nothing" is the one that keeps a statement the record did not know '
    + 'about',
  );
  const send = PAGE.match(/\.\.\.\((restrictions[^)]*)\?[^,]*restrictions[^,]*\)/)?.[1] ?? '';
  assert.ok(/restrictions !== null/.test(send),
            'PlanPage sends restrictions on a truthiness or length test, so the empty answer is '
            + 'dropped on the wire and emptying the form goes back to meaning nothing');
  // And the confirmation names it. A clear DELETES, and "제한 없이 승인합니다" does not say so.
  assert.match(DETAIL, /지금 걸려 있는 제한 \$\{standing\.length\}건을 모두 해제합니다/,
               'the confirmation does not tell the approver that every restriction comes off');
});

test('the dialog carries the editor rules over instead of reinventing them', () => {
  // Flat-only actions compose 동작 자체 거부 whatever intent is chosen, and the row says so before
  // 적용 - the same routing the editor's seeding applies.
  assert.match(BLOCK, /if \(flatOnly\(action\)\) \{[\s\S]{0,400}intent: "deny_action"/,
               'a flat-only action is written under a scoped intent');
  assert.ok(BLOCK.includes('동작 자체 거부로 작성'), 'the row does not say the routing');
  // Protected actions offered struck-out and unselectable - never silently dropped.
  assert.ok(BLOCK.includes('deny-forbidden'), 'a protected action is not struck out');
  assert.match(BLOCK, /disabled=\{forbidden\}/, 'a protected action is tickable');
  // Resources are picked from the assessment's enumeration, never adopted from the card's target
  // list - targets can be a SAMPLE, and under 이 자원만 허용 an adopted sample denies everything
  // outside an incomplete list.
  // Code access, not prose: the comment explaining WHY the sample is not adopted names it.
  assert.ok(!BLOCK.includes('finding.targets') && !/\.sample\b/.test(BLOCK),
            'the dialog reads the card targets - the sample trap');
  assert.ok(BLOCK.includes('<ResourcePicker'), 'resources are not picked from the enumeration');
  // Replacing a prior decision is said on the row, not discovered in the editor later.
  assert.ok(BLOCK.includes('기존 결정을 이 결정으로 바꾼다'),
            'an overwrite of an earlier decision is silent');
});

test('the per-policy editor re-seeds when the shared array changes under it', () => {
  // The card dialog merges restrictions for a policy whose editor is already mounted with a draft
  // seeded at mount. Without the resync, that editor's next emit - any checkbox - would compose
  // from the stale draft and silently overwrite the card's decision.
  assert.match(IMPACT, /const lastEmitted = useRef<string>\(JSON\.stringify\(existing\)\)/,
               'nothing distinguishes an external change from the echo of an emit');
  assert.match(IMPACT, /if \(incoming === lastEmitted\.current\) return;/,
               'the editor reseeds on its own echo, clobbering half-typed state every emit');
  assert.match(IMPACT, /lastEmitted\.current = JSON\.stringify\(composed\);\s*\n\s*onChange\(composed\)/,
               'emit records its bytes after onChange, so the echo races the record');
  assert.match(IMPACT, /setDraft\(seedFrom\(existing\)\)/,
               'an external change does not replace the draft');
  // The condition inputs are part of what an external merge can change, so the reseed covers them -
  // a BlockPath key_condition decision landing under a mounted editor must not keep the old key.
  const resync = IMPACT.slice(IMPACT.indexOf('if (incoming === lastEmitted.current) return;'),
                              IMPACT.indexOf('}, [existing])'));
  for (const put of ['setTagKey(', 'setTagValues(', 'setConditionKey(', 'setConditionOperator(',
                     'setConditionValues(']) {
    assert.ok(resync.includes(put), `the resync does not reseed ${put})`);
  }
});

test('조건으로 거부 - the key is declared, the default is closed, the routing is its own', () => {
  // The fifth section. Its statement is Deny Resource "*" gated by a request condition key the
  // ACTION DECLARES - on an undeclared key the condition never evaluates (StringEquals then denies
  // nothing, StringNotEquals denies every call), so declaration is checked at every door.
  assert.ok(INTENTS.includes('key_condition: "조건으로 거부"'), 'the section has no name');
  assert.match(INTENTS, /key_condition:\s*\n?\s*"동작이 선언한 요청 조건 키로 거부한다\. 기본형은 닫힌 쪽이다/,
               'the note no longer says the default is the closed form');
  // The default operator is the closed one, in both composers, and it is a DEFAULT - the wire may
  // omit it and the writer parses the omission as StringNotEquals.
  assert.match(IMPACT, /useState<"StringNotEquals" \| "StringEquals">\(\s*\(\) => keySeed\?\.condition_operator \?\? "StringNotEquals"/,
               "the editor's operator does not seed to the closed default");
  assert.match(BLOCK, /useState<"StringNotEquals" \| "StringEquals">\(\s*"StringNotEquals"/,
               "the dialog's operator does not start at the closed default");
  // The editor offers only actions with a declared key, and the picker is told the reason the rest
  // are missing is its own - not the flat-deny sentence.
  assert.match(IMPACT, /if \(intent === "key_condition"\) \{[\s\S]{0,600}declaredKeys\(o\.action\)\.length > 0/,
               'the condition section offers actions whose condition can never evaluate');
  assert.ok(IMPACT.includes('선언한 요청 조건 키가 없는 동작'),
            'the picker gets the flat-deny sentence for a condition-section absence');
  assert.match(PICKER, /elsewhere\.lead \?\? "자원 목록으로 좁힐 수 없는 동작"/,
               'the default absence sentence changed or lost its override');
  // The key input offers only keys EVERY chosen action declares - the statement carries one key
  // for all of them - and typing past the list is answered with which actions do not declare it.
  assert.match(IMPACT, /acc\.filter\(\(k\) => keys\.includes\(k\)\)/,
               'the datalist is a union, offering keys some chosen action does not declare');
  assert.match(IMPACT, /키를 선언하지\s+않는다/,
               'an undeclared typed key is not answered with which actions lack it');
  // Flat-only rerouting must NOT apply: the condition gates the request, so an account-level
  // action carries it fine. Seeding and the dialog both keep the section.
  assert.match(IMPACT, /restriction\.intent === "key_condition"\s*\n?\s*\? "key_condition"/,
               'a stored key_condition row is rerouted at seed and the condition drops on the floor');
  const additions = BLOCK.slice(BLOCK.indexOf('const additions = ('),
                                BLOCK.indexOf('const writable ='));
  assert.ok(additions.indexOf('intent === "key_condition"') < additions.indexOf('if (flatOnly(action)) {'),
            'the dialog reroutes a flat action to deny_action before the condition branch can keep it');
  // What the dialog drops for lacking the key is named, exactly as unreachable actions are.
  assert.ok(BLOCK.includes('키를 선언하지 않아 빠진다'),
            'a chosen action the key does not cover is dropped silently');
  // No wildcard fold: the writer judges the key per covered member, and a service wildcard would
  // smuggle in members the offer never checked.
  const offer = IMPACT.slice(IMPACT.indexOf('const foldOffer ='), IMPACT.indexOf('const totalChosen ='));
  assert.ok(offer.includes('intent === "key_condition"'),
            'a condition section is offered a wildcard whose members may not declare the key');
});

const API = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
const PREVIEW = readFileSync(new URL('./inlinePreview.js', import.meta.url), 'utf8');

test('이 자원만 허용 offers only what was judged to hold it, and demands every type', () => {
  // The reported defect class: IAM authorises a multi-resource call against every resource in the
  // request context INCLUDING ones the caller never names - ec2:ReplaceRouteTableAssociation is
  // authorised against the route table currently associated, resolved from the AssociationId at
  // call time - so a NotResource of picked ARNs denies every call while reading as a scope. The
  // verdict is judged at table build time against the AWS API request models and carried by the
  // assessment; every door answers from the same bytes.
  //
  // The editor's offering drops judged-unsafe actions IN ADDITION to the flat-deny bucket, and the
  // two counts travel separately - they go to different sections for different reasons.
  assert.match(IMPACT, /scoped\.filter\(\(o\) => !allowOnlyOf\(o\.action\)\?\.refuse\)/,
               'the offering shows actions whose statement would deny every call');
  assert.ok(IMPACT.includes('!o.account_level && !o.creates_target'),
            'the verdict filter replaced the flat-deny filter instead of composing with it');
  assert.ok(IMPACT.includes('alsoKeptOut={unsafe > 0 && intent === "allow_only"'),
            'the judged-unsafe absences are folded into the flat-deny sentence or not said');
  assert.ok(PICKER.includes('{alsoKeptOut.lead} {alsoKeptOut.count}개는 여기에 없다'),
            'the second kept-out bucket has no sentence of its own');
  // A hand-typed name goes through the same judgement; one the map does not know passes through
  // for the server to judge - unknown is not empty, but it is also not this page's to refuse.
  assert.match(IMPACT, /offerable\.filter\(\(a\) => !flatOnly\(a\) && !allowOnlyOf\(a\)\?\.refuse\)/,
               'a hand-typed judged-unsafe name is accepted into the section');
  assert.match(IMPACT, /성립하지[\s\S]{0,40}않는 동작이다/,
               'heldElsewhere does not name why the action cannot be held');
  // The cover requirement: a safe action authorised against several types needs a pick in every
  // one, said per row and per section, and typed from the assessment's own enumeration.
  assert.match(IMPACT, /const coverShort = intent === "allow_only"/,
               'nothing computes which chosen actions under-cover their types');
  assert.ok(IMPACT.includes('유형 미충족:'), 'an under-covered row does not say which types');
  assert.ok(IMPACT.includes('유형마다 하나 이상'), 'the section does not state the rule');
  assert.match(IMPACT, /typeOfArn\.get\(arn\) === type/,
               'cover is checked by something other than the enumeration type of the picked ARN');
});

test('태그로 거부 - the operator is a decision, and the tag has to be one AWS reads', () => {
  // The fix. The tag branch hardcoded StringEquals - the OPEN form - so every tag restriction this
  // platform ever wrote let past exactly what an administrator asking for "production is off
  // limits" meant to catch: a resource carrying no Environment tag at all does not match
  // StringEquals, the Deny does not fire, and the untagged resource is allowed.
  assert.match(PREVIEW, /\[conditionOperator\(restriction\)\]: \{\s*\[`aws:ResourceTag\/\$\{restriction\.tag_key \?\? ''\}`\]/,
               'the preview hardcodes the tag operator again');
  // The two condition intents' absences mean DIFFERENT things, and both languages say so in one
  // place. key_condition was born closed; every stored tag decision composed StringEquals, so
  // reading an unmarked one as closed would invert a control somebody already approved.
  assert.match(PREVIEW, /DEFAULT_CONDITION_OPERATOR = \{\s*key_condition: 'StringNotEquals',\s*tag_condition: 'StringEquals',/,
               'the per-intent default is gone, or the tag default flipped under stored records');
  // The editor proposes the closed form for a NEW decision and preserves a stored one.
  assert.match(IMPACT, /tagSeed \? tagSeed\.condition_operator \?\? "StringEquals" : "StringNotEquals"/,
               'a new tag decision is proposed open, or a stored one is silently flipped');
  assert.match(IMPACT, /setTagOperator\(tag \? tag\.condition_operator \?\? "StringEquals" : "StringNotEquals"\)/,
               'the resync does not reseed the tag operator the same way it seeds it');
  assert.ok(IMPACT.includes('condition_operator: fields.tagOperator'),
            'the chosen tag operator never reaches the wire');
  // Choosing the open form is allowed and says which way it rots - the same honesty the condition
  // section already carries.
  assert.ok(IMPACT.includes('그 태그가 붙지 않은 자원은 걸리지 않는다'),
            'the open tag form is offered without saying what it lets past');
  // And the coherence gate tag_condition was missing while key_condition had one.
  assert.match(IMPACT, /scoped\.filter\(\(o\) => !untaggable\.has\(o\.action\)\)/,
               'the tag section offers actions whose condition can never fire');
  assert.match(IMPACT, /reference\?\.no_resource_tag/,
               'the editor does not read the carried tag vocabulary');
  assert.ok(IMPACT.includes('AWS가 aws:ResourceTag를 평가하지 않는 동작'),
            'the actions kept out of the tag section are not said, or share the wrong sentence');
  assert.match(API, /restriction\.intent === 'tag_condition' && referenceNoResourceTag/,
               'the route does not mirror the tag coherence gate, or refuses on an old assessment');
  assert.match(API, /CONDITION_INTENTS = new Set\(\['tag_condition', 'key_condition'\]\)/,
               'the operator is accepted on an intent whose statement has no condition');
});

test('the decision route mirrors the verdict and holds the cover gate the writer cannot', () => {
  // The writer refuses judged-unsafe actions from its own table but receives a FLAT resource set,
  // so under-picking types is refused HERE, from the assessment's typed groups - the one half of
  // the gate that lives on this side alone. Wildcards pass through: the writer judges the whole
  // statement, and a wildcard makes no per-member promise.
  assert.match(API, /referenceAllowOnly = stored\.document\.action_reference\?\.allow_only/,
               'the route does not read the carried verdicts');
  assert.match(API, /if \(restriction\.intent === 'allow_only' && referenceAllowOnly\)/,
               'the gate runs without the map, so an old assessment refuses everything');
  assert.match(API, /if \(action\.includes\('\*'\)\) continue;/,
               'a wildcard is judged per member here, vetoing the shape the writer accepts');
  assert.match(API, /verdict\?\.refuse/, 'the refusal half of the verdict is not enforced');
  assert.match(API, /typeOfArn\.get\(arn\) === type/,
               'the cover half is not checked against the enumeration types');
  assert.ok(API.includes('각 유형에서 하나 이상 고른다'),
            'an under-covered decision is refused without saying what to do');
});

test('the block dialog drops judged-unsafe actions by name and holds 적용 for cover', () => {
  assert.match(BLOCK, /const unsupported = intent === "allow_only"/,
               'the dialog writes allow_only decisions the writer will refuse');
  assert.ok(BLOCK.includes('성립하지 않아 빠진다'),
            'a judged-unsafe action is dropped silently');
  assert.match(BLOCK, /intent === "allow_only" && allowOnlyOf\(action\)\?\.refuse\) continue;/,
               'additions still writes rows for dropped actions');
  assert.match(BLOCK, /coverShort\.length > 0\s*\|\| tagMissing/,
               '적용 commits an under-covered allow_only decision the route will refuse');
});

const PLAN = readFileSync(new URL('../src/components/PlanDetail.tsx', import.meta.url), 'utf8');

test('the virtual resource test says what it checked, and never says ALLOW', () => {
  // The check a new account cannot otherwise get: reading a Condition block and working out what
  // it does to an untagged resource created next month is the thing people get wrong, and
  // describing that resource and asking is not.
  assert.ok(IMPACT.includes('<VirtualResourceTest'),
            'the preview offers no way to ask about a resource that does not exist');
  assert.match(IMPACT, /아직 없는 자원으로 시험하기/, 'the control has no name');
  // The one thing it must never claim. This document is Deny-only and an Allow comes from the
  // attached managed policies, whose Resource and Condition clauses the assessment never carries.
  assert.ok(!/["'>]\s*허용된다/.test(IMPACT), 'the test claims a call would be allowed');
  assert.ok(IMPACT.includes('이 문서의 어떤 Deny도 걸리지 않는다'),
            'NOT_DENIED is rendered as something other than what was checked');
  // And NOT_DENIED distinguishes its two causes, or it is not readable.
  assert.match(IMPACT, /answer\.considered\.length > 0/,
               '"nothing matched" and "matched and did not fire" are shown as one answer');
  // UNKNOWN names the key instead of guessing - the common case under a closed default.
  assert.match(IMPACT, /answer\.outcome === UNKNOWN/, 'UNKNOWN is not rendered at all');
  assert.ok(IMPACT.includes('판정할 수 없다'), 'an unanswerable probe is given a verdict anyway');
  // The evaluator is pinned against the container's, like the composer beside it.
  const evaluator = readFileSync(new URL('./virtualResource.js', import.meta.url), 'utf8');
  assert.ok(evaluator.includes('virtual_resource.py'),
            'nothing records which side is the authority');
  assert.match(evaluator, /export const NOT_DENIED = 'NOT_DENIED'/);
  assert.ok(!/ALLOW/.test(evaluator.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')),
            'an ALLOW verdict exists in the evaluator');
});

test('a tag control says it is only as strong as who can write the tag', () => {
  // §11 in one line: a Deny that selects by tag is defeated by whoever can move the tag, and the
  // grant that lets them do it can sit in any attached policy - so the warning is computed over
  // the WHOLE permission set, not the policy the condition was written against.
  assert.match(IMPACT, /const tagWriters = useMemo\(/, 'nothing computes who can write tags');
  assert.match(IMPACT, /\?\.\[0\] === "Tagging"/,
               'tag writers are found by verb or by name rather than by the AWS access level');
  assert.ok(IMPACT.includes('이 권한 세트는 태그를 쓸 수 있다'),
            'the tag section does not say the control can be walked around');
  assert.ok(IMPACT.includes('동작 자체 거부'),
            'the warning names no remedy');
  // The engine half: the capability comes from the digest's level-derived list, and has an edge.
  const paths = readFileSync(new URL('./candidatePaths.js', import.meta.url), 'utf8');
  assert.match(paths, /for \(const action of grant\.tag_writes \?\? \[\]\)/,
               'CAP.TAG is still assigned by the verb fallback alone');
  assert.match(paths, /id: 'retag'/, 'no edge consumes the tag capability');
  assert.match(paths, /TAG_TAMPER: 'tag_tamper'/, 'the outcome has no name');
  const digest = readFileSync(new URL('./riskDigest.js', import.meta.url), 'utf8');
  assert.match(digest, /tag_writes: risk\.filter\(\(a\) => levelOf\(a, levels\) === 'Tagging'\)/,
               'the digest does not carry the tag writes, or finds them some other way');
});

test('a template is a pre-filled form and enters through the decision path', () => {
  // Not a policy installed anywhere: there is nothing to attach to before a plan is approved, the
  // writer replaces every AdminDeny statement wholesale, and a statement with no reviewer and no
  // assessment digest is what the marker contract exists to make impossible.
  assert.ok(PLAN.includes('<RestrictionTemplates'), 'templates are not offered on the plan');
  assert.match(PLAN, /onApply=\{\(seeded\) => setRestrictions\(\(current\) => mergeTemplate\(current, seeded\)\)\}/,
               'applying a template does something other than fill the editor in');
  assert.match(PLAN, /승인은 여전히 이 계획에\s+대한 결정으로 나간다/,
               'the page does not say a template still goes through the ordinary decision');
  // What it drops is said BEFORE the button is pressed - a template that quietly shrank would
  // read as a control that was fully applied.
  assert.ok(PLAN.includes('이 계획에 걸 수 없어 빠진다'), 'dropped rows are silent');
  const templates = readFileSync(new URL('./templates.js', import.meta.url), 'utf8');
  assert.match(templates, /const INTENTS = new Set\(\['deny_action', 'tag_condition', 'key_condition'\]\)/,
               'a template may carry an ARN, which is an account fact and not a template');
  assert.match(templates, /condition_operator: row\.condition_operator \?\? 'StringNotEquals'/,
               'a template defaults to the open form');
});

test('the two risk areas are separate, and the action one claims no resources', () => {
  // The gap: eleven of thirteen rules are evaluated over UNITS, a unit is a group of resources that
  // were found, and a new account has none - so the risk page for the account a preventive control
  // is written for was three rules and a blank space. Both areas are shown always, because on an
  // account midway between empty and full both are true and neither implies the other.
  const ui = readFileSync(new URL('../src/components/RiskAnalysis.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('영향 자원 위험') && ui.includes('Action 자체 위험'),
            'the analysis is still one merged list');
  assert.match(ui, /assessable\.filter\(\(f\) => f\.axis === axis\)/,
               'the areas are headings over one list rather than a split');
  // The cross-reference, or the two areas read as two independent findings and the counts double.
  assert.match(ui, /finding\.alsoOnOtherAxis && \(/, 'a rule in both areas is not marked as one');
  // An enumeration warning belongs to a card that made an enumeration.
  assert.match(ui, /finding\.axis !== "action" && finding\.truncated !== false/,
               'a capability is marked doubtful over a resource list it never had');

  const engine = readFileSync(new URL('./findings.js', import.meta.url), 'utf8');
  // The action axis attaches nothing, and that is structural rather than a convention the renderer
  // keeps: a capability carrying ARNs would be answering the other question with a list that goes
  // stale.
  assert.match(engine, /units: \[\],/, 'the action axis can carry a resource list');
  assert.match(engine, /colocated: found\.atomic \|\| hits\.every\(\(a\) => unscoped\.has\(a\)\)/,
               'the action axis asserts co-location it cannot show - the same false positive the '
               + 'unit scope exists to prevent, through the other door');
  // And the doubt applies only where the rule NEEDS several actions to meet. `atomic` is the
  // per-hit answer: E-3's single-action branch needs no co-location, its Stop/Modify/Start branch
  // does, and one card can be reached by either.
  assert.match(engine, /atomic = atomic \|\| hit\.atomic;/,
               'anyOf branches are alternatives and one of them needing co-location must not '
               + 'impose it on the others');
  // A resource-axis finding that reaches nothing is the action-axis one wearing the wrong heading.
  assert.match(engine, /axis === AXIS\.RESOURCE && targets\.length === 0\) continue/);

  // And the fact that settles co-location is a property of the DOCUMENT, so it survives an account
  // with nothing to enumerate. That is the whole reason it is carried separately from unit.scope.
  const digest = readFileSync(new URL('./riskDigest.js', import.meta.url), 'utf8');
  assert.match(digest, /unscoped_actions: risk\.filter\(\(a\) => unscoped\.has\(a\)\)/);
  const paths = readFileSync(new URL('./candidatePaths.js', import.meta.url), 'utf8');
  assert.ok(!/const already = out\.some/.test(paths),
            'the capability candidate is suppressed as soon as one resource of the type exists');
});

test('anyOf reports every branch, so a green badge is not a lie', () => {
  // The worst defect this analysis has had. anyOf returned the FIRST branch that hit, and that
  // return value is what the trigger list, the block dialog, the containment badge and the target
  // filter all read - so AmazonEC2FullAccess showed ec2:GetConsoleOutput alone, an approver denied
  // it, the card went green, and ec2:CreateImage stayed granted. Seven of thirteen rules.
  const engine = readFileSync(new URL('./findings.js', import.meta.url), 'utf8');
  assert.ok(!/if \(hit\) return hit;/.test(engine), 'anyOf still stops at the first branch');
  assert.match(engine, /for \(const sub of predicate\.anyOf\) \{[\s\S]*?if \(!hit\) continue;/,
               'anyOf does not collect the branches that did not come first');
  // A card must never narrate a mechanism it did not fire on, which is why the old X-3 is three
  // rules now rather than one with a longer sentence.
  const doc = JSON.parse(readFileSync(new URL('./finding-rules.json', import.meta.url), 'utf8'));
  const byId = new Map(doc.rules.map((r) => [r.id, r]));
  assert.equal(byId.get('R-2')?.category, 'RECON', 'reading boot output is filed as exposure');
  assert.equal(byId.get('X-5')?.category, 'EXPOSURE');
  assert.ok(!/사본/.test(byId.get('R-2')?.narrative ?? ''),
            'the boot-output rule still narrates disk copies');
  // The dead note is gone. It asked for a narrative composed from the action set, and narratives
  // are copied verbatim and never composed - so nothing was applying it (T-4).
  assert.ok(!JSON.stringify(doc).includes('ModifySnapshotAttribute 가 동작 집합에'),
            'a rule still carries an instruction nothing enforces');
  // And a connection is a claim about THIS account, so it is checked before it is printed.
  assert.match(engine, /relatedFired: \(finding\.relatedTo \?\? \[\]\)\.filter\(/);
  const ui = readFileSync(new URL('../src/components/RiskAnalysis.tsx', import.meta.url), 'utf8');
  assert.match(ui, /\(finding\.relatedFired \?\? \[\]\)\.length > 0/,
               'the card prints a connection to a rule that may not have fired');
});

test('every card says how much of its path this decision cuts, in three states', () => {
  const ui = readFileSync(new URL('../src/components/RiskAnalysis.tsx', import.meta.url), 'utf8');
  for (const [state, label, css] of [['full', '완전 차단됨', 'badge-ok'],
                                     ['partial', '일부 차단됨', 'badge-warn'],
                                     ['none', '차단되지 않음', 'badge-danger']]) {
    assert.ok(ui.includes(label), `${state} has no label`);
    assert.match(ui, new RegExp(`label: "${label}",\\s*\\n\\s*className: "${css}"`),
                 `${label} is not the colour the state means`);
  }
  // Computed for EVERY card, not only the ones offered a 차단 button. A card with no button - a
  // declaration-path action, or a decision already closed - still has to say it is not blocked, or
  // the absence of a button reads as the path being handled.
  assert.match(ui, /const containmentOf = \(finding: Finding\): ContainmentState =>/);
  assert.match(ui, /containment=\{containmentOf\(f\)\}/);
  assert.ok(!/blockProps\(f\) && containmentOf/.test(ui), 'the badge is gated on the button');

  // Only 동작 자체 거부 is complete, and that is the judgement worth pinning: every other intent is
  // conditional on ARNs that exist today or on a value somebody may choose.
  const block = readFileSync(new URL('./blockPath.js', import.meta.url), 'utf8');
  assert.match(block, /r\.intent === 'deny_action'/);
  assert.match(block, /offered\.every\(\(o\) => !o\.protected && denied\.has\(o\.action\)\)/,
               'a path holding a protected action can be reported as completely blocked');
});

test('an action is classified from what AWS publishes, not only from a hand-written table', () => {
  // The measured gap: the curated table is 136 entries against 12,328 mutating actions, the verb
  // fallback carries the rest by reading the first word, and 46% of them land in a bucket no edge
  // consumes - 55% within ec2. Those produce no candidate, and the model only ever judges
  // candidates, so it is never asked about them.
  const caps = readFileSync(new URL('./capabilities.js', import.meta.url), 'utf8');
  assert.match(caps, /export function derivedCapabilities/, 'nothing reads the published facts');
  // The level AWS itself publishes. The proof this is the right source rather than a longer verb
  // list is Tagging: the tag-tamper path was unreachable for exactly this reason, it was fixed by
  // reading the level, and Tagging now sits at 6% unreached against Write's 48%.
  assert.match(caps, /fact\.level === 'Permissions management'/);
  assert.match(caps, /fact\.refuse\.startsWith\('deref:'\)/,
               'the rebinding class the table already records is still unread');
  // Curated wins outright. Those 136 were decided BECAUSE the published facts do not show them, and
  // unioning a derivation into them would change 136 reasoned answers as a side effect.
  assert.match(caps, /if \(curated\) return \{ caps: curated, source: 'curated' \}/);

  // The fold is upstream of all of it: an action deleted there can be classified perfectly and
  // still never reach a rule or a candidate.
  const digest = readFileSync(new URL('./riskDigest.js', import.meta.url), 'utf8');
  assert.match(digest, /if \(derivedCapabilities\(reference\.get\(action\)\)\.length\) return true;/,
               'ec2:* folds away the very actions this increment exists to catch');
  // And what nothing could place is counted rather than dropped in silence.
  assert.match(digest, /actions_unclassified: unclassified\.length/);
  const ui = readFileSync(new URL('../src/components/RiskAnalysis.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('분류하지 못했습니다'), 'unclassified actions are invisible on the page');
  assert.ok(ui.includes('모델에게 질문되지도 않았습니다'),
            'the page does not say the model was never asked');

  // A rule may fire on what an action DOES. Without it the deterministic half stays at 33 names.
  const rules = readFileSync(new URL('./rules.js', import.meta.url), 'utf8');
  assert.match(rules, /if \('capability' in predicate\)/, 'rules match names only');
  assert.match(rules, /CAPABILITIES\.has\(predicate\.capability\)/,
               'a mistyped capability would match nothing, silently, forever');
  const doc = JSON.parse(readFileSync(new URL('./finding-rules.json', import.meta.url), 'utf8'));
  const x4 = doc.rules.find((r) => r.id === 'X-4');
  assert.ok(x4, 'no rule fires on a rebinding');
  assert.deepEqual(x4.predicate, { capability: 'rebind' });
  // X-2 keeps its literals BESIDE the capability terms - a service whose action list the reference
  // budget dropped would otherwise stop firing a rule that used to fire on a name.
  const x2 = doc.rules.find((r) => r.id === 'X-2');
  const terms = x2.predicate.anyOf;
  assert.ok(terms.some((t) => t.action === 'ec2:CreateRoute'));
  assert.ok(terms.some((t) => t.capability === 'network-route'));
});

test('a refused inspection is read on the panel, ahead of the plan it explains', () => {
  // The silence: a refusal is a COMPLETED run, so its marker is deleted, so the request left no
  // row - the reason reached CloudWatch and nobody. Twelve managed policies against a limit of ten
  // produced no plan, no failure and no row, and the administrator's side of it was that they
  // changed something and nothing happened.
  assert.ok(PLAN.includes('<RefusalNotice'), 'the panel never shows why an inspection refused');
  // Ahead of the gate, or a resource that has NEVER been planned renders an empty page: the one
  // case where the reason is the only thing there is to show.
  const notice = PLAN.indexOf('<RefusalNotice');
  const gate = PLAN.indexOf('{!detail.plan_stored && detail.refusal ? null : (');
  assert.ok(notice > 0 && gate > notice,
            'the refusal is inside the block that is hidden when there is no plan');
  // The sentence, not a category. What makes it actionable is "12 ... and the limit is 10" saying
  // remove two; a code would send somebody back to the log this exists to replace.
  assert.match(PLAN, /<pre className="plan">\{refusal\.reason\}<\/pre>/,
               'the reason is summarised rather than printed as it was written');
  // And the two shapes are distinguished, because they ask for different things.
  assert.ok(PLAN.includes('마지막 검사가 거부되어 이 계획은 최신이 아닙니다'),
            'a plan older than the last refusal is not said to be older');
  assert.ok(PLAN.includes('결정할 것이 없습니다'),
            'a resource with no plan is offered a decision anyway');
  // The detail reads the prefix rather than taking the sweep's copy: the sweep runs on an interval
  // and this page is opened seconds after the edit that was refused.
  const sweep = readFileSync(new URL('./sweep.js', import.meta.url), 'utf8');
  assert.match(sweep, /plan_stored: Boolean\(planObject\)/,
               'the panel cannot tell "never planned" from "read failed"');
});

test('each attached policy gets its own area and its own two buttons', () => {
  // Five attached policies is five policies' worth of candidates and the model half is billed per
  // candidate, so an approver whose question is about AmazonEC2FullAccess should be able to ask
  // about AmazonEC2FullAccess. Nothing in either half is computed across policies, so a scoped run
  // is the same analysis with a filter.
  const ui = readFileSync(new URL('../src/components/RiskAnalysis.tsx', import.meta.url), 'utf8');
  assert.ok(ui.includes('권한별 분석'), 'the page offers no per-policy analysis');
  assert.match(ui, /<RiskScope \{\.\.\.props\} policy=\{null\} \/>/, 'the whole-plan area is gone');
  assert.match(ui, /<RiskScope \{\.\.\.props\} policy=\{p\.identifier\}/,
               'the per-policy areas do not carry a scope, so every button asks about everything');
  // The roster comes from the assessment the page already holds - the areas have to be drawable
  // before anything has been run, and a call to draw a heading is a call for nothing.
  assert.match(ui, /const attached = assessment\?\.policies \?\? \[\]/);

  // Only the whole-plan area cites. A decision records "taken while reading analysis X" and X has
  // to describe the thing being decided; a per-policy run describes one fifth of it.
  assert.match(ui, /policy=\{p\.identifier\} onAnalysis=\{\(\) => \{\}\}/,
               'a per-policy run can become the citation on a whole-plan decision');

  // The scope travels on the poll too. Two policies analysed separately are two runs under one
  // plan id, and a poll without it is handed whichever happened to be there.
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(api, /\?policy=\$\{encodeURIComponent\(policy\)\}/);
  const routes = readFileSync(new URL('./api.js', import.meta.url), 'utf8');
  assert.match(routes, /const runId = scope \? `\$\{id\}::\$\{scope\}` : id;/,
               'a scoped run shares an id with the whole-plan one');
  assert.match(routes, /is not an attached policy of this plan/,
               'a policy that is not attached falls through to analysing all of them');
});

test('a resource is written the same way on both screens', () => {
  // The same subnet used to be "arn:aws:ec2:us-east-1:644701781058:subnet/subnet-003d..." on a risk
  // card and "리소스명: subnet-003d..., 계정: 644701781058, 리전: us-east-1" on the impact panel, so
  // an approver moving between them did the parsing themselves to see it was one row.
  //
  // One component, imported by both. Copying it would have worked today and drifted on the parts
  // that took the most deciding - which slot a KMS alias goes in, that the console link belongs on
  // the group heading rather than the row, that tags go behind a button because one
  // CloudFormation-managed resource carries two hundred characters of them.
  const LINE = readFileSync(new URL('../src/components/ResourceLine.tsx', import.meta.url), 'utf8');
  assert.ok(/export function LabeledResource/.test(LINE) && /export function TagButton/.test(LINE),
            'the shared resource line no longer exports both renderers');
  for (const [name, source] of [['RiskAnalysis.tsx', PANEL], ['Impact.tsx', IMPACT]]) {
    assert.match(source, /from "\.\/ResourceLine"/,
                 `${name} does not read the resource line from the shared module`);
    assert.ok(!/^function (LabeledResource|TagButton)\(/m.test(source),
              `${name} defines its own copy of the resource line`);
  }
  // And the risk card actually renders through it rather than falling back everywhere.
  const targets = PANEL.slice(PANEL.indexOf('function Targets('), PANEL.indexOf('<Targets'));
  assert.ok(/<LabeledResource /.test(targets) && /<TagButton /.test(targets),
            'the risk card prints bare ARNs again');
});


test('a card whose path has been cut is coloured by that, not by the grade', () => {
  // A list of cards is read down its left edge. On the second pass the question is not "how bad is
  // this" - that has been read - but "which of these have I dealt with", and an edge that stays red
  // after the Deny is written cannot answer it.
  const card = PANEL.slice(PANEL.indexOf('const cut = containment'),
                           PANEL.indexOf('<summary className="finding-head">'));
  assert.ok(/containment === "full"/.test(card), 'a fully cut path is not coloured as cut');
  assert.ok(/containment === "fenced"/.test(card) && card.includes('contained-fenced'),
            'the PassRole fence has no colour of its own');
  assert.ok(/containment === "partial"/.test(card), 'a partly cut path is not coloured as cut');
  assert.ok(card.includes('contained-full') && card.includes('contained-partial'),
            'the card root carries no containment class, so the CSS has nothing to hook on');
  // The grade is NOT rewritten. What the path would do if it were open has not changed - only
  // whether it is open - so the badge still says 높음 and only its colour follows the cut.
  assert.ok(card.includes('grade-${finding.escalationGrade.toLowerCase()}'),
            'the card stopped carrying its grade, so the grade colour has nothing to fall back to');
});

test('the cut colours reach both the edge and the badge, and clear the filled one', () => {
  for (const cls of ['contained-full', 'contained-fenced', 'contained-partial']) {
    assert.match(CSS, new RegExp(`\\.finding\\.${cls}\\s*\\{[^}]*border-left-color:`),
                 `${cls} does not colour the left edge`);
    const badge = CSS.match(new RegExp(`\\.finding\\.${cls} \\.grade \\{([^}]*)\\}`));
    assert.ok(badge, `${cls} does not recolour the grade badge, so a green edge sits under a red badge`);
    // grade-critical is the one badge that is FILLED rather than outlined. Left alone it stays a red
    // block with green text on it - the card contradicting itself in one element.
    assert.match(badge[1], /background:\s*transparent/,
                 `${cls} does not reset the filled 치명 badge`);
    assert.match(badge[1], /color:/, `${cls} does not set the badge text colour`);
  }
  // Two shades, not one: a resource-scoped restriction does not close what a Resource "*" Deny
  // closes, and one colour for both would say it does.
  // Three answers, three colours. "I closed this", "this was already closed for me", and "some of
  // it is closed" are different things to do next about.
  const edge = (cls) =>
    CSS.match(new RegExp(`\\.finding\\.${cls}\\s*\\{[^}]*border-left-color:\\s*([^;]+)`))[1].trim();
  const colours = ['contained-full', 'contained-fenced', 'contained-partial'].map(edge);
  assert.equal(new Set(colours).size, 3, `containment states share a colour: ${colours.join(', ')}`);
  // The asset grade is about what the reached resources are worth, which cutting the path does not
  // change. It must not be recoloured with the rest of the header.
  assert.match(CSS, /\.finding\.contained-full \.grade\.grade-asset[\s\S]{0,120}?\{[^}]*color:/,
               'the asset grade badge is recoloured by a cut path');
});


// ---- the two questions a PassRole panel has to answer -------------------------------------------

test('every request row says whether that person already holds the grant', () => {
  // Without it a list of names says nothing about state, so "부여" and "그대로 두기" are the same
  // word: an approver cannot tell who is asking from who already has it.
  assert.match(DETAIL, /granted_to/,
    'the panel does not read who currently holds the grant');
  assert.match(DETAIL, /granted\.has\(name\)/,
    'the grant state is read and not shown per row');
  assert.match(DETAIL, /부여됨/, 'no row says a person already holds the grant');
  assert.match(DETAIL, /미부여/, 'no row says a person does not');
});

test('a tag that was removed while the grant stands gets its own group and a way to revoke', () => {
  // Removing the tag is how a request is withdrawn. The role afterwards does not carry it, so
  // reading the role's tags saw every request and no withdrawal - and the grant stayed standing
  // with nothing anywhere naming it. These names are never in requested_by; there is nothing to
  // grant, so the only control offered is 회수.
  assert.match(DETAIL, /passrole\?\.untagged/, 'the withdrawn tags are not read');
  assert.match(DETAIL, /태그가 제거된 사람/, 'the withdrawn tags have no section of their own');
  // The guard, not just the strings. This is a regex over source, so a section disabled with a
  // constant keeps every string in it and every assertion above still passes.
  assert.match(DETAIL, /\{withdrawnTags\.length > 0 && \(/,
    'the withdrawn group is not rendered under the condition that it has members');
  assert.match(DETAIL, /태그 없이 부여됨/, 'the state of a withdrawn tag is not stated');
  // And no grant option in that table: the block between its header and its close must offer
  // 회수 without 부여.
  const block = DETAIL.slice(DETAIL.indexOf('태그가 제거된 사람'));
  const table = block.slice(0, block.indexOf('</table>'));
  assert.ok(!/<option value="grant"/.test(table),
    'a withdrawn tag is offered for granting, and there is no request left to grant');
  assert.match(table, /<option value="revoke"/);
});

test('the panel still renders when every tag was removed and nothing is being asked', () => {
  // requests.length === 0 with withdrawals is the ordinary shape of "somebody untagged the last
  // request". Returning null there would hide the grants that are still standing.
  assert.match(DETAIL, /requests\.length === 0 && withdrawnTags\.length === 0/,
    'the panel hides itself when there are withdrawals and no requests');
});


// ---- the notification bell ---------------------------------------------------------------------

const BELL = read('components/Notifications.tsx');
const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const PLAN_PAGE = readFileSync(new URL('../src/components/PlanPage.tsx', import.meta.url), 'utf8');

test('the feed is in the top bar and no longer under the plan list', () => {
  // It sat below a list long enough to push it off screen, so an announcement arriving while
  // somebody read a plan was seen at the next scroll or not at all - which spends the only thing
  // this feed buys over the sweep.
  assert.match(APP, /<Notifications \/>/, 'the bell is not in the top bar');
  assert.ok(!/<Notifications/.test(PLAN_PAGE),
    'the feed is still rendered under the plan list as well');
  // Left of the key field, which means before it in source order.
  assert.ok(APP.indexOf('<Notifications />') < APP.indexOf('api-key topbar-key'),
    'the bell is to the right of the key input');
});

test('the count is unread rather than total, and opening clears it', () => {
  // A number that never goes away stops meaning "look at this" and starts meaning "there are
  // things", which is what the panel itself already said.
  assert.match(BELL, /seen\.current\.has\(n\.id\)/,
    'the count is not measured against what was already seen');
  assert.match(BELL, /setUnread\(0\)/, 'opening the panel does not clear the count');
  assert.match(BELL, /\{unread > 0 \? <span className="bell-count">\{unread\}<\/span> : null\}/,
    'the count is shown when there is none, or not shown when there is one');
});

test('the bell toggles the panel', () => {
  assert.match(BELL, /const \[open, setOpen\] = useState\(false\)/,
    'the panel does not start closed');
  assert.match(BELL, /setOpen\(\(wasOpen\) => \{/, 'the button does not toggle');
  assert.match(BELL, /\{open \? \(/, 'the panel is not rendered on the open state');
});

test('a feed that is not arriving says so on the bell itself', () => {
  // With the panel shut, the bell is the only thing on screen. An error behind it would be a feed
  // that silently stopped updating.
  assert.match(BELL, /const broken = Boolean\(error\) \|\| !enabled;/,
    'the bell does not know the feed is broken');
  assert.match(BELL, /unread === 0 && broken/,
    'a broken feed with no unread items shows nothing on the bell');
});

// ---- a refusal and a failed attempt must not read the same -------------------------------------
//
// One artifact, two kinds, and the rendering is where the difference becomes an action. A refusal
// says "고치고 자원을 다시 변경하십시오" and that is right for a spec role carrying twelve managed
// policies. Said after a terraform state lock timeout it sends an administrator to edit a resource
// that was never broken, while the thing worth looking at - a request the pipeline cannot get
// through - goes unmentioned. Before the inspector recorded the second kind there was no sentence
// at all; the failure mode of adding one is showing the wrong one.

const LIST = readFileSync(new URL('../src/components/PlanList.tsx', import.meta.url), 'utf8');

test('the notice branches on the kind rather than telling everyone to fix the resource', () => {
  const block = PLAN.slice(PLAN.indexOf('function RefusalNotice('),
                           PLAN.indexOf('function RestrictionTemplates('));
  assert.ok(block.length > 0 && block.length < PLAN.length, 'the slice caught the wrong component');
  assert.match(block, /refusal\.retryable/,
               'RefusalNotice reads one text for both kinds, so a lock timeout tells somebody to '
               + 'go and change a resource that had nothing to do with it');
  // The verdict's instruction must not be what a stopped attempt shows.
  const [stopped, verdict] = block.split(') : planStored ? (');
  assert.ok(verdict?.includes('자원을'), 'the slice did not split the two branches');
  assert.ok(!stopped.includes('자원을 다시 변경하십시오'),
            'the stopped branch still tells the administrator to change the resource');
});

test('the stopped branch does not promise a retry that nothing performs', () => {
  // The failure this pins is the one that shipped: 「다시 시도됩니다」 on a screen where nothing
  // re-runs the inspection. The rule's RetryPolicy covers EventBridge failing to START the task -
  // once it starts, the rule is finished with the event (opt-stack-ecs-runtime.yaml). Telling
  // somebody to wait ends with nobody acting, which is the silence this whole artifact exists to
  // end, reached by a different route.
  const block = PLAN.slice(PLAN.indexOf('function RefusalNotice('),
                           PLAN.indexOf('function RestrictionTemplates('));
  const [stopped] = block.split(') : planStored ? (');
  assert.ok(!/다시 시도됩니다|재시도가 성공하면|다시 실행됩니다/.test(stopped),
            'the stopped branch says an attempt is coming, and none is');
  assert.ok(stopped.includes('자동으로 다시 돌지는 않습니다'),
            'the stopped branch does not say the one thing a person has to know to act');
  assert.ok(stopped.includes('자원을 다시 변경하면'),
            'nothing tells the reader how a new inspection is started');
});

test('the row badge separates them too, because that is where somebody decides to look', () => {
  assert.match(LIST, /s === "stopped"/,
               'a stopped inspection falls through to 계획 거부됨 on the list');
  const badge = LIST.slice(LIST.indexOf('const stateBadge'), LIST.indexOf('export function PlanList'));
  assert.ok(!/s === "stopped"[\s\S]{0,200}badge-danger/.test(badge),
            'the stopped badge is the refusal colour, which is the reading it exists to avoid');
  // Comment lines dropped first: what a person reads is the JSX, and the comment beside it names
  // the wording it rejects. Matching the comment would fail on the explanation for the fix.
  const rendered = badge.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/재시도 중/.test(rendered),
            'the badge says an attempt is under way, and nothing re-runs a stopped inspection');
});

// ---- the retry is a person's decision, not a rule ------------------------------------------------
//
// Re-putting the object automatically would run forever on a deterministic failure: the task fails,
// the object is re-put, the rule fires, the task fails. The reason is on screen precisely so that a
// person decides whether running it again is the right answer - often something has to be fixed
// first, and sometimes no number of attempts clears it.
//
// So the panel must say that nothing retries on its own, and it must name who pressed it.

const FAILURES = readFileSync(new URL('../src/components/TaskFailures.tsx', import.meta.url), 'utf8');

test('the failures panel says nothing is retried on its own', () => {
  assert.match(FAILURES, /자동으로 다시 돌리지/,
               'the panel does not say that nothing retries by itself, so a person who reads it '
               + 'may wait for something that will never happen');
  assert.match(FAILURES, /api\.retryTask/, 'the retry is not reachable from the panel');
});

test('a retry names the person, and the button says what it will do', () => {
  assert.match(FAILURES, /reviewer\.trim\(\)/, 'the retry is anonymous');
  assert.match(FAILURES, /window\.confirm/,
               'a button that re-runs a container in an account fires on one click');
  // The confirmation has to say the object is written back unchanged. A person who thinks the
  // dashboard composes the marker would read this button as far more dangerous than it is - and
  // one who thinks it fixes something would press it expecting a different outcome.
  assert.match(FAILURES, /읽은 그대로 다시 쓰입니다/);
});

test('a failure with nothing to re-put offers no button', () => {
  // A task started by hand carries no overrides, so there is no object whose write starts it. The
  // row is still worth showing; the button is not.
  assert.match(FAILURES, /!entry\.retryable \?/,
               'every row offers a retry, including ones the server would refuse with a 409');
});

test('the failures panel is on the failure tab and not on the other three', () => {
  // It was on all four. On "plans", "running" and "rbp" nothing about it was actionable, so it read
  // as a banner that would not go away - and a warning people learn to scroll past is worse than no
  // warning, because it spends the attention the real one needs.
  //
  // Matched on the guard rather than on the tab name alone: `<TaskFailures />` with the string
  // "failed" somewhere else in the file would satisfy a looser pattern while still rendering on
  // every page, which is the exact defect this pins.
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /\{tab === "failed" && <TaskFailures \/>\}/,
               'the failures panel is not gated on the failure tab');
  // And no second, ungated render. The guarded one above is the only place it may appear.
  const renders = app.split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .filter((line) => /<TaskFailures\s*\/>/.test(line));
  assert.equal(renders.length, 1, `TaskFailures is rendered ${renders.length} times: ${renders}`);
  assert.match(renders[0], /tab === "failed"/,
               'the render of TaskFailures is not the guarded one');
});

// ---- 이 정책이 닿는 자원의 구성도 ------------------------------------------------------------
//
// The impact assessment as a picture. A picture says more than the list it replaces: putting an
// instance inside a security group inside a subnet inside a VPC claims four things, and the
// assessment measured none of them. Every test below is about that gap staying visible - the
// sentences that name it, where they sit relative to the drawing, and the component staying a
// renderer rather than growing a placement table of its own.
//
// The geometry half is in server/ec2Topology.test.js, because a slot escaping its frame is
// invisible to any assertion made against source text.

const TOPOLOGY = readFileSync(new URL('../src/components/Topology.tsx', import.meta.url), 'utf8');
/** The component with its comments stripped. The prose explains at length what the code must NOT
 *  do - "it never renders ServiceIcon", "a literal id=\"topo-arrow\" would collide" - so an
 *  assertion against the raw file trips on the sentence forbidding the thing it looks for. The
 *  Korean sentence tests above want the WHOLE file; these want the code. */
const TOPOLOGY_CODE = TOPOLOGY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the window says the five things that make the picture honest', () => {
  // Modelled on 'the per-policy view says the three things that make it honest', and for the same
  // reason: the needle is the rendered Korean sentence, not an identifier that live render code
  // would keep alive after the sentence was deleted.
  assert.match(TOPOLOGY, /유형에 따라 \{spec\.words\.title\} 구성에서 놓이는 자리/,
               'nothing tells the reader the placement is by type rather than measured');
  assert.match(TOPOLOGY, /이 평가가 유형 단위로 답하는 질문이 아니다/,
               'nothing says the per-resource placement is not what the assessment answers');
  assert.ok(TOPOLOGY.includes('테두리의 포함 관계는 측정한 것이 아니'),
            'the frames are not declared canonical rather than measured');
  assert.ok(TOPOLOGY.includes('가용 영역은'),
            'the window does not say why the availability zone frame carries no count');
  assert.ok(TOPOLOGY.includes('리전을 합친 수'),
            'the picture does not say the counts are added across regions');
  assert.ok(TOPOLOGY.includes('이 계정에서 확인한 연결이 아니다'),
            'the one arrow is not declared canonical');
});

test('the caveat is above the picture, not under it', () => {
  assert.ok(TOPOLOGY.indexOf('측정한 것이 아니') < TOPOLOGY.indexOf('topology-figure'),
            'the caveat sits below the drawing, where it is read after the wrong conclusion has '
            + 'already formed');
});

test('the caveat survives a screenshot', () => {
  // A caveat in the dialog body does not travel with a cropped image of the figure. The caption is
  // a <text> inside the viewBox, so it does - and it comes out of the module, which is what the
  // topology test pins.
  assert.ok(TOPOLOGY.includes('topo-foot'),
            'the picture renders no foot line, so the caption inside the viewBox is gone');
});

test('the caveats cannot scroll away from the picture', () => {
  // This test used to assert the dialog set NO overflow, on the belief that unset means unscrolled.
  // It does not: the UA stylesheet gives `dialog:modal { overflow: auto }`, so setting nothing WAS
  // setting auto, the whole window scrolled, and on any screen short enough the two caveat
  // paragraphs went off the top - while this assertion and the comment beside it both said they
  // could not. Saying nothing is not the same as saying none, and only `overflow: hidden` on the
  // dialog says none.
  assert.match(CSS, /\.topology-figure[^}]*max-height/,
               'the figure does not scroll, so a wide picture stretches the window instead');
  assert.match(CSS, /dialog\.policy-dialog\.topology-dialog\s*\{[^}]*overflow:\s*hidden/,
               'the dialog does not stop the UA scroll, so the caveats scroll off with it');
  assert.match(CSS, /\.topology-scroll\s*\{[^}]*overflow:\s*auto/,
               'nothing below the caveats scrolls, so the window grows past the viewport instead');
  // And the caveats have to be OUTSIDE that scrolling region, or none of the above helps.
  assert.ok(TOPOLOGY.indexOf('topology-caveats') < TOPOLOGY.indexOf('topology-scroll'),
            'the caveats moved inside the scrolling region');
});

test('the component computes no coordinates of its own', () => {
  // Every number in the drawing comes out of a module with unit tests behind it. A coordinate
  // computed here is a coordinate nothing checks.
  assert.ok(/topology\.js/.test(TOPOLOGY) && /sceneOf\(/.test(TOPOLOGY),
            'the component no longer gets its scene from the tested module');
  assert.ok(!/const [A-Z_]{3,} = \d+;/.test(TOPOLOGY_CODE),
            'the component grew a geometry constant of its own, so two files can disagree');
});

test('the component holds no slot table of its own', () => {
  assert.ok(!/'ec2:instance'/.test(TOPOLOGY_CODE),
            'the component built a placement table of its own, so the two tables can disagree');
  assert.ok(!/resources\.length/.test(TOPOLOGY_CODE),
            'the component counted the capped row list instead of the group total');
});

test('the diagram never renders the service icon', () => {
  assert.ok(!TOPOLOGY_CODE.includes('resourceIconPath') && !TOPOLOGY_CODE.includes('<ServiceIcon'),
            'the diagram falls back to the service icon, which puts an EC2 tile where a key pair is');
});

test('the picture has a text equivalent', () => {
  for (const needle of ['role="img"', '<title', '<desc', 'sceneSummary(', 'topology-table']) {
    assert.ok(TOPOLOGY.includes(needle), `the picture is missing ${needle}`);
  }
  assert.match(CSS, /\.topology-table\b/, "the table that is the picture's equal is unstyled");
});

test('the scroll region is reachable by keyboard', () => {
  // A scrollable box no keyboard can reach is a box half the readers cannot read.
  assert.ok(TOPOLOGY.includes('tabIndex={0}') && TOPOLOGY.includes('aria-label="자원 구성도"'),
            'the figure cannot be scrolled without a mouse');
  assert.match(CSS, /\.topology-figure:focus-visible/, 'the focused figure shows no focus ring');
});

test('the marker id cannot collide', () => {
  assert.ok(TOPOLOGY.includes('useId()'),
            'the arrow markers use a fixed id, so two policy blocks resolve to the same marker');
  assert.ok(!/id="topo-[a-z]+"/.test(TOPOLOGY_CODE),
            'a literal marker id would make every arrow on the page point at the first one');
});

test('the button sits between the groups and the restriction area', () => {
  assert.ok(IMPACT.lastIndexOf('<GroupBlock') < IMPACT.indexOf('<PolicyTopology'),
            'the picture is drawn above the groups it depicts');
  assert.ok(IMPACT.indexOf('<PolicyTopology') < IMPACT.indexOf('<div className="restrict">'),
            'the picture landed inside the restriction area, where it reads as a control');
});

test('the gate is not a policy-name compare in the page', () => {
  assert.ok(!IMPACT.includes('AmazonEC2FullAccess'),
            'a policy-name condition landed in a 1,700-line file where nobody will find it - '
            + 'the gate belongs in server/ec2Topology.js');
});

test('the dialog modifier does not depend on source order', () => {
  assert.match(CSS, /dialog\.policy-dialog\.topology-dialog\b/,
               'the modifier ties .policy-dialog on specificity and wins only on where it landed');
});

test('closing by clicking outside is decided by where the pointer was', () => {
  // e.target === dialog is TRUE for a click on the dialog's own scrollbar, and for a click event
  // synthesised on the dialog after a mousedown inside and a mouseup outside. So dragging the
  // scrollbar closed the window, and so did selecting a row in the table and releasing past the
  // edge. The rect test asks what the reader is actually doing: did the pointer land outside the
  // box. It also stops the behaviour depending on .policy-dialog keeping padding:0.
  assert.ok(TOPOLOGY.includes('getBoundingClientRect'),
            'the backdrop test is back to an identity comparison, which the scrollbar satisfies');
  for (const needle of ['e.clientX', 'e.clientY']) {
    assert.ok(TOPOLOGY.includes(needle), `the pointer position is not consulted (${needle})`);
  }
});

test('the filter does not outlive the window it was set in', () => {
  // PolicyTopology never unmounts - the sweep poll re-renders it with the same key - so the initial
  // useState value is not a reset. A filter an approver set five minutes ago and cannot see is a
  // filter that makes the next picture a quiet lie, which is what the comment beside it promised
  // was impossible.
  assert.match(TOPOLOGY, /onClose=\{\(\) => setFilter\(/,
               'closing the window keeps the filter, so reopening it draws a narrowed picture');
});

test('the window says what it is and opens on the caveats', () => {
  // showModal() focuses the first focusable descendant, which was the 전체 checkbox in the filter
  // bar - past the two paragraphs that make the picture honest. A screen reader heard an unnamed
  // dialog and landed on a control.
  assert.ok(/aria-labelledby=\{`\$\{uid\}-h`\}/.test(TOPOLOGY), 'the window has no accessible name');
  assert.ok(/aria-describedby=\{`\$\{uid\}-c`\}/.test(TOPOLOGY),
            'the caveats are not what the window is described by');
  assert.ok(/className="topology-caveats"[^>]*autoFocus/.test(TOPOLOGY),
            'the window does not open on the caveats');
});

test('the legend describes the red the picture actually draws', () => {
  // It said 빨간 테두리 — 민감 자원이 들어 있다, and was false in both directions: the 보안 그룹
  // frame is stroked with AWS's own #DD344C whatever is inside it, and no frame ever turned red
  // for holding a sensitive resource. The one conditional red is the resource PLATE.
  const legend = TOPOLOGY.slice(TOPOLOGY.indexOf('topology-legend'));
  assert.ok(legend.includes('자원 판의'), 'the legend does not say which red is the conditional one');
  assert.ok(legend.includes('AWS의 그룹 색'),
            'the legend does not say the 보안 그룹 border is a family colour, not a warning');
  assert.ok(TOPOLOGY.includes('topo-frame-sensitive'),
            'a frame carries no sensitive marking, so the promise has no channel for frames');
  assert.match(CSS, /\.topo-frame-sensitive\b/, 'the frame sensitive marking is unstyled');
});

test('every class the picture renders has a rule', () => {
  for (const cls of ['.topology-launch', '.topology-dialog', '.topology-figure', '.topology-svg',
                     '.topology-legend', '.topology-table', '.topo-frame', '.topo-frame-sg',
                     '.topo-slot', '.topo-slot-sensitive', '.topo-erase', '.topo-link',
                     '.topo-foot', '.topo-ground']) {
    assert.ok(CSS.includes(cls), `${cls} is rendered and has no rule`);
  }
});

test('the stylesheet still sets no literal colour', () => {
  // The four AWS group colours are emitted by the module as inline styles, so this feature's
  // section adds none - which is what keeps the file's own banner true.
  const section = CSS.slice(CSS.indexOf('이 정책이 닿는 자원의 구성도'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{6}/.test(section),
            'an AWS deck colour was hard-coded into the stylesheet instead of being emitted as an '
            + 'inline style by the topology spec');
});

test('the solid and dashed grammar is stated where it is used', () => {
  // Three pictures now, and the 점선 line is written once per picture because what the dashes
  // mean differs - EC2 asserts a scoping order, Lambda and ECS assert that two frames do NOT
  // contain each other. The 실선 line is shared and comes first in all three.
  assert.match(TOPOLOGY, /실선[\s\S]{0,1200}점선/,
               'the legend no longer distinguishes measured containment from canonical placement');
  assert.equal((TOPOLOGY.match(/<strong>점선 테두리<\/strong>/g) ?? []).length, 3,
               'a picture lost its dashed-border sentence, or gained one it does not draw');
  assert.ok(TOPOLOGY.includes('하한'), 'truncation does not reach the screen');
  assert.ok(TOPOLOGY.includes('민감'), 'sensitivity does not reach the screen');
});

test('the filter offers every dimension a container records', () => {
  assert.ok(TOPOLOGY.includes('<FilterBar'), 'the window offers no way to narrow the picture');
  assert.ok(TOPOLOGY.includes('전체'), 'there is no way back to the unnarrowed picture');
  // Rendered through one helper now, so the pin is on the call rather than on a literal prop - a
  // dimension a spec does not name is not offered, and that decision belongs in the spec.
  for (const [id, label] of [['accounts', '계정'], ['regions', '리전'], ['clusters', '클러스터'],
                             ['vpcs', 'VPC'], ['subnets', '서브넷']]) {
    assert.ok(TOPOLOGY.includes(`dimension("${id}", "${label}")`), `${label} cannot be chosen`);
  }
  // The component reads the facets the module computed and never a raw row field of its own: the
  // three meanings of a missing vpc_id are decided in one tested place.
  assert.ok(!/resource\.vpc_id|\.subnet_id/.test(TOPOLOGY_CODE),
            'the component reached into a row for placement instead of using the facets');
});

test('the rows the placement lookup could not place are counted on screen', () => {
  // Defect it prevents: a denied optional permission reading as an empty VPC. A row with no vpc_id
  // is not evidence of belonging and not evidence of not belonging, and folding it silently into
  // "not in this VPC" turns a lookup failure into a claim about the account.
  assert.ok(TOPOLOGY.includes('VPC를 알 수 없는 자원이'),
            'nothing says how many resources a VPC filter cannot speak for');
  assert.ok(TOPOLOGY.includes('이 자원들은 빠진다'),
            'the window does not say that narrowing by VPC drops the unplaced rows');
  assert.ok(TOPOLOGY.includes('VPC가 아예 없는'),
            'a volume, which has no VPC by definition, is not distinguished from a lookup failure');
});

test('a narrowed picture says what it left out', () => {
  // Defect it prevents: an approver narrowing to one region, reading a small number, and carrying
  // away "this policy reaches little". The picture alone cannot tell that from "I am looking at
  // part of it".
  //
  // The wording is neutral about WHO narrowed it, and that is deliberate now that two types are off
  // by default: 「고른 조건만」 said the reader chose this, and for those two nobody did.
  assert.ok(TOPOLOGY.includes('지금 그림에 있는 것은 일부다'),
            'a filtered picture does not say it is filtered');
  assert.ok(TOPOLOGY.includes('좁히지 않으면'),
            'a filtered picture does not say what the whole would be');
  assert.ok(TOPOLOGY.includes('유형 체크를 풀어 감춘 것이'),
            'a picture with a type switched off does not say how much that took away');
});

test('the type checkboxes hide a layer, and say what they are not offering', () => {
  // The opposite grammar from the facets beside them, on purpose: a facet narrows TO what is
  // ticked, this hides what is UNTICKED. An account is a place ("show me that one"); a resource
  // type is a layer over the picture ("take that away"), and forty network interfaces drawn over
  // the instances they belong to is the second question every time.
  assert.ok(TOPOLOGY.includes('function TypePicker('), 'there are no type checkboxes');
  assert.ok(TOPOLOGY.includes('checked={!hidden.includes(t.resourceType)}'),
            'the boxes read the narrow-to way round, so unticking one shows only it');
  // Read off the UNFILTERED scene, or a type switched off would leave the list and could never be
  // switched back on.
  assert.ok(TOPOLOGY.includes('<TypePicker types={wholeGraph.types}'),
            'the checkbox list is read off the filtered scene');
  // Two off by default: the subnet band already names its table and the default route that made it
  // public or private, so the table's plate and lines are a second copy of an answer on screen.
  assert.match(TOPOLOGY, /hiddenTypes: \["ec2:route-table", "ec2:network-acl"\]/,
               'the route tables and ACLs are not switched off to begin with');
  assert.ok(TOPOLOGY.includes('라우팅 테이블과 네트워크 ACL은 처음부터 꺼져 있다'),
            'nothing says why two types start switched off');
  // Container types are not offered - taking a border away is a different request, and a picture
  // whose subnet frames vanished while the instances stayed would claim they are in no subnet.
  assert.ok(TOPOLOGY.includes('types.filter((t) => !t.container)')
            && TOPOLOGY.includes('VPC와 서브넷은 여기 없다'),
            'the border types are offered as boxes, or their absence is unexplained');
  const graph = read('../server/graph.js');
  assert.ok(graph.includes('export const CONTAINER_TYPES')
            && graph.includes('if (CONTAINER_TYPES.has(n.resourceType)) return null;'),
            'placeOf and the checkbox list can disagree about what a border is');
  for (const cls of ['.topology-types', '.topology-type-list', '.linkish']) {
    assert.ok(CSS.includes(cls), `${cls} is rendered and has no rule`);
  }
});

test('the legend explains the band the subnets are drawn in', () => {
  // The layout itself is server-side and server/graph.test.js pins it against real coordinates -
  // that the public subnets share one top across every zone, that the private band starts below
  // the tallest public one, and that each zone frame still holds only its own subnets. What has to
  // hold HERE is that the screen says the arrangement means something, because a reader who sees
  // an order and is told nothing will invent a reason for it.
  const legend = TOPOLOGY.slice(TOPOLOGY.indexOf('topology-legend'));
  assert.ok(legend.includes('인터넷 게이트웨이와 가까운 쪽'),
            'the legend does not say what the top band of subnets is');
});

test('the closed-state summary describes the policy, not the filter', () => {
  // The line beside the button is a fact about the policy. Letting a filter set inside the window
  // change it would make the panel disagree with itself for a reason nobody outside can see.
  const at = TOPOLOGY.indexOf('{subject} {summary.kinds}');
  assert.ok(at > 0, 'the closed-state line is gone');
  const line = TOPOLOGY.slice(at, TOPOLOGY.indexOf('</span>', at));
  assert.ok(line.includes('summary.kinds') && line.includes('summary.measured'),
            'the closed-state line no longer reads the summary');
  // And `summary` itself is built from the UNFILTERED scenes. Both are read now, because a policy
  // with no spec has no type scene and the line still has to say what it reaches - but neither of
  // the filtered ones may appear, or collapsing the window leaves a count describing a filter
  // nobody outside it can see.
  const from = TOPOLOGY.indexOf('const summary = whole');
  const built = TOPOLOGY.slice(from, TOPOLOGY.indexOf('\n\n', from));   // the expression, no comments
  assert.ok(built.includes('whole.kinds') && built.includes('wholeGraph.kinds'),
            'the summary does not read both unfiltered scenes');
  assert.ok(!/[^a-zA-Z]scene\.|[^a-zA-Z]graph\./.test(built),
            'the summary reads a FILTERED scene');
  // The noun is the spec's where there is one and plain 자원 where there is not: a heading naming
  // a service over a picture that spans four of them would lie about the picture.
  assert.ok(TOPOLOGY.includes('const subject = spec ? `${spec.words.title} 자원` : "자원"'),
            'the window names a service it may not be about');
});

// ---- the relationship picture, the EC2 window's second view ------------------------------------
// server/graph.test.js pins the geometry - containment, no overlaps, where a line leaves a plate.
// What is pinned here is the screen half: that it is a view of the same window and not a second
// window, the sentences that keep it honest, and that the legend cannot drift from the picture.

import { KIND_LABEL } from './graph.js';

test('the relationship picture is a second view of the same window, not a second window', () => {
  assert.ok(TOPOLOGY.includes('relationScene('), 'the component does not draw the relationship picture');
  assert.ok(TOPOLOGY.includes('aria-pressed={view === "graph"}') && TOPOLOGY.includes('aria-pressed={view === "types"}'),
            'the two views are not a pressed/unpressed pair');
  // The document decides the default: a graph of unconnected plates says less than the type picture.
  assert.ok(TOPOLOGY.includes('wholeGraph.informative ? "graph" : "types"'),
            'an older assessment with no placement and no link would open on an empty graph');
  // One switch above the caveats, one filter bar, one 닫기 row.
  assert.ok(TOPOLOGY.indexOf('topology-views') < TOPOLOGY.indexOf('topology-caveats'),
            'the switch is below the caveats it changes');
  assert.equal((TOPOLOGY.match(/<FilterBar/g) ?? []).length, 1, 'the two views grew two filter bars');
  assert.match(CSS, /\.topology-views\b/, 'the switch is unstyled');
});

test('the window is as wide as the screen allows', () => {
  // A graph of one plate per resource in a 900px window is a graph nobody can read; the figure
  // scrolls inside the window rather than the window shrinking the figure.
  //
  // Defect it prevents: .policy-dialog caps itself at 900px and a width never beats a max-width, so
  // the window shipped at 900px while its width rule said 1720 - and the render harness, which
  // lifted the cap itself, showed a wide window the users never got. The cap has to be lifted in
  // the stylesheet, by name, and the picture has to fill what the window then offers.
  const rule = CSS.match(/dialog\.policy-dialog\.topology-dialog\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /width:\s*calc\(100vw - \d+px\)/, 'the window is not the screen\'s width');
  assert.match(rule, /max-width:\s*calc\(100vw - \d+px\)/,
               "the window's width is capped by .policy-dialog's 900px again");
  assert.match(CSS, /\.graph-svg\s*\{[^}]*width:\s*100%/, 'the picture does not fill the window');
  assert.ok(TOPOLOGY.includes('style={{ minWidth: scene.width }}'),
            'a narrow window shrinks the picture instead of scrolling it');
});

test('the relationship picture says what a line is and what a missing line is not', () => {
  assert.ok(TOPOLOGY.includes('조회기가 자원마다 읽은 연결'), 'nothing says the lines were read off the resources');
  assert.ok(TOPOLOGY.includes('선이 없다고 연결이 없다는 뜻은 아니다'), 'a missing line is not declared non-evidence');
  assert.ok(TOPOLOGY.includes('보안 그룹 선은 규칙이 아니라 소속이다'), 'a group line could be read as a rule');
  assert.ok(TOPOLOGY.includes('자원이 자기 자리라고 답한 VPC·가용 영역·서브넷'),
            'the borders are not said to be what the resource answered');
  // Above the figure, as the type picture's caveat is.
  assert.ok(TOPOLOGY.indexOf('조회기가 자원마다 읽은 연결') < TOPOLOGY.indexOf('<GraphFigure'),
            'the caveat sits below the drawing');
});

test('the legend draws each kind of line with the class the picture uses, and every kind has a rule', () => {
  for (const kind of Object.keys(KIND_LABEL)) {
    assert.match(CSS, new RegExp(`\\.graph-edge-${kind}\\b`), `${kind} lines have no colour`);
  }
  assert.ok(TOPOLOGY.includes('className={`graph-edge graph-edge-${kind}`}'),
            "the legend swatch is not the picture's own class, so the two can drift");
  assert.ok(TOPOLOGY.includes('graph-edge-implicit'), 'a derived line is drawn like a recorded one');
  assert.match(CSS, /\.graph-edge-implicit\s*\{[^}]*stroke-dasharray/, 'a derived line is not dashed');
  // Only a route has a direction; an arrowhead on a membership line would claim one.
  assert.ok(TOPOLOGY.includes('edge.kind === "route" ? `url(#${uid}-ga)` : undefined'),
            'an arrowhead landed on an undirected line');
});

test('a line cannot be mistaken for a line from the plate it passes under', () => {
  // Lines are painted under the plates, so a line can vanish under one and reappear. The rings on
  // both ends say where it really stops, and the container labels are painted over the lines with
  // a halo so a crossed label stays readable.
  assert.ok(TOPOLOGY.includes('graph-edge-end'), 'the line ends carry no ring');
  assert.match(CSS, /\.graph-edge-end\b/, 'the end ring is unstyled');
  assert.match(CSS, /\.graph-box-text\s*\{[^}]*paint-order:\s*stroke/, 'container labels have no halo');
  const figure = TOPOLOGY.slice(TOPOLOGY.indexOf('function GraphFigure'), TOPOLOGY.indexOf('function GraphTable'));
  const layers = ['<GraphContainerShape', '<GraphEdgeShape', '<GraphContainerLabel', '<GraphOverflowShape', '<GraphNodeShape'];
  const at = layers.map((tag) => figure.indexOf(tag));
  assert.ok(at.every((i) => i >= 0), 'a layer is missing from the figure');
  assert.deepEqual([...at].sort((a, b) => a - b), at,
                   'the paint order is not borders, lines, labels, overflow, plates');
});

test('the relationship view has its own text equivalent and its own table', () => {
  assert.ok(TOPOLOGY.includes('graphSummary(') && TOPOLOGY.includes('aria-label="자원 연결 관계도"'),
            'the relationship picture has no text equivalent');
  assert.ok(TOPOLOGY.includes('<GraphTable'), 'the relationship picture has no table to check it against');
  assert.ok(TOPOLOGY.includes('{row.typeLabel}') && TOPOLOGY.includes('row.degree'),
            'the table does not say the type or the number of lines');
});

test('the closed-state line counts the connections off the unfiltered graph', () => {
  const at = TOPOLOGY.indexOf('{subject} {summary.kinds}');
  const summary = TOPOLOGY.slice(at, TOPOLOGY.indexOf('</span>', at));
  assert.ok(summary.includes('wholeGraph.counts.edges'), 'the closed state does not say how many connections there are');
  assert.ok(!/[^A-Za-z]graph\.counts/.test(summary), 'the closed-state count reads the filtered graph');
});

test('an instance is a box holding its interfaces, and the legend says so', () => {
  assert.ok(TOPOLOGY.includes('node.box'), 'the renderer draws no box for an instance');
  assert.match(CSS, /\.graph-plate-box\b/, 'the instance box is unstyled');
  const legend = TOPOLOGY.slice(TOPOLOGY.indexOf('topology-legend'));
  assert.ok(legend.includes('인스턴스 상자'), 'the legend does not explain the instance box');
  assert.ok(legend.includes('보안 그룹 선은 인터페이스가 아니라 인스턴스 상자로 향한다'),
            'the legend does not say where a group line ends');
  // Boxes are painted before plates, or the frame would cover the interfaces inside it.
  const figure = TOPOLOGY.slice(TOPOLOGY.indexOf('function GraphFigure'), TOPOLOGY.indexOf('function GraphTable'));
  assert.ok(figure.indexOf('filter((n) => n.box)') < figure.indexOf('filter((n) => !n.box)'),
            'plates are painted before the boxes that hold them');
});

test('every connection is dashed and orthogonal, and a derived one is dashed differently', () => {
  // A dashed line is a relation and a solid line is a border, and the eye keeps the two apart;
  // the derived line (the main route table's) still has to read apart from the recorded ones.
  const base = CSS.match(/\.graph-edge\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(base, /stroke-dasharray:\s*[\d.]+ [\d.]+/, 'connections are solid');
  const implicit = CSS.match(/\.graph-edge-implicit\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(implicit, /stroke-dasharray:\s*[\d.]+ [\d.]+/, 'a derived line has no dash of its own');
  assert.notEqual(base.match(/stroke-dasharray:\s*([\d. ]+)/)[1], implicit.match(/stroke-dasharray:\s*([\d. ]+)/)[1],
                  'a derived line is dashed like a recorded one');
  const legend = TOPOLOGY.slice(TOPOLOGY.indexOf('topology-legend'));
  assert.ok(legend.includes('전부 점선이고') && legend.includes('직각으로만 꺾인다'),
            'the legend does not say what a dashed, bent line is');
  assert.ok(legend.includes('촘촘한 점선'), 'the legend does not name the derived dash');
});

test('an instance opens on click to show its interfaces, and the subnets are coloured by their tables', () => {
  assert.ok(TOPOLOGY.includes('{ expanded }'), 'the picture is not told which boxes are open');
  // A box with no interfaces to show has no expanded state at all - aria-expanded on it would
  // promise a fold that is not there.
  assert.ok(TOPOLOGY.includes('aria-expanded={openable ? node.open : undefined}'),
            'the box does not say whether it is open');
  assert.ok(TOPOLOGY.includes('onToggle(node.id)'), 'clicking a box toggles nothing');
  assert.ok(TOPOLOGY.includes('e.key === "Enter" || e.key === " "'), 'a box cannot be opened from the keyboard');
  assert.match(CSS, /\.graph-node-toggle\s*\{[^}]*cursor:\s*pointer/, 'an openable box does not look clickable');
  for (const cls of ['.graph-box-public', '.graph-box-private']) assert.ok(CSS.includes(cls), `${cls} is unstyled`);
  // The two fills are palette tokens, defined with the rest of the palette and not in the
  // picture's own section, which sets no literal colour.
  const root = CSS.slice(0, CSS.indexOf('이 정책이 닿는 자원의 구성도'));
  assert.ok(/--subnet-public:\s*#[0-9a-f]{6}/.test(root) && /--subnet-private:\s*#[0-9a-f]{6}/.test(root),
            'the subnet colours are not tokens');
  const legend = TOPOLOGY.slice(TOPOLOGY.indexOf('topology-legend'));
  assert.ok(legend.includes('누르면 붙은 네트워크 인터페이스가 안에 펼쳐지고'),
            'the legend does not say a box opens on click');
  assert.ok(legend.includes('퍼블릭') && legend.includes('프라이빗'), 'the legend does not explain the subnet colours');
  assert.ok(legend.includes('가운데 열에'), 'the legend does not say where the tables sit');
});

// ---- the resource panel: the diagram joined to the two analyses --------------------------------
// server/resourceFacts.test.js pins the JOIN - which finding reaches which resource, and which
// only reaches its type. What is pinned here is the screen half: that the panel says where each
// half of its answer came from, that an empty analysis is not drawn as "nothing was found", and
// that the findings reach the diagram at all.

test('clicking a resource opens what the policy allows on it and what the analyses found', () => {
  assert.ok(TOPOLOGY.includes('resourceFacts('), 'the diagram computes no per-resource facts');
  assert.ok(TOPOLOGY.includes('<ResourcePanel'), 'nothing renders the panel');
  assert.ok(TOPOLOGY.includes('onSelect={setChosen}') && TOPOLOGY.includes('aria-pressed={selected}'),
            'a plate cannot be chosen, or does not say it is');
  assert.ok(TOPOLOGY.includes('onKeyDown={keyed}'), 'a plate cannot be chosen from the keyboard');
  // The panel sits BESIDE the picture: below it, clicking a plate scrolls the plate out of view.
  assert.ok(TOPOLOGY.includes('graph-with-panel'), 'the panel is not beside the picture');
  assert.match(CSS, /\.graph-with-panel\s*\{[^}]*display:\s*flex/, 'the panel does not sit beside the figure');
  for (const cls of ['.graph-panel', '.panel-actions', '.panel-findings', '.panel-level',
                     '.panel-source', '.graph-mark', '.graph-node-selected']) {
    assert.ok(CSS.includes(cls), `${cls} is rendered and has no rule`);
  }
});

test('the panel says which of its two answers is missing rather than saying nothing was found', () => {
  // Defect it prevents: an approver reading an empty 분석 section as "this resource is clean" when
  // nobody has run an analysis yet. The two states are opposite news and look identical.
  assert.ok(TOPOLOGY.includes('아직 분석을 돌리지 않았다'), 'an unrun analysis is drawn as an empty result');
  assert.ok(TOPOLOGY.includes('지금 비어 있는 것은 발견이 없다는\n                뜻이 아니다')
            || TOPOLOGY.includes('비어 있는 것은 발견이 없다는'),
            'nothing says an empty panel is not a clean bill');
  assert.ok(TOPOLOGY.includes('이 자원인지는 알 수 없는'),
            'a finding whose sample was cut is drawn as if it named this resource');
  assert.ok(TOPOLOGY.includes('자원을 지정하지 않았다'),
            'the panel does not say a policy that named no resource covers what is made next');
  assert.ok(TOPOLOGY.includes('이 유형을 생성한다'),
            'an action that brings the type into being is not marked');
});

test('the page keeps one vocabulary for the grades, the statuses and the categories', () => {
  // src/grades.ts says it in its own comment: two screens that call the same grade by two words
  // are two screens an approver cannot compare. The diagram's panel and the analysis page read
  // from the same table, and the engine module returns the raw vocabulary rather than a copy.
  assert.match(read('grades.ts'), /export const CATEGORY_LABEL/, 'the category names are not in one place');
  assert.ok(PANEL.includes('CATEGORY_LABEL.ESCALATION'),
            'the analysis page kept its own copy of the category names');
  assert.ok(TOPOLOGY.includes('CATEGORY_LABEL[card.category]') && TOPOLOGY.includes('GRADE_CLASS[card.grade]'),
            'the panel does not use the page vocabulary');
  const facts = readFileSync(new URL('./resourceFacts.js', import.meta.url), 'utf8');
  assert.ok(!/CATEGORY_LABEL\s*=/.test(facts) && !/STATUS_LABEL\s*=/.test(facts),
            'the engine grew a second copy of the page vocabulary');
});

test('the findings reach the diagram from the analysis that produced them', () => {
  // WHAT they hold is server/analysisFindings.js and its own test file. What is pinned here is the
  // wiring, because the defect was entirely in the wiring: the list was right and nothing carried
  // it. 정책 기반 분석 fired 14 findings, the screen drew all 14, and the diagram above said
  // 「아직 분석을 돌리지 않았다」 - because reporting them was a line inside settle(), and a
  // rules-only run never settles anything.
  assert.ok(PANEL.includes('findingsOfAnswer(answer)'),
            'the analysis does not report its findings for the diagram');
  // The report is an EFFECT on the answer, not a line in the branch that produced one. That is the
  // fix: a branch can forget, and one did for as long as this was each branch's own job.
  const reporting = PANEL.slice(PANEL.indexOf('onFindings(scope'));
  assert.ok(/^[^;]*\);\s*\n(\s*\/\/[^\n]*\n)*\s*\},\s*\[scope, onFindings,/.test(reporting),
            'the findings are reported from somewhere other than an effect on the answer');
  assert.ok(!/\bsettle\s*=\s*\([^)]*\)\s*=>\s*\{[^}]*onFindings\(/s.test(PANEL),
            'settle() reports the findings again - a rules-only run never reaches it');
  assert.ok(DETAIL.includes('onFindings={takeFindings}') && DETAIL.includes('useCallback('),
            'the page does not hold the findings, or rebuilds the handler the effect is keyed on');
  assert.ok(IMPACT.includes('findings={allFindings}'), 'the findings do not reach the policy block');
  assert.ok(IMPACT.includes('everyFinding(findings)'), 'the diagram is not given the findings');
});

test('the window opens for any policy, and only the type picture is gated on a spec', () => {
  // What changed and what did not. The 유형별 자리 picture puts a type where AWS normally puts it,
  // which is a claim only three services have an answer for - so it keeps its spec. The
  // relationship picture claims nothing of the sort: every border is a placement the querier read
  // off the resource and every line is a link it read, so it is drawn for every policy, from the
  // groups the assessment says that policy's actions reach.
  assert.ok(TOPOLOGY.includes('if (!facets || !graph || !wholeGraph) return null;'),
            'the window is still gated on something other than what can be drawn');
  assert.ok(!TOPOLOGY.includes('!scene || !whole || !facets || !spec'),
            'the window still refuses a policy for not being one of three');
  // The switch appears only where both pictures exist, and the fallback view inverted with it: a
  // policy with no spec has no type picture to fall back TO.
  assert.ok(TOPOLOGY.includes('const typed = !!(spec && scene && whole)')
            && TOPOLOGY.includes(': "graph";'),
            'the view still falls back to a picture that may not exist');
  // A policy that reaches nothing, on an assessment that enumerated fine, gets no button - the
  // group list above already says it reaches nothing. A FAILED lookup still does, because there
  // the empty picture is a fact about the assessment.
  assert.ok(TOPOLOGY.includes('if (wholeGraph.empty && enumerated && !spec) return null;'),
            'an empty picture is offered over a policy that reaches nothing, or withheld over a '
            + 'failed lookup');
});

test('the legend explains only the marks this picture actually carries', () => {
  // This file's own banner is the rule, and drawing every policy is what made it bite: a policy
  // reaching only S3 buckets used to get a legend about instance boxes, subnet colours and six
  // line colours, none of which were on the screen. A legend that explains marks the reader cannot
  // see teaches them to skim it.
  const legend = TOPOLOGY.slice(TOPOLOGY.indexOf('<ul className="topology-legend">'));
  assert.ok(legend.includes('graph.nodes.some((n) => n.box)'),
            'the instance box is explained over a picture with no instance in it');
  assert.ok(legend.includes('graph.containers.some((c) => c.kind === "subnet")'),
            'the subnet colours are explained over a picture with no subnet in it');
  assert.ok(legend.includes('{drawnKinds.map((kind)') && !legend.includes('Object.keys(KIND_LABEL) as EdgeKind[]).map'),
            'every line colour is explained, including the ones this picture does not draw');
  assert.ok(TOPOLOGY.includes('.filter((kind) => graph.edges.some((e) => e.kind === kind))'),
            'the drawn kinds are not read off the edges');
});

test('a resource type is named and drawn the same whatever policy reached it', () => {
  // The labels and the glyphs used to be read through the OPEN POLICY's spec, so the same instance
  // was 「인스턴스」 under one policy and `ec2:instance` under another. They are keyed by type now,
  // and a type outside every spec falls back to the service's own icon rather than a blank tile.
  const topo = read('../server/topology.js');
  assert.ok(topo.includes('export const TYPE_LABEL') && topo.includes('export const TYPE_ICON'),
            'the type names are still reachable only through a policy');
  const graph = read('../server/graph.js');
  assert.ok(graph.includes('TYPE_LABEL.get(type) ?? type'), 'the picture names a type some other way');
  assert.ok(graph.includes('resourceIconPath(group.service, type)'),
            'a resource outside the three specs draws no icon');
  assert.ok(!/spec\.(slots|services|frameLabel)/.test(graph),
            'the picture still reads a policy-chosen spec');
});

test('a finding in the diagram opens the same card the analysis page draws', () => {
  // The panel's list is a SUMMARY - a grade, a title, and the actions that reached this type. What
  // a reader needs next is the narrative, the full trigger list, the targets and the containment
  // badge, and all of that already exists as a card on the analysis page. Drawing a second version
  // of it here would be a card an approver has to reconcile with the first.
  assert.ok(PANEL.includes('export function RiskFindingCard('),
            'the analysis page does not lend its card out');
  assert.ok(TOPOLOGY.includes('import { RiskFindingCard } from "./RiskAnalysis"')
            && TOPOLOGY.includes('<RiskFindingCard'),
            'the diagram draws a card of its own instead of the one that exists');
  // The row is a button, so the keyboard reaches it and the focus ring says so.
  assert.ok(TOPOLOGY.includes('className="panel-finding-open"') && TOPOLOGY.includes('<button type="button"'),
            'a finding row cannot be opened, or is not a button');
  assert.match(CSS, /\.panel-finding-open\b/, 'the clickable row is unstyled');
  assert.match(CSS, /\.panel-finding-open:focus-visible/, 'the row takes no focus ring');
  assert.match(CSS, /dialog\.policy-dialog\.finding-dialog/, 'the card window has no rule of its own');
  // The fold is opened: a reader who clicked one row has already chosen it, and a window whose
  // whole content is one collapsed summary line asks them to choose it twice.
  assert.ok(TOPOLOGY.includes('defaultOpen'), 'the card opens folded shut');
  // Closed three ways - ESC, the button, a click outside - and only one of them runs a click
  // handler. Without onClose putting the state back, the row that opened it opens nothing next.
  assert.match(TOPOLOGY.slice(TOPOLOGY.indexOf('finding-dialog')), /onClose=\{\(\) => setOpenCard\(null\)\}/,
               'closing the card leaves the state saying it is open');
});

test('the card in the diagram reads, and says so rather than offering a dead button', () => {
  // The 차단 button writes into the restriction set the policy block composes. A live one inside a
  // picture would put the decision form in the wrong window; a dead one would read as "this path
  // cannot be cut", which is what the 차단 불가 badge means and is a different claim.
  assert.ok(TOPOLOGY.includes('block={null}'), 'the diagram offers a block button it cannot honour');
  assert.ok(TOPOLOGY.includes('이 창은 읽기만 한다'),
            'nothing says where the block button is for a reader who came looking for it');
  // The containment badge is TOLD, not guessed. The diagram holds no restrictions, so computing it
  // here would print 차단되지 않음 over a path this very decision has already cut.
  assert.ok(TOPOLOGY.includes('containmentOf ? containmentOf(card)'),
            'the diagram decides containment without the restrictions');
  assert.ok(IMPACT.includes('containmentState(finding, restrictions, protectedActions, fenceGrants)')
            && IMPACT.includes('containmentOf={containmentOf}'),
            'the policy block does not hand the diagram the containment it alone can compute');
});

test('an analysis that found nothing is not drawn as an analysis nobody ran', () => {
  // The same lie as above with a rarer cause. `findings.length > 0` cannot tell 33 rules firing
  // none from 33 rules never being asked, and the panel prints opposite sentences over the two.
  assert.ok(TOPOLOGY.includes('ran={analysed}'),
            'the panel still infers "an analysis ran" from the number of findings');
  assert.ok(IMPACT.includes('anyAnswered(findings)') && IMPACT.includes('analysed={analysed}'),
            'nothing carries whether an analysis answered');
  assert.ok(PANEL.includes('findings: Finding[] | null'),
            'the report cannot say "not answered" apart from "found nothing"');
});

test('the public/private rule the legend states is the default route, and the panel shows the routes', () => {
  const legend = TOPOLOGY.slice(TOPOLOGY.indexOf('topology-legend'));
  assert.ok(legend.includes('기본 경로(0.0.0.0/0 · ::/0)'),
            'the legend does not say the DEFAULT route is what decides public');
  assert.ok(legend.includes('eigw-'), 'the legend does not exclude the egress-only gateway');
  assert.ok(legend.includes('경로 미기록'),
            'the legend does not say an older assessment is answered by the weaker rule');
  assert.ok(legend.includes('서브넷 이름 옆의 라우팅 테이블'),
            'the legend does not explain the table printed on the subnet band');
  // The panel answers it for one table: the pair, and which row is the default route.
  assert.ok(TOPOLOGY.includes('facts.resourceType === "ec2:route-table"'),
            'the panel shows no routes for a route table');
  assert.ok(TOPOLOGY.includes('panel-routes') && TOPOLOGY.includes('panel-route-default'));
  assert.match(CSS, /\.panel-routes\b/, 'the route table in the panel is unstyled');
  assert.match(CSS, /\.panel-route-default\b/, 'the default route is not marked');
  assert.ok(TOPOLOGY.includes('조회기가 경로를 기록하기 전에 만들어진 평가다'),
            'an assessment with no routes is not distinguished from a table with none');
});

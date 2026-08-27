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
                             IMPACT.indexOf('function PolicyInlinePreview('));
  assert.ok(block.length > 0 && block.length < IMPACT.length, 'the slice caught the wrong component');
  assert.ok(block.includes('미리보기'), 'the preview no longer says the writer is the authority');
  assert.ok(block.includes('fenceServices'),
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
  // Its memo takes fenceServices as a dependency. Called inline inside restrictable.map that is a
  // fresh array identity every render, so the memo never hit: each of N policy blocks recomposed
  // the whole document twice - and serialised every statement - on each character typed into a tag
  // field. The value changes only when the assessment does.
  assert.match(IMPACT, /const fenceServices = useMemo\(\s*\(\) => fenceServicesOf\(assessment\.passrole_grants\), \[assessment\.passrole_grants\],\s*\)/,
               'fenceServices is not memoised, so the per-policy memo never caches');
  assert.ok(!/fenceServices=\{fenceServicesOf\(/.test(IMPACT),
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
  assert.ok(gate.includes('restrictDisabled'), 'the button renders after the decision closed');
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
  assert.match(DETAIL, /restrictDisabled=\{busy \|\| decided\}/,
               'the block button outlives the decision');
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

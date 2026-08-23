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

const PICKER = readFileSync(new URL('../src/components/ActionPicker.tsx', import.meta.url), 'utf8');

test('an action that names no resource is offered, not filtered away', () => {
  // It used to be removed from the offering under allow_only. That was the wrong answer to a real
  // constraint: 전체 선택 across EC2 then quietly skipped 257 of its 793 actions, and nothing on
  // the page said which, or why, or that they existed. An approver who ticked everything believed
  // they had covered everything.
  assert.ok(!/intent === "allow_only" && offer\.account_level/.test(PICKER),
            'account-level actions are hidden again, so 전체 선택 skips them in silence');
  assert.ok(PICKER.includes('flatDenyBlock'), 'they have no block of their own');
  assert.ok(PICKER.includes('자원 목록으로 좁힐 수 없는 동작'),
            'the block does not say what these actions are');
  assert.ok(PICKER.includes('자원을 인자로 받지'),
            'the block no longer distinguishes the action that HAS no resource');
  assert.ok(PICKER.includes('평면 거부'),
            'the block does not say that ticking one denies it outright');
});

test('an action that MAKES the resource it names shares that block, with its own sentence', () => {
  // The second way a list of ARNs is no scope, and the one nothing was checking.
  // Deny lambda:CreateFunction NotResource [testLambda, testLambda2] reads as "you may create a
  // function called testLambda or testLambda2", and both already exist.
  assert.ok(PICKER.includes('creates_target'), 'the offer does not carry the answer');
  assert.match(PICKER, /const flatOnly = \(offer: Offer\) =>[\s\S]{0,80}creates_target/,
               'the two reasons are not sharing one test, so only one of them reaches the block');
  // Distinct wording. "자원을 인자로 받지 않는다" beside lambda:CreateFunction is simply false -
  // it does name a resource, and the resource is the one it is about to make.
  assert.ok(PICKER.includes('만드는'), 'the block does not say why these are here');
  assert.ok(PICKER.includes('lambda:CreateFunction'), 'the sentence names no example');
  // And every place that asked "can this be scoped" asks the generalised question.
  for (const site of ['return !flatOnly(offer);', '!flatOnly(o) &&',
                      'flatOnly(e) === accountOnly', 'group.entries.filter(flatOnly)']) {
    assert.ok(PICKER.includes(site), `a scoping decision still reads account_level alone: ${site}`);
  }
});

test('전체 선택 on a service does not sweep in the flat denies', () => {
  // A flat Deny is unconditional and is a different decision from narrowing. Sweeping them in
  // under a button labelled 전체 선택 would make that decision on the administrator's behalf.
  const toggle = PICKER.slice(PICKER.indexOf('const blockToggle ='),
                              PICKER.indexOf('const byLevel ='));
  assert.ok(toggle.includes('!flatOnly(o)'),
            'the service 전체 선택 selects actions a resource list cannot scope');
  // And the flat block has its own.
  const flat = PICKER.slice(PICKER.indexOf('const flatDenyBlock ='),
                            PICKER.indexOf('// The resource button sits OUTSIDE'));
  assert.ok(flat.includes('selectAll(flat'), 'the flat block has no 전체 선택 of its own');
});

test('the editor emits a flat deny for an action that names no resource', () => {
  // Whatever intent the rest are under. Under tag_condition it would be worse than refused: the
  // condition tests a resource tag, an action with no resource has none, so the statement matches
  // nothing and reads on the page as a restriction that is in place.
  const emit = IMPACT.slice(IMPACT.indexOf('const flatOnly ='),
                            IMPACT.indexOf('// Keyed off what the policy GRANTS'));
  assert.ok(emit.includes('flatOnly(choice.action)'),
            'the editor no longer splits by whether a resource list can scope the action');
  assert.match(emit, /intent: "deny_only" as const[\s\S]{0,60}resources: \[\]/,
               'the flat branch no longer emits a flat deny');
  // Both reasons, one branch. The second is the action that makes what it names.
  assert.ok(emit.includes('entry[1].length === 0 || entry[2] === true'),
            'the editor splits on only one of the two reasons');
  // Unknown is neither. An action the reference does not carry must not be guessed at.
  assert.ok(emit.includes(': false'),
            'an action missing from the reference is being treated as flat-only');
});

test('the service wildcard is offered, never applied', () => {
  // The wildcard becomes the administrator's decision and travels as the action. A page that
  // quietly widened [8 names] into athena:* would be restricting actions this approval does not
  // grant, which generator/restriction.py refuses by name - and which after B-1 it can see.
  const offer = IMPACT.slice(IMPACT.indexOf('// The one action this list could be written as'),
                             IMPACT.indexOf('// Estimated, and said so'));
  assert.ok(offer.includes('serviceFold({'), 'the offer no longer asks the shared module');
  assert.ok(offer.includes('<button'), 'the fold is applied without the administrator choosing it');
  assert.ok(offer.includes('folded.adds'), 'what the wildcard additionally denies is not shown');
  // One resource clause only. A mixed set is several statements and folding them together is a
  // different operation from this one.
  assert.ok(offer.includes('one.size !== 1'),
            'the offer no longer requires a single resource clause');
  assert.ok(offer.includes('intent === "tag_condition"'),
            'a tag condition is being offered a wildcard, where the members carry no tag');
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
  assert.ok(PICKER.includes('disabled={dead}'), 'the checkbox is still tickable');
  assert.ok(PICKER.includes('닿는 자원 없음'), 'the row does not say why it is disabled');
  assert.match(CSS, /\.pick-item\.dead\b/, 'a disabled row looks the same as an enabled one');
});

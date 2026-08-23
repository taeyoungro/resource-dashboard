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
                             IMPACT.indexOf('function PolicyInlinePreview('));
  assert.ok(block.length > 0 && block.length < IMPACT.length, 'the slice caught the wrong component');
  assert.ok(block.includes('미리보기'), 'the preview no longer says the writer is the authority');
  assert.ok(block.includes('fenceServices'),
            'the fence is not in the preview, so the deployed document would have a statement the '
            + 'approver never saw');
  assert.ok(block.includes('INLINE_LIMIT'), 'the quota is not shown beside the size');
});

const PICKER = readFileSync(new URL('../src/components/ActionPicker.tsx', import.meta.url), 'utf8');

test('the four sections compose - a policy is not one intent at a time', () => {
  // It was one dropdown, so a policy carried exactly one intent and choosing a second meant giving
  // up the first. That was never a property of the statements: the permission set holds ONE inline
  // document and each decision composes its own statement into it, so "이 버킷만 남기고, 그리고
  // DeleteBucket은 아예 막는다" is two statements and always was.
  assert.ok(!/<select[\s\S]{0,200}INTENT_LABEL/.test(IMPACT),
            'the intent is a dropdown again, so the sections are mutually exclusive');
  assert.match(IMPACT, /const SECTIONS: Restriction\["intent"\]\[\] = \[\s*"allow_only", "deny_only", "deny_action", "tag_condition",/,
               'the four sections are not declared as a list the editor renders one block per');
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
  assert.ok(IMPACT.includes('deny_action: "동작 자체 거부"'), 'the section has no name');
  // The scoped sections do not offer them at all. offeringFor is what removes them.
  assert.match(IMPACT, /const offeringFor = \(intent: Restriction\["intent"\]\) => \{[\s\S]{0,200}if \(intent === "deny_action"\) return \{ offering: covered, hidden: 0 \}/,
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
  const seed = IMPACT.slice(IMPACT.indexOf('const [draft, setDraft] = useState<Draft>'),
                            IMPACT.indexOf('const tagSeed ='));
  assert.match(seed, /flatOnly\(action\) \? "deny_action" : restriction\.intent/,
               'a stored flat deny is seeded into the intent it was written under');
  assert.ok(seed.includes('into === "deny_action" ? []'),
            'resources ride along into a section whose statement has no resource clause');
  // Both reasons, one test. The second is the action that makes what it names.
  const flat = IMPACT.slice(IMPACT.indexOf('const flatOnly = (action: string)'),
                            IMPACT.indexOf('const [draft, setDraft]'));
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
  assert.match(IMPACT, /const isScoped = \(intent: Restriction\["intent"\]\) =>\s*intent === "allow_only" \|\| intent === "deny_only";/,
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
                             IMPACT.indexOf('const SECTIONS'));
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
                             IMPACT.indexOf('const SECTIONS'));
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
                             IMPACT.indexOf('const SECTIONS'));
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
                             IMPACT.indexOf('const SECTIONS'));
  assert.ok(block.includes('Sid'), 'nothing explains why the Sid numbers have gaps');
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

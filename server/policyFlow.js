// 정책 하나가 내주는 공격 흐름: 무엇을 하는지, 어떤 차례로, 어디에 도달하는지.
//
// 이 그림은 카드의 목차가 아니다
// ---------------------------
// 처음 판본은 규칙마다 판 하나를 세우고 그 판에 규칙의 이름과 아이디만 적었다. 그러면 그림이
// 말하는 것은 「이 정책에 카드 셋이 있고 그중 둘이 이어진다」뿐이고, 무엇이 일어나는지는 판을
// 눌러 카드를 열어야 나왔다. 그림이 목차이면 그림을 볼 이유가 없다.
//
// 그래서 판이 셋을 든다. 이름(stepLabel), 무엇을 하는가(stepStory), 그리고 그 단계가 지금 결정에서
// 끊겼는지. 셋 다 규칙 파일과 카드가 이미 가진 것이고 이 파일이 지어내는 것은 하나도 없다 - 이야기
// 한 줄은 그 규칙의 narrative 에서 온 말이라 사람이 적고 검사기가 폭을 확인한다.
//
// 흐름에는 끝이 있다
// ----------------
// 마지막 판 뒤에 도착 판이 선다. 도착의 낱말은 server/candidatePaths.js 의 OUTCOME 이 정하는 닫힌
// 목록이고, 한국어 표기는 규칙 파일이 준다. 끝이 없으면 그림은 마지막 단계에서 그냥 멈추고, 읽는
// 사람은 이 경로가 무엇을 이루는지 알 수 없다 - 그것이 승인이 대답해야 하는 물음이다.
// rules.js 가 「enables 의 끝인 규칙에는 outcome 이 있어야 한다」를 적재 때 강제한다.
//
// 시작 판이 없는 이유
// -----------------
// 첫 판본에는 「이 부여」 판이 있었다. 정책 이름은 그림 위 캡션에 이미 있고, 그 판은 자리만 차지하고
// 아무것도 말하지 않았다 - 280px 을 돌려받아 단계 판을 키우는 편이 낫다. 흐름은 첫 열에서 시작한다.
//
// 개수는 여기서도 그리지 않는다. FindingTarget.count 는 파이프라인 자원을 이미 뺀 수이고, truncated
// 가 true 면 하한이며, scope 가 '*' 가 아니면 정책이 지목한 목록이다. 자격이 필요한 수를 자격 없이
// 옮기지 않는 유일한 방법은 그 수를 옮기지 않는 것이다.
//
//     node --test server/policyFlow.test.js

// 판의 글자를 재는 자. 구성도가 판 이름을 자를 때 쓰는 그것이고, 여기서 다시 구현하지 않는다 -
// 두 번 구현한 자는 언젠가 서로 다른 답을 낸다.
import { textUnits } from './topology.js';

/** 단계 판. 이름 한 줄, 이야기 두 줄, 각주 한 줄이 들어간다. */
export const STEP_W = 240;
export const STEP_H = 92;
/** 도착 판. 단계가 아니므로 좁고, 번호도 각주도 없다. */
export const OUT_W = 200;
/** 판 사이 가로 여백. 꺾이는 선이 여백 한가운데서 만나려면 넉넉해야 한다. */
export const PLATE_GAP = 40;
/** 한 열에 판이 여럿일 때의 세로 여백. */
export const PLATE_VGAP = 14;
/** 흐름 하나와 다음 흐름 사이. 한 정책에 흐름이 둘일 수 있다. */
export const FLOW_GAP = 24;
export const FLOW_FOOT = '왼쪽에서 오른쪽이 차례입니다 — 규칙 파일이 방향을 말한 것만 그립니다.';
const FOOT_H = 20;

/** 등급의 차례. 칩을 무거운 것부터 세우기 위한 것이고 정렬 키는 이것 하나다(T-7). */
const GRADE_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];

/**
 * 글자 한 단위가 몇 픽셀인가. topology.js 의 자가 11px 에서 112px = 10.1 단위로 잰 값이다.
 *
 * 크기마다 다시 재는 것이 요점이다 - 라벨은 14px, 이야기는 12px, 각주는 11px 이라 같은 단위 수가
 * 세 가지 폭이 된다. rules.js 의 stepStory 상한이 이 셈에서 나온다.
 */
const PX = (size) => (112 / 10.1) * (size / 11);
const STORY_UNITS = (STEP_W - 32) / PX(12);
/** 도착 판의 낱말이 한 줄에 담기는 폭. 두 줄까지 쓴다. */
export const ARRIVAL_UNITS = (OUT_W - 32) / PX(14);

const colX = (column) => column * (STEP_W + PLATE_GAP);

/**
 * 이야기를 판 안에서 줄로 나눈다. SVG 는 스스로 줄바꿈하지 않는다.
 *
 * 낱말 단위로 자르고 두 줄까지만 쓴다. 두 줄에 안 들어가는 것은 여기서 버려지는데, 그것이 일어나면
 * 뜻이 달라진 문장이 화면에 남는다 - 그래서 rules.js 가 폭을 적재 때 확인하고, 이 함수는 그 확인을
 * 통과한 값만 받는다는 전제로 단순하다.
 */
export function wrapStory(text, budget = STORY_UNITS, lines = 2) {
  const words = String(text ?? '').split(' ').filter(Boolean);
  const out = [];
  let at = '';
  for (const word of words) {
    const next = at ? `${at} ${word}` : word;
    if (textUnits(next) <= budget || !at) {
      at = next;
    } else {
      out.push(at);
      at = word;
      if (out.length === lines) return out;
    }
  }
  if (at && out.length < lines) out.push(at);
  return out;
}

/** 열에 놓인 판들의 y. 열의 세로 중심을 그 흐름의 등뼈에 맞춘다. */
function rowYs(count, spine, height) {
  const total = count * height + (count - 1) * PLATE_VGAP;
  const top = spine - total / 2;
  return Array.from({ length: count }, (_, i) => top + i * (height + PLATE_VGAP));
}

/**
 * 두 판을 잇는 꺾은선. 높이가 같으면 두 점, 다르면 네 점.
 *
 * 꺾이는 x 가 두 판 사이 여백의 한가운데이므로, 한 곳으로 모이는 선 여럿이 같은 세로줄에서 만난다 -
 * 그것이 모임으로 읽히는 이유다.
 */
function elbow(key, from, to) {
  const x1 = from.x + from.w;
  const x2 = to.x;
  if (from.midY === to.midY) return { key, points: [[x1, from.midY], [x2, to.midY]] };
  const bend = x1 + (x2 - x1) / 2;
  return { key, points: [[x1, from.midY], [bend, from.midY], [bend, to.midY], [x2, to.midY]] };
}

/**
 * 한 정책의 판정들에서 흐름의 연결 성분을 추린다.
 *
 * 판정마다 chain 이 붙어 있고 그 값은 「이 규칙이 속한 성분」이므로, 같은 성분이 그 성분의 단계
 * 수만큼 반복된다. 단계 아이디의 집합으로 접어서 하나로 만든다 - 축이 둘인 규칙은 판정이 둘이고
 * 성분은 같으므로, 접지 않으면 같은 흐름을 두 번 그린다.
 */
function componentsOf(findings) {
  const out = new Map();
  for (const finding of findings) {
    const chain = finding.chain;
    if (!chain || !Array.isArray(chain.steps) || chain.steps.length < 2) continue;
    const key = chain.steps.map((s) => s.id).sort().join('|');
    if (out.has(key)) continue;
    out.set(key, chain);
  }
  return [...out.values()];
}

/**
 * 규칙 아이디마다 그 카드들이 말하는 것.
 *
 * 한 규칙이 축 둘에 걸치면 판정이 둘이고 판은 하나다. 등급과 제목은 규칙의 것이라 둘이 같고, 축은
 * 모아 둔다. 차단 상태는 둘 중 **덜 막힌 쪽**을 쓴다 - 한쪽 축이 열려 있으면 그 경로는 열려 있고,
 * 더 막힌 쪽을 적으면 그림이 실제보다 안전하다고 말한다.
 */
const OPENNESS = { none: 0, partial: 1, fenced: 2, full: 3 };
function byRule(findings, containmentOf) {
  const out = new Map();
  for (const finding of findings) {
    if (!out.has(finding.id)) {
      out.set(finding.id, { id: finding.id, title: finding.title,
                            grade: finding.escalationGrade, axes: [], contained: null });
    }
    const at = out.get(finding.id);
    if (!at.axes.includes(finding.axis)) at.axes.push(finding.axis);
    const state = containmentOf ? containmentOf(finding) : null;
    if (state && (at.contained === null || OPENNESS[state] < OPENNESS[at.contained])) {
      at.contained = state;
    }
  }
  for (const at of out.values()) at.axes.sort();
  return out;
}

function stepPlate(over) {
  const { x, y, story } = over;
  return {
    w: STEP_W,
    h: STEP_H,
    labelY: y + 24,
    // 이야기가 한 줄이면 판의 세로 가운데로 내려온다. 두 줄이면 위에서부터 쌓인다.
    storyY: story.length > 1 ? [y + 46, y + 63] : [y + 50],
    noteY: y + 82,
    midY: y + STEP_H / 2,
    ...over,
  };
}

/**
 * 정책 하나의 흐름 그림. 그릴 흐름이 하나도 없으면 null.
 *
 * findings 는 한 정책의 판정 전부다 - 축 둘, 구역 여섯에 걸친 것을 그대로 넘긴다. 흐름에 드는 것은
 * 그중 일부이고 나머지는 칩이 되므로, 이 함수가 둘을 가르려면 전부를 봐야 한다.
 *
 * words 는 화면의 낱말표와 지금의 결정을 받는다 - 등급의 한국어는 화면에 한 벌뿐이어야 하고, 차단
 * 여부는 작성 중인 결정에 달린 것이라 순수 함수가 알 수 없다. 도착의 한국어는 여기 없다: 그것은
 * chain 이 값과 함께 싣고 온다.
 */
export function policyFlow(findings, words = {}) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return null;
  const components = componentsOf(list);
  if (components.length === 0) return null;

  const grade = (value) => words.grade?.[value] ?? value ?? '';
  const rules = byRule(list, words.containmentOf);
  const policyName = list[0].policyName ?? '';
  const policyId = list[0].policyId ?? '';

  const plates = [];
  const lines = [];
  let widest = 0;
  let y = 0;

  components.forEach((chain, index) => {
    const columns = Math.max(...chain.steps.map((s) => s.column)) + 1;
    const stacked = Math.max(...Array.from({ length: columns },
      (_, c) => chain.steps.filter((s) => s.column === c).length));
    const band = stacked * STEP_H + (stacked - 1) * PLATE_VGAP;
    const spine = y + band / 2;
    // 번호는 열 안에서가 아니라 열을 가로질러 매긴다. 같은 열의 둘은 차례가 없으므로 같은 번호를
    // 나눠 갖는다 - ①이 둘이면 「둘 중 어느 쪽이든」이라는 뜻이고, 그것이 사실이다.
    const number = (column) => '①②③④⑤⑥'[column] ?? `${column + 1}`;

    const here = new Map();
    for (let c = 0; c < columns; c += 1) {
      const column = chain.steps.filter((s) => s.column === c);
      const ys = rowYs(column.length, spine, STEP_H);
      column.forEach((it, i) => {
        const rule = rules.get(it.id) ?? { title: '', grade: null, axes: [], contained: null };
        const story = wrapStory(it.story ?? '');
        const made = stepPlate({
          key: `${index}:${it.id}`,
          kind: 'step',
          ruleId: it.id,
          number: number(c),
          label: it.label,
          story,
          // 아이디와 등급, 그리고 지금 결정이 이 단계를 끊었는지. 대상의 수는 카드가 말한다.
          note: `${it.id} · ${grade(rule.grade)}`,
          grade: rule.grade,
          contained: rule.contained,
          axes: rule.axes,
          x: colX(c),
          y: ys[i],
          title: `${it.id} ${rule.title}`,
        });
        plates.push(made);
        here.set(it.id, made);
      });
    }

    // 선은 파일이 말한 방향만. 열의 곱집합으로 그리면 서로를 성립시키지 않는 두 판 사이에 방향이
    // 생긴다 - 이 그림에서 실제로 일어나는 일이고, 그래서 chain.edges 만 읽는다.
    for (const edge of chain.edges ?? []) {
      const from = here.get(edge.from);
      const to = here.get(edge.to);
      if (from && to) lines.push(elbow(`${index}:${edge.from}-${edge.to}`, from, to));
    }

    // 도착. 나가는 간선이 없는 단계마다 하나씩 - 흐름이 두 곳에서 끝나면 도착도 둘이다.
    const outgoing = new Set((chain.edges ?? []).map((e) => e.from));
    const sinks = chain.steps.filter((s) => !outgoing.has(s.id));
    const sinkYs = rowYs(sinks.length, spine, STEP_H);
    sinks.forEach((sink, i) => {
      const at = sink.outcome;
      if (!at) return;
      // 낱말을 판 안에서 줄로 나눈다. 단계의 이야기와 같은 셈이고 자도 같다 - 「계정 밖으로 데이터
      // 반출」은 한 줄에 11.2 단위이고 판이 11.9 를 들므로 여유가 거의 없다.
      const label = sink.outcomeLabel ?? at;
      const said = wrapStory(label, ARRIVAL_UNITS);
      const arrived = {
        key: `${index}:out:${sink.id}`,
        kind: 'outcome',
        ruleId: null,
        number: '',
        // 판에 그려지는 것은 story 의 줄들이다. label 은 요약과 덧말이 쓰는 온전한 한 줄.
        label,
        story: said,
        // 이것이 단계가 아니라 도착이라는 것. 없으면 마지막 단계가 하나 더 있는 것으로 읽힌다.
        note: '도달',
        grade: null,
        contained: null,
        x: colX(columns),
        y: sinkYs[i],
        w: OUT_W,
        h: STEP_H,
        labelY: sinkYs[i] + 24,
        storyY: said.length > 1 ? [sinkYs[i] + 50, sinkYs[i] + 70] : [sinkYs[i] + 58],
        noteY: sinkYs[i] + 24,
        midY: sinkYs[i] + STEP_H / 2,
        title: `이 흐름이 도달하는 곳 — ${label}`,
      };
      plates.push(arrived);
      const from = here.get(sink.id);
      if (from) lines.push(elbow(`${index}:${sink.id}-out`, from, arrived));
    });

    const rightmost = Math.max(...plates.filter((p) => p.key.startsWith(`${index}:`))
      .map((p) => p.x + p.w));
    widest = Math.max(widest, rightmost);
    y += band + (index === components.length - 1 ? 0 : FLOW_GAP);
  });

  // 흐름에 들지 않은 규칙. 판이 아니라 칩인 것이 요점이다 - 선이 닿지 않는 판은 무언가의 단계로
  // 읽히고, 이것들은 단계가 아니라 이 정책이 함께 내주는 다른 능력이다.
  const inFlow = new Set(plates.filter((p) => p.ruleId).map((p) => p.ruleId));
  const chips = [...rules.values()]
    .filter((rule) => !inFlow.has(rule.id))
    .sort((a, b) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade)
      || a.id.localeCompare(b.id))
    .map((rule) => ({ ruleId: rule.id, label: rule.title, grade: rule.grade, axes: rule.axes,
                      contained: rule.contained, title: `${rule.id} ${rule.title}` }));

  const told = components.map((chain, index) => {
    const columns = new Map();
    for (const it of [...chain.steps].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!columns.has(it.column)) columns.set(it.column, []);
      columns.get(it.column).push(it.story ? `${it.label}(${it.story})` : it.label);
    }
    const order = [...columns.entries()].sort((a, b) => a[0] - b[0])
      .map(([, names]) => names.join(', ')).join(' → ');
    const ends = plates.filter((p) => p.kind === 'outcome' && p.key.startsWith(`${index}:`))
      .map((p) => p.label);
    return `${order}${ends.length ? ` → 도달: ${ends.join(', ')}` : ''}.`;
  });
  const open = plates.filter((p) => p.kind === 'step' && p.contained === 'none').length;
  const steps = plates.filter((p) => p.kind === 'step').length;
  const omitted = components.reduce((n, c) => n + (c.omittedSteps ?? 0), 0);
  const summary = [
    `${policyName} 의 흐름 ${components.length}개.`,
    ...told.map((line, i) => `${components.length > 1 ? `${i + 1}. ` : ''}${line}`),
    words.containmentOf ? `단계 ${steps}개 중 ${open}개가 아직 차단되지 않았습니다.` : null,
    omitted > 0 ? `그림 폭에 담지 못한 단계 ${omitted}개가 더 있습니다.` : null,
    chips.length > 0 ? `차례가 확립되지 않은 채 같은 정책에서 발화한 규칙 ${chips.length}건.` : null,
    FLOW_FOOT,
  ].filter(Boolean).join(' ');

  return {
    policyId,
    policyName,
    width: widest,
    height: y + FOOT_H,
    footY: y + FOOT_H - 5,
    foot: FLOW_FOOT,
    flows: components.length,
    steps,
    /** 아직 차단되지 않은 단계의 수. 낱말표에 containmentOf 가 없으면 null. */
    openSteps: words.containmentOf ? open : null,
    omittedSteps: omitted,
    plates,
    lines,
    chips,
    summary,
  };
}

/**
 * 화면에 그릴 정책들의 흐름, 판정 전부에서.
 *
 * 정책마다 하나씩이고, 흐름이 없는 정책은 나오지 않는다. 차례는 정책 이름순이 아니라 처음 나온
 * 순서다 - 판정 목록이 이미 등급으로 정렬되어 있으므로, 그 순서를 따르면 무거운 정책이 위에 선다.
 */
export function policyFlows(findings, words = {}) {
  const byPolicy = new Map();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const key = finding.policyId ?? finding.policyName ?? '';
    if (!byPolicy.has(key)) byPolicy.set(key, []);
    byPolicy.get(key).push(finding);
  }
  return [...byPolicy.values()].map((of) => policyFlow(of, words)).filter(Boolean);
}

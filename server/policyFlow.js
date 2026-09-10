// 정책 하나가 그리는 흐름 그림: 차례가 확립된 단계들과, 그 흐름에 들지 않은 나머지.
//
// findingPath.js 와 무엇이 다른가
// -----------------------------
// 그쪽은 카드 하나의 그림이고 이쪽은 정책 하나의 그림이다. 흐름은 카드의 성질이 아니라 정책의
// 성질이어서 - V-2 가 X-6 을 성립시킨다는 것은 그 둘이 한 정책에 함께 있다는 사실에 대한 진술이다 -
// 카드마다 그리면 같은 그림이 카드 수만큼 반복되고, 어느 카드에도 「이 정책의 흐름은 하나」라고
// 말하는 자리가 없다.
//
// 반복만이 문제가 아니었다. 흐름은 카드 목록의 구역을 거꾸로 가로지른다: V-2 는 EVASION 이고 X-6 은
// EXPOSURE 여서 먼저 일어나는 것이 뒤 구역에 있고, R-1(RECON) 과 E-1(ESCALATION) 은 세 구역
// 떨어져 있다. 구역은 승인자가 침해와 비용을 따로 읽기 위해 있는 것이라 목록 순서를 바꿔서 고칠 수
// 없다. 그래서 구역 위에 서는 그림이 필요하고, 이 파일이 그 그림을 정한다.
//
// 자원 판이 없는 이유
// ------------------
// findingPath.js 의 그림은 「부여 → 동작 → 자원」이라 끝에 자원 판이 선다. 여기서는 단계마다 자기
// 대상이 따로 있으므로 끝에 판 하나를 두면 그 수가 어느 단계의 것인지 말할 수 없다. 그래서 대상은
// 판 하나로 모으지 않고 각 단계의 덧말에 둔다.
//
// 개수는 여기서도 그리지 않는다. 덧말이 대는 것은 규칙 아이디와 등급뿐이고, 자원의 수와 표본과
// 제외한 자원은 카드가 말한다 - 자격이 필요한 수를 자격 없이 옮기지 않는 유일한 방법은 그 수를
// 옮기지 않는 것이다.
//
//     node --test server/policyFlow.test.js

/** 단계 판. 카드 본문이 14px 이므로 낱말이 그보다 작아지지 않는 크기다. */
export const PLATE_W = 176;
export const PLATE_H = 56;
/** 판 사이 가로 여백. 꺾이는 선이 여백 한가운데서 만나려면 넉넉해야 한다. */
export const PLATE_GAP = 48;
/** 한 열에 판이 여럿일 때의 세로 여백. */
export const PLATE_VGAP = 12;
/** 흐름 하나와 다음 흐름 사이. 한 정책에 흐름이 둘일 수 있다. */
export const FLOW_GAP = 20;
/** 등급 띠의 폭. 판 왼쪽에 세로로 서고, 카드 왼쪽 테두리와 같은 것을 말한다. */
export const GRADE_BAR = 4;
export const FLOW_FOOT = '왼쪽에서 오른쪽이 차례입니다 — 규칙 파일이 방향을 말한 것만 그립니다.';
const FOOT_H = 18;

/** 등급의 차례. 칩을 무거운 것부터 세우기 위한 것이고 정렬 키는 이것 하나다(T-7). */
const GRADE_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];

const colX = (column) => column * (PLATE_W + PLATE_GAP);

/** 열에 놓인 판들의 y. 열의 세로 중심을 그 흐름의 등뼈에 맞춘다. */
function rowYs(count, spine) {
  const total = count * PLATE_H + (count - 1) * PLATE_VGAP;
  const top = spine - total / 2;
  return Array.from({ length: count }, (_, i) => top + i * (PLATE_H + PLATE_VGAP));
}

/**
 * 두 판을 잇는 꺾은선. 높이가 같으면 두 점, 다르면 네 점.
 *
 * 꺾이는 x 가 두 판 사이 여백의 한가운데이므로, 한 곳으로 모이는 선 여럿이 같은 세로줄에서 만난다 -
 * 그것이 모임으로 읽히는 이유다. findingPath.js 의 같은 이름 함수와 같은 셈이고, 두 그림이 같은
 * 어법으로 이어짐을 말해야 하므로 모양도 같다.
 */
function elbow(key, from, to) {
  const x1 = from.x + from.w;
  const x2 = to.x;
  if (from.midY === to.midY) return { key, points: [[x1, from.midY], [x2, to.midY]] };
  const bend = x1 + (x2 - x1) / 2;
  return { key, points: [[x1, from.midY], [bend, from.midY], [bend, to.midY], [x2, to.midY]] };
}

function plate(over) {
  const { x, y, sub } = over;
  return {
    w: PLATE_W,
    h: PLATE_H,
    labelY: y + (sub ? 24 : 33),
    subY: y + 42,
    midY: y + PLATE_H / 2,
    ...over,
  };
}

/**
 * 한 정책의 판정들에서 흐름의 연결 성분을 추린다.
 *
 * 판정마다 chain 이 붙어 있고 그 값은 「이 규칙이 속한 성분」이므로, 같은 성분이 그 성분의 단계 수만큼
 * 반복된다. 단계 아이디의 집합으로 접어서 하나로 만든다 - 축이 둘인 규칙은 판정이 둘이고 성분은
 * 같으므로, 접지 않으면 같은 흐름을 두 번 그린다.
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
 * 규칙 아이디마다 그 카드가 말하는 것 - 제목, 등급, 축.
 *
 * 한 규칙이 축 둘에 걸치면 판정이 둘이고 판은 하나다. 등급과 제목은 규칙의 것이라 둘이 같고, 다른
 * 것은 어느 질문에 답하느냐뿐이므로 축은 모아 둔다: 판을 누르면 그 규칙의 카드를 전부 연다.
 */
function byRule(findings) {
  const out = new Map();
  for (const finding of findings) {
    if (!out.has(finding.id)) {
      out.set(finding.id, { id: finding.id, title: finding.title,
                            grade: finding.escalationGrade, axes: [] });
    }
    const at = out.get(finding.id);
    if (!at.axes.includes(finding.axis)) at.axes.push(finding.axis);
  }
  for (const at of out.values()) at.axes.sort();
  return out;
}

/**
 * 정책 하나의 흐름 그림. 그릴 흐름이 하나도 없으면 null.
 *
 * findings 는 한 정책의 판정 전부다 - 축 둘, 구역 여섯에 걸친 것을 그대로 넘긴다. 흐름에 드는 것은
 * 그중 일부이고 나머지는 칩이 되므로, 이 함수가 둘을 가르려면 전부를 봐야 한다.
 */
export function policyFlow(findings, words = {}) {
  const list = Array.isArray(findings) ? findings : [];
  // 등급의 한국어 낱말은 화면에 한 벌뿐이어야 한다 - findingPath.js 가 차단 상태의 낱말을 받아 오는
  // 것과 같은 이유다. 여기에 두 번째 벌을 두면 언젠가 배지와 그림이 다른 말을 한다.
  const grade = (value) => words[value] ?? value ?? '';
  if (list.length === 0) return null;
  const components = componentsOf(list);
  if (components.length === 0) return null;

  const rules = byRule(list);
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
    const band = stacked * PLATE_H + (stacked - 1) * PLATE_VGAP;
    const spine = y + band / 2;

    // 정책 판. 흐름마다 하나씩 서는 것은 흐름이 둘이면 시작이 둘이기 때문이 아니라, 선이 어디서
    // 나오는지가 그림마다 있어야 하기 때문이다. 같은 정책을 두 번 쓰는 것이 그 값이다.
    const origin = plate({
      key: `p${index}`,
      kind: 'policy',
      ruleId: null,
      label: '이 부여',
      sub: components.length > 1 ? `흐름 ${index + 1}/${components.length}` : '',
      grade: null,
      x: colX(0),
      y: spine - PLATE_H / 2,
      title: policyName,
    });
    plates.push(origin);

    const here = new Map();
    for (let c = 0; c < columns; c += 1) {
      const column = chain.steps.filter((s) => s.column === c);
      const ys = rowYs(column.length, spine);
      column.forEach((step, i) => {
        const rule = rules.get(step.id) ?? { title: '', grade: null, axes: [] };
        const made = plate({
          key: `${index}:${step.id}`,
          kind: 'step',
          ruleId: step.id,
          label: step.label,
          // 아이디와 등급만. 대상의 수는 카드가 말한다.
          sub: `${step.id} · ${grade(rule.grade)}`,
          grade: rule.grade,
          axes: rule.axes,
          x: colX(c + 1),
          y: ys[i],
          title: `${step.id} ${rule.title}`,
        });
        plates.push(made);
        here.set(step.id, made);
      });
    }

    // 정책은 첫 열의 모두에게, 단계 사이는 파일이 말한 방향만. 열의 곱집합으로 그리면 파일이 말하지
    // 않은 방향을 지어내게 된다 - findingPath.js 가 같은 이유로 chain.edges 만 읽는다.
    for (const step of chain.steps.filter((s) => s.column === 0)) {
      const to = here.get(step.id);
      if (to) lines.push(elbow(`${index}:origin-${step.id}`, origin, to));
    }
    for (const edge of chain.edges ?? []) {
      const from = here.get(edge.from);
      const to = here.get(edge.to);
      if (from && to) lines.push(elbow(`${index}:${edge.from}-${edge.to}`, from, to));
    }

    widest = Math.max(widest, colX(columns + 1) - PLATE_GAP);
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
                      title: `${rule.id} ${rule.title}` }));

  const order = components.map((chain) => {
    const columns = new Map();
    for (const step of [...chain.steps].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!columns.has(step.column)) columns.set(step.column, []);
      columns.get(step.column).push(step.label);
    }
    return [...columns.entries()].sort((a, b) => a[0] - b[0])
      .map(([, names]) => names.join(', ')).join(' → ');
  });
  const omitted = components.reduce((n, c) => n + (c.omittedSteps ?? 0), 0);
  const summary = [
    `${policyName} 의 흐름 ${components.length}개.`,
    ...order.map((line, i) => `${components.length > 1 ? `${i + 1}. ` : ''}${line}.`),
    omitted > 0 ? `그림 폭에 담지 못한 단계 ${omitted}개가 더 있습니다.` : null,
    chips.length > 0 ? `차례가 확립되지 않은 채 같은 정책에서 발화한 규칙 ${chips.length}건.` : null,
    FLOW_FOOT,
  ].filter(Boolean).join(' ');

  return {
    policyId,
    policyName,
    width: widest,
    height: y + FOOT_H,
    footY: y + FOOT_H - 4,
    foot: FLOW_FOOT,
    flows: components.length,
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

// 발견 하나의 경로 그림: 고리 셋의 좌표와 낱말, 그리고 지금 결정이 끊은 자리.
//
// THIS MODULE DECIDES EVERYTHING THE PICTURE SHOWS. src/components/RiskAnalysis.tsx 는 받은 것을
// 그리기만 한다 - Topology.tsx 가 server/topology.js 에 대해 지키는 그 분업이고 이유도 같다:
// 판이 제 자리를 벗어나는지, 고리가 몇 개인지는 원본 문자열 시험이 잡지 못하고 단위 시험이 잡는다.
//
// 고리는 언제나 셋이다 - 부여, 동작, 자원. 셋은 카드의 뼈대이지 발견의 값이 아니므로, 동작이 마흔
// 개여도 대상이 열 줄이어도 그림의 모양이 변하지 않는다. 발화 동작은 순서가 아니라 술어여서 값마다
// 고리를 하나씩 내주면 데이터에 없는 차례를 그리게 되고, 그래서 이 파일이 만드는 어떤 문자열에도
// 동작 이름이 들어가지 않는다. 필수 동작도 마찬가지다 - requiredActions 는 규칙 판정에만 있고
// (server/riskAnalysis.js 의 findingOf 는 그 필드를 만들지 않는다) 어느 쪽이든 카드의 「발화 동작」
// 줄이 required 칩으로 이미 말한다.
//
// 개수도 그리지 않는다. FindingTarget.count 는 파이프라인 자원을 이미 뺀 수이고(riskDigest.js),
// truncated 가 true 면 하한이며, scope 가 '*' 가 아니면 정책이 지목한 목록이다. 카드가 그 수 옆에
// 「· 파이프라인 자원 N개 제외」와 「(정책이 지목한 자원)」과 잘림 경고를 반드시 붙이는 이유가
// 그것이고, 자격이 필요한 수를 자격 없이 옮기지 않는 유일한 방법은 그 수를 옮기지 않는 것이다.
// 이 그림이 대는 수는 둘뿐이고 둘 다 카드에 대응 줄이 있다.
//
//     node --test server/findingPath.test.js

/** 고리 하나의 폭. 가장 긴 덧말 「12종 · 미확인」이 10px 에서 65px 이고 안쪽 폭은 72px 이다. */
export const LINK_W = 88;
export const LINK_H = 28;
export const GAP = 32;
/** 328. 이 배치가 만드는 가장 좁은 카드 안쪽 폭보다 작아서, 감싸개의 스크롤은 안전망으로만 남는다. */
export const PATH_W = LINK_W * 3 + GAP * 2;
export const PATH_H = 46;
export const LINE_Y = 14;
export const FOOT_Y = 42;
/**
 * 이 그림이 시간으로 읽히는 것을 막는 한 줄.
 *
 * viewBox 안에 그린다 - 구성도가 캡션을 안에 두는 이유와 같다. 화면을 찍어 붙이면 그림만 남고
 * 그림 밖의 문장은 남지 않는다.
 */
export const PATH_FOOT = '왼쪽에서 오른쪽은 도달이고 동작의 차례가 아닙니다.';

const X = [0, LINK_W + GAP, 2 * (LINK_W + GAP)];

/**
 * 끊긴 자리의 모양. 조여진 것과 끊긴 것은 색이 아니라 모양으로 갈린다.
 *
 * 'partial' 이 막대가 아니라 고리인 것이 이 표의 요점이다. 「일부 차단됨」은 오늘 있는 ARN 목록이나
 * 누가 고를 수 있는 태그 값에 조건부인 제한이므로 경로를 닫지 않는다. 막대를 그리면 닫혔다고 말하는
 * 것이고, 아무것도 그리지 않으면 아무도 손대지 않았다고 말하는 것이다.
 */
const MARK = { full: 'cut', fenced: 'cut', partial: 'clamp', none: null };

function link(id, column, label, sub, state, title, dim) {
  return {
    id,
    label,
    sub,
    state,
    title,
    dim,
    x: X[column],
    y: 0,
    w: LINK_W,
    h: LINK_H,
    // 덧말이 없으면 라벨이 판의 세로 한가운데로 내려온다.
    labelY: sub ? 12 : 18,
    subY: 23,
  };
}

/**
 * 발견 하나의 경로, 좌표까지 전부. 그릴 것이 없으면 null.
 *
 * words 는 CONTAINMENT[containment] 를 그대로 받는다. 네 상태의 한국어 낱말은 화면에 한 벌뿐이어야
 * 하고, 여기에 두 번째 벌을 두면 언젠가 배지와 그림이 다른 말을 한다.
 */
export function findingPath(finding, containment, words) {
  const triggers = finding?.triggerActions ?? [];
  // 발화 동작이 없는 판정에는 그릴 경로가 없다. 규칙 평가가 예외로 끝난 판정이 그 모양이고
  // (server/findings.js 의 catch 경로 - axis 는 그대로 두고 triggerActions·targets 를 비운다),
  // 그 카드에는 「평가 불가인 이유」가 이미 문장으로 있다. 아무것도 확인되지 않은 자리에 성립한
  // 경로를 그리는 것이 이 그림이 할 수 있는 가장 큰 거짓말이다.
  if (triggers.length === 0) return null;

  const targets = Array.isArray(finding.targets) ? finding.targets : [];
  const noTargets = targets.length === 0;
  const actionAxis = finding.axis === 'action';

  // 열거에 대한 의심은 열거를 한 판정에만 붙인다 - 카드가 같은 조건으로 경고 줄을 억제하는 이유와
  // 같다. 동작 축은 자원 목록을 만들지 않으므로 짧을 목록 자체가 없고, 여기에 미확인을 띄우면
  // 하지도 않은 주장에 대한 의심을 지어내는 것이 된다.
  const enumerationOpen = !actionAxis && finding.truncated !== false;
  // 모델 판정의 target 에는 status 가 없다 - server/riskAnalysis.js 의 findingOf 는 type·count·
  // scope·sample·sampleComplete·controlPlane 여섯만 만든다. 없는 것을 미확인으로 읽으면 근거가
  // 확정된 판정 위에 의심을 그리게 되므로, 있는 것만 본다.
  const typeOpen = targets.some((t) => typeof t?.status === 'string' && t.status !== 'CONFIRMED');

  // 자격 문장. 카드가 이미 쓰는 두 문장을 그대로 쓴다 - 잘린 것과 확인되지 않은 것은 같지 않다.
  const caveats = [];
  if (!actionAxis && finding.truncated === true) {
    caveats.push('자원 목록이 잘렸습니다 — 여기 보이는 것이 전부가 아닙니다.');
  } else if (enumerationOpen) {
    caveats.push('열거 완전성 미확인 — 목록이 전부인지 확인된 바 없습니다.');
  }
  if (typeOpen) caveats.push('확인되지 않은 유형이 있습니다.');

  // 주장 없음과 미확인은 다르다. 자원을 지목하지 않는 판정은 끊긴 것이 아니라 그 주장을 하지 않은
  // 것이고, 대상이 없는 자원 축 판정은 기록이 없는 것이다.
  const targetState = noTargets
    ? (actionAxis ? 'unclaimed' : 'unverified')
    : (caveats.length > 0 ? 'unverified' : 'established');

  const kind = MARK[containment] ?? null;
  // 끊긴 뒤는 성립하지 않는다. 지우지 않고 낮추는 것은, 사라지면 무엇이 끊겼는지 읽을 수 없기
  // 때문이다. 조여진 것(clamp)은 낮추지 않는다 - 경로가 닫히지 않았다.
  const dim = kind === 'cut';

  const targetSub = noTargets
    ? '없음'
    : `${targets.length}종${targetState === 'unverified' ? ' · 미확인' : ''}`;
  const targetTitle = noTargets
    ? (actionAxis
      ? '지목한 자원 없음 — 이것은 부여 자체의 능력이고, 대상 유형의 자원이 생기는 즉시 그 자원에 '
        + '적용됩니다.'
      : '이 판정에 기록된 대상이 없습니다.')
    : [
      `아래 대상 줄과 같은 수입니다 — 자원 유형과 지정 범위의 묶음 ${targets.length}개. `
      + '개수와 표본과 제외한 자원은 그 줄이 말합니다.',
      ...caveats,
    ].join(' ');

  const links = [
    link('grant', 0, '부여', '', 'established',
         `이 부여 — ${finding.policyName ?? ''}`, false),
    link('action', 1, '동작', `${triggers.length}개`, 'established',
         `이 판정을 발화시킨 동작 ${triggers.length}개. 이름은 아래 「발화 동작」 줄에 전량 있습니다.`,
         dim),
    link('target', 2, '자원', targetSub, targetState, targetTitle, dim),
  ];

  const lines = [
    { key: 'grant', x1: X[0] + LINK_W, x2: X[1], dim: false },
    { key: 'action', x1: X[1] + LINK_W, x2: X[2], dim },
  ];

  // 표는 부여와 동작 사이에 선다. blockPath.js 의 containmentState 가 내는 네 값은 전부 동작
  // 집합에 대한 판정이므로 - offered·denied·touched·fenced·required - 끊긴 자리는 부여가 동작을
  // 내주는 입구다. 그림이 아니라 그 코드에서 나온 자리다.
  const cut = kind === null ? null : {
    kind,
    state: containment,
    cx: X[0] + LINK_W + GAP / 2,
    cy: LINE_Y,
    title: `${words?.label ?? ''} — 이 부여가 동작을 내주는 자리입니다. ${words?.why ?? ''}`,
  };

  const summary = [
    '고리 셋 — 부여, 동작, 자원.',
    `발화 동작 ${triggers.length}개.`,
    noTargets
      ? (actionAxis ? '지목한 자원이 없습니다 — 부여 자체의 능력입니다.' : '기록된 대상이 없습니다.')
      : `대상 ${targets.length}종.`,
    ...caveats,
    `지금 결정의 차단 상태: ${words?.label ?? ''}.`,
    PATH_FOOT,
  ].join(' ');

  return {
    width: PATH_W,
    height: PATH_H,
    lineY: LINE_Y,
    footY: FOOT_Y,
    foot: PATH_FOOT,
    links,
    lines,
    cut,
    summary,
  };
}

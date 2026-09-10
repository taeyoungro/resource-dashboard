// 발견 하나의 경로 그림: 판의 좌표와 낱말, 그리고 지금 결정이 끊은 자리.
//
// THIS MODULE DECIDES EVERYTHING THE PICTURE SHOWS. src/components/RiskAnalysis.tsx 는 받은 것을
// 그리기만 한다 - Topology.tsx 가 server/topology.js 에 대해 지키는 그 분업이고 이유도 같다:
// 판이 제 자리를 벗어나는지, 판이 몇 개인지는 원본 문자열 시험이 잡지 못하고 단위 시험이 잡는다.
//
// 뼈대는 셋이고 가운데만 늘어난다
// -----------------------------
// 부여, 동작, 자원. 첫 판과 끝 판은 무슨 일이 있어도 그 자리이고 그 뜻이다. 늘어나는 것은 가운데뿐이고,
// 늘어나는 조건은 하나다 - 이 판정과 같은 정책에서 발화한 다른 규칙이 있고 규칙 파일이 그 둘 사이의
// 방향을 말할 때. 그 방향은 finding-rules.json 의 `enables` 이고, 그 필드는 규칙 자신의 notes 가
// 순서를 말하는 경우에만 쓰인다(server/rules.js 의 머리글). 흐름이 없는 판정에서 이 파일이 내는
// 좌표는 흐름이 생기기 전과 한 바이트도 다르지 않다.
//
// 발화 동작에는 순서를 주지 않는다. 그것은 술어여서 값마다 판을 하나씩 내주면 데이터에 없는 차례를
// 그리게 되고, 그래서 이 파일이 만드는 어떤 문자열에도 동작 이름이 들어가지 않는다. 순서를 그리는
// 것은 동작이 아니라 규칙이다 - 규칙 사이의 방향은 사람이 적고 검사기가 확인한 것이다.
//
// 열은 선이 정하고 선은 파일이 정한다
// --------------------------------
// 한 열에 판이 둘 놓이는 것은 서로를 성립시키지 않는 두 규칙이 같은 곳으로 모일 때다 - EC2 전체
// 부여에서 「보호 해제」와 「사본 생성」이 「외부 공유」로 모이는 것이 그 모양이다. 선은 열의
// 곱집합이 아니라 chain.edges 에 있는 것만 그린다. 곱집합으로 그리면 파일이 말하지 않은 방향을
// 두 개 지어내게 된다.
//
// 개수도 그리지 않는다. FindingTarget.count 는 파이프라인 자원을 이미 뺀 수이고(riskDigest.js),
// truncated 가 true 면 하한이며, scope 가 '*' 가 아니면 정책이 지목한 목록이다. 카드가 그 수 옆에
// 「· 파이프라인 자원 N개 제외」와 「(정책이 지목한 자원)」과 잘림 경고를 반드시 붙이는 이유가
// 그것이고, 자격이 필요한 수를 자격 없이 옮기지 않는 유일한 방법은 그 수를 옮기지 않는 것이다.
//
//     node --test server/findingPath.test.js

/** 판 하나의 폭. 가장 긴 덧말 「12종 · 미확인」이 10px 에서 65px 이고 안쪽 폭은 72px 이다. */
export const LINK_W = 88;
export const LINK_H = 28;
export const GAP = 32;
/** 한 열에 판이 여럿일 때 판 사이의 세로 여백. */
export const ROW_GAP = 8;
/** 328. 흐름이 없는 판정의 폭이고, 이 배치가 만드는 가장 좁은 카드 안쪽 폭보다 작다. */
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
/**
 * 흐름이 있을 때의 밑줄.
 *
 * 흐름이 없는 그림의 밑줄과 다른 문장인 것이 요점이다. 그쪽은 「차례가 아니다」라고 말해야 하고
 * 이쪽은 차례가 맞으므로, 같은 문장을 쓰면 하나는 반드시 거짓이 된다.
 */
export const CHAIN_FOOT = '왼쪽에서 오른쪽이 차례입니다 — 규칙 파일이 방향을 말한 것만 그립니다.';

/** 끊긴 자리의 모양. 조여진 것과 끊긴 것은 색이 아니라 모양으로 갈린다.
 *
 * 'partial' 이 막대가 아니라 고리인 것이 이 표의 요점이다. 「일부 차단됨」은 오늘 있는 ARN 목록이나
 * 누가 고를 수 있는 태그 값에 조건부인 제한이므로 경로를 닫지 않는다. 막대를 그리면 닫혔다고 말하는
 * 것이고, 아무것도 그리지 않으면 아무도 손대지 않았다고 말하는 것이다.
 */
const MARK = { full: 'cut', fenced: 'cut', partial: 'clamp', none: null };

const colX = (column) => column * (LINK_W + GAP);

/**
 * 한 열에 놓인 판들의 y. 열의 세로 중심을 등뼈에 맞춘다.
 *
 * 판이 하나면 y = spine - LINK_H/2 이고, 흐름이 없는 그림에서 spine 이 LINE_Y 이므로 y 는 0 이 된다
 * - 흐름이 생기기 전의 좌표 그대로다.
 */
function rowYs(count, spine) {
  const total = count * LINK_H + (count - 1) * ROW_GAP;
  const top = spine - total / 2;
  return Array.from({ length: count }, (_, i) => top + i * (LINK_H + ROW_GAP));
}

function plate(id, x, y, label, sub, state, title, dim, extra = {}) {
  return {
    id,
    label,
    sub,
    state,
    title,
    dim,
    x,
    y,
    w: LINK_W,
    h: LINK_H,
    // 덧말이 없으면 라벨이 판의 세로 한가운데로 내려온다.
    labelY: y + (sub ? 12 : 18),
    subY: y + 23,
    /** 선이 닿는 높이. 판의 세로 중점이고, 등뼈와 다를 수 있다. */
    midY: y + LINK_H / 2,
    ...extra,
  };
}

/**
 * 두 판을 잇는 꺾은선.
 *
 * 높이가 같으면 두 점, 다르면 네 점이다. 꺾이는 x 는 두 판 사이 여백의 가운데이므로, 한 곳으로
 * 모이는 선 여럿이 같은 세로줄에서 만난다 - 그것이 모임으로 읽히는 이유다.
 */
function elbow(key, from, to, dim) {
  const x1 = from.x + from.w;
  const x2 = to.x;
  if (from.midY === to.midY) {
    return { key, points: [[x1, from.midY], [x2, to.midY]], dim };
  }
  const bend = x1 + (x2 - x1) / 2;
  return {
    key,
    points: [[x1, from.midY], [bend, from.midY], [bend, to.midY], [x2, to.midY]],
    dim,
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

  // 흐름. 없으면 가운데는 판 하나이고 그림은 예전 그대로다.
  const chain = Array.isArray(finding.chain?.steps) && finding.chain.steps.length > 1
    ? finding.chain
    : null;
  const columns = chain
    ? Math.max(...chain.steps.map((s) => s.column)) + 1
    : 1;
  const stacked = chain
    ? Math.max(...Array.from({ length: columns },
                             (_, c) => chain.steps.filter((s) => s.column === c).length))
    : 1;
  const band = stacked * LINK_H + (stacked - 1) * ROW_GAP;
  const spine = band / 2;
  const width = (columns + 2) * LINK_W + (columns + 1) * GAP;
  const footY = band + (FOOT_Y - LINK_H);
  const height = band + (PATH_H - LINK_H);

  const grant = plate('grant', colX(0), spine - LINK_H / 2, '부여', '', 'established',
                      `이 부여 — ${finding.policyName ?? ''}`, false);

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
  const target = plate('target', colX(columns + 1), spine - LINK_H / 2, '자원', targetSub,
                       targetState, targetTitle, dim);

  // 가운데. 흐름이 없으면 「동작」 판 하나, 있으면 규칙 하나가 판 하나.
  const steps = [];
  if (!chain) {
    steps.push(plate('action', colX(1), spine - LINK_H / 2, '동작', `${triggers.length}개`,
                     'established',
                     `이 판정을 발화시킨 동작 ${triggers.length}개. 이름은 아래 「발화 동작」 줄에 `
                     + '전량 있습니다.', dim));
  } else {
    for (let c = 0; c < columns; c += 1) {
      const here = chain.steps.filter((s) => s.column === c);
      const ys = rowYs(here.length, spine);
      here.forEach((step, i) => {
        steps.push(plate(step.id, colX(c + 1), ys[i], step.label,
                         // 판마다 자기 규칙 아이디를 단다 - 옆 판이 어느 카드인지 읽을 수 있어야
                         // 하고, 이 카드의 판은 예전 「동작」 판이 말했던 수를 계속 말해야 한다.
                         step.self ? `${step.id} · ${triggers.length}개` : step.id,
                         'established',
                         step.self
                           ? `${step.id} ${step.title} — 이 카드입니다. 발화 동작 `
                             + `${triggers.length}개의 이름은 아래 「발화 동작」 줄에 전량 있습니다.`
                           : `${step.id} ${step.title} — 같은 정책에서 함께 발화한 판정입니다. `
                             + '동작과 대상은 그 카드가 말합니다.',
                         dim,
                         { step: step.id, self: step.self }));
      });
    }
  }
  const byId = new Map(steps.map((p) => [p.id, p]));
  const self = steps.find((p) => p.self) ?? steps[0];

  // 선. 부여는 첫 열의 모두에게, 규칙 사이는 파일이 말한 방향만, 자원은 이 카드의 판에서만.
  //
  // 자원 판이 이 카드의 판에서만 나가는 이유: 「대상」 줄이 세는 것은 이 규칙의 대상이고 옆
  // 판정의 대상이 아니다. 모든 판에서 자원으로 선을 그으면 남의 도달을 이 카드의 수로 말하게 된다.
  const lines = [];
  const first = chain ? steps.filter((p) => chain.steps.find((s) => s.id === p.id)?.column === 0)
                      : steps;
  for (const to of first) lines.push(elbow(`grant-${to.id}`, grant, to, false));
  for (const edge of chain?.edges ?? []) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from && to) lines.push(elbow(`${edge.from}-${edge.to}`, from, to, dim));
  }
  lines.push(elbow(`${self.id}-target`, self, target, dim));

  // 표는 부여와 첫 열 사이에 선다. blockPath.js 의 containmentState 가 내는 네 값은 전부 동작
  // 집합에 대한 판정이므로 - offered·denied·touched·fenced·required - 끊긴 자리는 부여가 동작을
  // 내주는 입구다. 그림이 아니라 그 코드에서 나온 자리다.
  const cut = kind === null ? null : {
    kind,
    state: containment,
    cx: colX(0) + LINK_W + GAP / 2,
    cy: spine,
    title: `${words?.label ?? ''} — 이 부여가 동작을 내주는 자리입니다. ${words?.why ?? ''}`,
  };

  const order = chain
    ? [...chain.steps].sort((a, b) => a.column - b.column || a.id.localeCompare(b.id))
      .map((s) => `${s.label}${s.self ? '(이 카드)' : ''}`)
    : [];
  const foot = chain ? CHAIN_FOOT : PATH_FOOT;
  const summary = [
    chain
      ? `흐름 ${chain.steps.length}단계 — ${order.join(', ')}. 방향은 규칙 파일이 말한 것입니다.`
      : '판 셋 — 부여, 동작, 자원.',
    chain && chain.omittedSteps > 0
      ? `카드 폭에 담지 못한 단계 ${chain.omittedSteps}개가 더 있습니다.` : null,
    `발화 동작 ${triggers.length}개.`,
    noTargets
      ? (actionAxis ? '지목한 자원이 없습니다 — 부여 자체의 능력입니다.' : '기록된 대상이 없습니다.')
      : `대상 ${targets.length}종.`,
    ...caveats,
    `지금 결정의 차단 상태: ${words?.label ?? ''}.`,
    foot,
  ].filter(Boolean).join(' ');

  return {
    width,
    height,
    lineY: spine,
    footY,
    foot,
    /** 언제나 부여가 먼저, 자원이 끝. 가운데만 흐름을 따라 늘어난다. */
    links: [grant, ...steps, target],
    lines,
    cut,
    /** 흐름이 있을 때만. 카드가 「단계 N개」를 말로도 적기 위해 읽는다. */
    flow: chain ? { steps: chain.steps.length, omitted: chain.omittedSteps } : null,
    /** <desc>. 순수 함수의 반환값이므로 graphSummary 와 같이 단위 시험이 고정한다. */
    summary,
  };
}

// 정책 하나의 흐름 그림 - 무엇을 그리지 않는지가 무엇을 그리는지만큼 중요하다.
//
// 이 그림의 약속은 둘이다. 선은 규칙 파일이 방향을 말한 것만 그린다 - 열의 곱집합으로 그리면 파일이
// 말하지 않은 방향을 지어내게 되고, 한 열에 판이 둘 서는 순간 그것이 실제로 일어난다. 그리고 흐름에
// 들지 않은 규칙은 판이 아니라 칩이다 - 선이 닿지 않는 판은 무언가의 단계로 읽힌다.
//
// findingPath.test.js 와 나란히 읽는다. 그쪽은 카드 하나의 도달을, 이쪽은 정책 하나의 차례를 고정한다.
//
//     node --test server/policyFlow.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLOW_FOOT, FLOW_GAP, PLATE_GAP, PLATE_H, PLATE_VGAP, PLATE_W, policyFlow, policyFlows,
} from './policyFlow.js';
import { textUnits } from './topology.js';

/** 화면의 낱말표. 띠가 GRADE_LABEL 을 그대로 넘기는 것과 같은 모양. */
const WORDS = { CRITICAL: '치명', HIGH: '높음', MEDIUM: '보통', LOW: '낮음', NONE: '없음' };

/** EC2 전체 부여에서 실제로 나오는 흐름. server/findings.js 의 chainFor 가 내는 모양 그대로다. */
const CHAIN = (self) => ({
  steps: [
    { id: 'V-2', label: '보호 해제', title: '보호 설정 해제', column: 0, self: self === 'V-2' },
    { id: 'X-5', label: '사본 생성', title: '디스크 사본 생성', column: 0, self: self === 'X-5' },
    { id: 'X-6', label: '외부 공유', title: '디스크 사본의 외부 계정 공유', column: 1,
      self: self === 'X-6' },
  ],
  edges: [{ from: 'V-2', to: 'X-6' }, { from: 'X-5', to: 'X-6' }],
  omittedSteps: 0,
});

const F = (id, over = {}) => ({
  id,
  axis: 'resource',
  policyId: 'P1',
  policyName: 'arn:aws:iam::aws:policy/AmazonEC2FullAccess',
  title: `${id} 의 제목`,
  escalationGrade: 'MEDIUM',
  triggerActions: ['ec2:CreateSnapshot'],
  targets: [],
  ...over,
});

/** 흐름에 든 셋과, 차례 없이 함께 발화한 둘. */
const POLICY = () => [
  F('V-2', { escalationGrade: 'HIGH', chain: CHAIN('V-2') }),
  F('X-5', { chain: CHAIN('X-5') }),
  F('X-6', { escalationGrade: 'HIGH', chain: CHAIN('X-6') }),
  F('E-3', { escalationGrade: 'HIGH', chain: null }),
  F('R-2', { escalationGrade: 'LOW', chain: null }),
];

test('그릴 흐름이 없으면 null - 그리고 정책 목록에서도 빠진다', () => {
  assert.equal(policyFlow([], WORDS), null);
  assert.equal(policyFlow(null, WORDS), null);
  assert.equal(policyFlow([F('E-3'), F('R-2')], WORDS), null, '차례 없는 것만으로 흐름을 그렸다');
  // 단계 하나짜리는 흐름이 아니다 - 차례를 하나도 말하지 않는다.
  const one = { steps: [{ id: 'X-6', label: '외부 공유', title: 't', column: 0, self: true }],
                edges: [], omittedSteps: 0 };
  assert.equal(policyFlow([F('X-6', { chain: one })], WORDS), null);
  assert.deepEqual(policyFlows([F('E-3'), F('R-2')], WORDS), []);
});

test('판은 시작 하나와 단계마다 하나, 열은 파일이 말한 차례다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  assert.deepEqual(flow.plates.map((p) => [p.kind, p.ruleId, p.label]),
                   [['policy', null, '이 부여'],
                    ['step', 'V-2', '보호 해제'],
                    ['step', 'X-5', '사본 생성'],
                    ['step', 'X-6', '외부 공유']]);
  // 서로를 성립시키지 않는 둘은 같은 열에 선다. 선 하나로 펴면 없는 방향이 생긴다.
  const at = (id) => flow.plates.find((p) => p.ruleId === id);
  assert.equal(at('V-2').x, at('X-5').x, '같은 열의 두 판이 다른 열에 있다');
  assert.ok(at('X-6').x > at('V-2').x, '뒤에 오는 단계가 앞에 있다');
  assert.notEqual(at('V-2').y, at('X-5').y, '같은 열의 두 판이 겹친다');
  // 시작 판과 모이는 판은 그 흐름의 등뼈에 걸린다.
  const spine = flow.plates[0].midY;
  assert.equal(at('X-6').midY, spine);
  assert.ok(at('V-2').midY < spine && at('X-5').midY > spine);
  assert.equal(flow.flows, 1);
  assert.equal(flow.foot, FLOW_FOOT);
});

test('선은 파일이 말한 방향만 - 열의 곱집합이 아니다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  assert.deepEqual(flow.lines.map((l) => l.key).sort(),
                   ['0:V-2-X-6', '0:X-5-X-6', '0:origin-V-2', '0:origin-X-5']);
  assert.ok(!flow.lines.some((l) => l.key.includes('V-2-X-5') || l.key.includes('X-5-V-2')),
            '어느 쪽도 다른 쪽을 성립시키지 않는 두 판 사이에 선을 그었다');
  // 모이는 선들은 같은 세로줄에서 꺾인다 - 그것이 모임으로 읽히는 이유다.
  const bends = flow.lines.filter((l) => l.key.endsWith('-X-6')).map((l) => l.points[1][0]);
  assert.equal(new Set(bends).size, 1, '모이는 선이 서로 다른 곳에서 꺾인다');
});

test('선이 판의 변에서 변으로 이어지고, 모든 것이 viewBox 안에 있다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  const at = new Map(flow.plates.map((p) => [p.key, p]));
  for (const plate of flow.plates) {
    assert.equal(plate.w, PLATE_W);
    assert.equal(plate.h, PLATE_H);
    assert.ok(plate.x >= 0 && plate.x + plate.w <= flow.width, `${plate.key} 가 폭을 넘었다`);
    assert.ok(plate.y >= 0 && plate.y + plate.h <= flow.height, `${plate.key} 가 높이를 넘었다`);
    // 글자의 y 는 판을 기준으로 잰다 - 판이 y 0 에 있지 않다.
    assert.ok(plate.labelY > plate.y && plate.labelY <= plate.y + plate.h,
              `${plate.key} 의 label 이 판 밖이다`);
    if (plate.sub) assert.ok(plate.subY <= plate.y + plate.h, `${plate.key} 의 sub 이 판 밖이다`);
    assert.equal(plate.midY, plate.y + PLATE_H / 2);
  }
  assert.ok(flow.footY <= flow.height);
  assert.ok(flow.footY > Math.max(...flow.plates.map((p) => p.y + p.h)), '밑줄이 판과 겹친다');
  for (const line of flow.lines) {
    // 규칙 아이디에 하이픈이 있으므로 열쇠를 쪼개지 않고 알려진 판 이름으로 앞뒤를 찾는다.
    const tail = line.key.slice(line.key.indexOf(':') + 1);
    const from = tail.startsWith('origin-') ? flow.plates[0]
      : flow.plates.find((p) => p.ruleId && tail.startsWith(`${p.ruleId}-`));
    const to = flow.plates.find((p) => p.ruleId && tail.endsWith(`-${p.ruleId}`));
    assert.ok(from && to, `${line.key}: 양 끝이 판이 아니다`);
    assert.ok(at.has(to.key));
    assert.deepEqual(line.points[0], [from.x + PLATE_W, from.midY], `${line.key}: 앞 변이 아니다`);
    assert.deepEqual(line.points[line.points.length - 1], [to.x, to.midY],
                     `${line.key}: 뒤 변이 아니다`);
    assert.equal(line.points[line.points.length - 1][0] - line.points[0][0], PLATE_GAP);
    // 높이가 같으면 두 점, 다르면 네 점. 그 사이는 없다.
    assert.equal(line.points.length, from.midY === to.midY ? 2 : 4, line.key);
    for (const [x, y] of line.points) {
      assert.ok(x >= 0 && x <= flow.width && y >= 0 && y <= flow.height, `${line.key}: 선이 밖이다`);
    }
  }
});

test('차례 없이 함께 발화한 것은 판이 아니라 칩이고, 무거운 것부터 선다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  assert.deepEqual(flow.chips.map((c) => c.ruleId), ['E-3', 'R-2']);
  assert.deepEqual(flow.chips.map((c) => c.grade), ['HIGH', 'LOW']);
  // 흐름에 든 규칙은 칩이 되지 않는다. 되면 같은 규칙이 화면에 두 번 선다.
  for (const chip of flow.chips) {
    assert.ok(!['V-2', 'X-5', 'X-6'].includes(chip.ruleId), `${chip.ruleId} 이 판이면서 칩이다`);
  }
  // 칩은 단계가 아니므로 stepLabel 이 없고 규칙의 제목을 쓴다 - 그리고 폭 예산이 없다.
  assert.equal(flow.chips[0].label, 'E-3 의 제목');
});

test('축이 둘인 규칙은 판 하나이고, 그 판이 카드 둘을 가리킨다', () => {
  // 한 규칙이 두 질문에 답하면 판정이 둘이고 성분은 같다. 접지 않으면 같은 흐름을 두 번 그린다.
  const both = [
    ...POLICY(),
    F('X-6', { axis: 'action', escalationGrade: 'HIGH', chain: CHAIN('X-6') }),
  ];
  const flow = policyFlow(both, WORDS);
  assert.equal(flow.flows, 1, '같은 성분을 두 번 그렸다');
  assert.equal(flow.plates.filter((p) => p.ruleId === 'X-6').length, 1);
  assert.deepEqual(flow.plates.find((p) => p.ruleId === 'X-6').axes, ['action', 'resource']);
  assert.deepEqual(flow.plates.find((p) => p.ruleId === 'V-2').axes, ['resource']);
});

test('흐름이 둘이면 위아래로 쌓이고, 시작 판이 흐름마다 하나씩 선다', () => {
  const second = {
    steps: [{ id: 'R-1', label: '정찰', title: '차단 불가 정찰', column: 0, self: true },
            { id: 'E-1', label: '권한 획득', title: '역할 전달', column: 1, self: false }],
    edges: [{ from: 'R-1', to: 'E-1' }],
    omittedSteps: 0,
  };
  const flow = policyFlow([
    ...POLICY(),
    F('R-1', { escalationGrade: 'MEDIUM', chain: second }),
    F('E-1', { escalationGrade: 'CRITICAL', chain: second }),
  ], WORDS);
  assert.equal(flow.flows, 2);
  const origins = flow.plates.filter((p) => p.kind === 'policy');
  assert.equal(origins.length, 2, '흐름마다 시작이 있어야 선이 어디서 나오는지 말할 수 있다');
  assert.deepEqual(origins.map((p) => p.sub), ['흐름 1/2', '흐름 2/2']);
  // 두 번째 흐름이 첫 번째 아래에 선다. 겹치면 선이 남의 판을 지나간다.
  const first = flow.plates.filter((p) => p.key.startsWith('0:') || p.key === 'p0');
  const next = flow.plates.filter((p) => p.key.startsWith('1:') || p.key === 'p1');
  const bottom = Math.max(...first.map((p) => p.y + p.h));
  assert.ok(Math.min(...next.map((p) => p.y)) >= bottom + FLOW_GAP - PLATE_VGAP,
            '두 흐름이 겹친다');
  // 선도 자기 흐름 안에서만 이어진다.
  for (const line of flow.lines) assert.match(line.key, /^[01]:/);
});

test('그림이 대는 것은 규칙 아이디와 등급뿐 - 자원의 수도 동작 이름도 아니다', () => {
  // FindingTarget.count 는 파이프라인 자원을 이미 뺀 수이고 truncated 가 true 면 하한이다. 자격이
  // 필요한 수를 자격 없이 옮기지 않는 유일한 방법은 그 수를 옮기지 않는 것이다.
  const rich = POLICY().map((f) => ({
    ...f,
    triggerActions: ['ec2:CreateSnapshot', 'ec2:ModifySnapshotAttribute'],
    truncated: true,
    targets: [{ type: 'ec2:snapshot', count: 118, scope: '*', sample: ['arn:aws:ec2:::snapshot/s-1'],
                sampleComplete: false, controlPlane: [], governed: 89, governedRoles: ['opt-x'],
                actions: [], status: 'CONFIRMED' }],
  }));
  const flow = policyFlow(rich, WORDS);
  const drawn = JSON.stringify([flow.plates.map((p) => [p.label, p.sub]), flow.summary]);
  for (const forbidden of ['118', '89', 's-1', 'opt-x', 'ec2:CreateSnapshot',
                           'ec2:ModifySnapshotAttribute']) {
    assert.ok(!drawn.includes(forbidden), `${forbidden} 이 그림에 들어갔다`);
  }
  assert.equal(flow.plates.find((p) => p.ruleId === 'X-6').sub, 'X-6 · 높음');
});

test('등급의 낱말은 넘겨준 것만 쓴다 - 두 번째 벌을 두지 않는다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  assert.ok(flow.plates.some((p) => p.sub.includes('높음')));
  // 낱말표를 안 주면 원래 값이 그대로 나온다. 여기에 기본 한국어를 두면 배지와 그림이 갈라진다.
  const bare = policyFlow(POLICY());
  assert.ok(bare.plates.some((p) => p.sub.includes('HIGH')));
  assert.ok(!bare.plates.some((p) => p.sub.includes('높음')), '그림이 자기 낱말표를 들고 있다');
});

test('글자가 제 폭 예산 안에 든다 - 구성도가 쓰는 그 자로 재서', () => {
  // textUnits 는 server/topology.js 가 판의 이름을 자르는 데 쓰는 자다. 11px 에서 1 단위가 11.09px
  // 이므로 라벨(14px)과 덧말(12px)의 자가 각각 다르다. rules.js 의 stepLabel 상한이 이 라벨 예산에서
  // 나온 것이고, 같은 자로 재지 않으면 그 상한이 무의미해진다.
  const PX11 = 112 / 10.1;
  const room = PLATE_W - 32;
  const flow = policyFlow([
    ...POLICY(),
    F('V-2', { escalationGrade: 'CRITICAL',
               chain: { ...CHAIN('V-2'),
                        steps: CHAIN('V-2').steps.map(
                          (s) => (s.id === 'V-2' ? { ...s, label: '열글자짜리인긴이름' } : s)) } }),
  ], WORDS);
  for (const plate of flow.plates) {
    assert.ok(textUnits(plate.label) * PX11 * (14 / 11) <= room,
              `${plate.key} 의 label 「${plate.label}」 이 판보다 넓다`);
    assert.ok(textUnits(plate.sub) * PX11 * (12 / 11) <= room,
              `${plate.key} 의 sub 「${plate.sub}」 이 판보다 넓다`);
  }
  assert.ok(textUnits(flow.foot) * PX11 * (12 / 11) <= flow.width, '밑줄이 그림보다 넓다');
});

test('정책마다 하나씩이고, 같은 입력은 같은 것을 낸다', () => {
  const other = POLICY().map((f) => ({ ...f, policyId: 'P2', policyName: 'AnotherPolicy' }));
  const flows = policyFlows([...POLICY(), ...other, F('Z-1', { policyId: 'P3', chain: null })],
                            WORDS);
  assert.deepEqual(flows.map((f) => f.policyId), ['P1', 'P2'], '흐름 없는 정책이 나왔다');
  // graph.test.js 의 결정성 시험과 같은 모양.
  assert.deepEqual(policyFlow(POLICY(), WORDS), policyFlow(POLICY(), WORDS));
  // 요약은 밑줄과 차례를 담는다 - 그림을 못 보는 사람에게 그림이 말하는 것과 같은 것을 말한다.
  const flow = policyFlow(POLICY(), WORDS);
  assert.ok(flow.summary.includes(FLOW_FOOT));
  assert.ok(flow.summary.includes('보호 해제, 사본 생성 → 외부 공유'), '요약이 차례를 말하지 않는다');
  assert.ok(flow.summary.includes('2건'), '요약이 칩을 말하지 않는다');
});

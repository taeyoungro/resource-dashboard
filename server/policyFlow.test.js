// 정책 하나의 흐름 그림 - 무엇을 그리지 않는지가 무엇을 그리는지만큼 중요하다.
//
// 이 그림의 약속은 셋이다. 선은 규칙 파일이 방향을 말한 것만 그린다 - 열의 곱집합으로 그리면 파일이
// 말하지 않은 방향을 지어내게 되고, 한 열에 판이 둘 서는 순간 그것이 실제로 일어난다. 판은 규칙의
// 이름만이 아니라 무엇을 하는지를 든다 - 그것이 없으면 그림은 카드의 목차이고 볼 이유가 없다. 그리고
// 흐름에는 끝이 있다 - 도달한 곳을 말하지 않으면 승인이 대답해야 하는 물음에 답하지 않는다.
//
// findingPath.test.js 와 나란히 읽는다. 그쪽은 카드 하나의 도달을, 이쪽은 정책 하나의 차례를 고정한다.
//
//     node --test server/policyFlow.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARRIVAL_UNITS, FLOW_FOOT, FLOW_GAP, OUT_W, PLATE_GAP, PLATE_VGAP, STEP_H, STEP_W,
  policyFlow, policyFlows, wrapStory,
} from './policyFlow.js';
import { textUnits } from './topology.js';

/** 화면의 낱말표와 결정 상태. 띠가 GRADE_LABEL·OUTCOME_LABEL·containmentOf 를 넘기는 그 모양. */
const WORDS = {
  grade: { CRITICAL: '치명', HIGH: '높음', MEDIUM: '보통', LOW: '낮음', NONE: '없음' },
};
/** 아무것도 끊기지 않은 결정. 차단 상태를 보는 시험은 이것을 바꿔 쓴다. */
const OPEN = { ...WORDS, containmentOf: () => 'none' };

/** EC2 전체 부여에서 실제로 나오는 흐름. server/findings.js 의 chainFor 가 내는 모양 그대로다. */
const CHAIN = (self) => ({
  steps: [
    { id: 'V-2', label: '보호 해제', title: '보호 설정 해제', story: '거부하던 설정을 끈다',
      outcome: null, outcomeLabel: null, column: 0, self: self === 'V-2' },
    { id: 'X-5', label: '사본 생성', title: '디스크 사본 생성', story: '볼륨의 사본을 만든다',
      outcome: null, outcomeLabel: null, column: 0, self: self === 'X-5' },
    { id: 'X-6', label: '외부 공유', title: '디스크 사본의 외부 계정 공유',
      story: '사본을 계정 밖으로 내보낸다', outcome: 'data_egress',
      outcomeLabel: '계정 밖으로 데이터 반출', column: 1, self: self === 'X-6' },
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

test('판은 단계마다 하나이고 끝에 도착이 선다 - 시작 판은 없다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  assert.deepEqual(flow.plates.map((p) => [p.kind, p.ruleId, p.label]),
                   [['step', 'V-2', '보호 해제'],
                    ['step', 'X-5', '사본 생성'],
                    ['step', 'X-6', '외부 공유'],
                    ['outcome', null, '계정 밖으로 데이터 반출']]);
  // 「이 부여」 판은 정책 이름을 그림 위 캡션이 이미 말하므로 자리만 차지했다. 흐름은 첫 열에서
  // 시작하고, 첫 열의 판에는 들어오는 선이 없다.
  const into = new Set(flow.lines.map((l) => l.key.slice(l.key.lastIndexOf('-') + 1)));
  assert.ok(!into.has('V-2') && !into.has('X-5'), '첫 열에 들어오는 선이 있다');
  // 서로를 성립시키지 않는 둘은 같은 열에 선다. 선 하나로 펴면 없는 방향이 생긴다.
  const at = (id) => flow.plates.find((p) => p.ruleId === id);
  assert.equal(at('V-2').x, at('X-5').x, '같은 열의 두 판이 다른 열에 있다');
  assert.ok(at('X-6').x > at('V-2').x, '뒤에 오는 단계가 앞에 있다');
  assert.notEqual(at('V-2').y, at('X-5').y, '같은 열의 두 판이 겹친다');
  // 같은 열의 둘은 차례가 없으므로 번호를 나눠 갖는다.
  assert.equal(at('V-2').number, at('X-5').number);
  assert.notEqual(at('X-6').number, at('V-2').number);
  assert.equal(flow.flows, 1);
  assert.equal(flow.steps, 3, '도착 판이 단계로 세어졌다');
  assert.equal(flow.foot, FLOW_FOOT);
});

test('판이 무엇을 하는지 말한다 - 이름만 있으면 그림은 카드의 목차다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  const at = (id) => flow.plates.find((p) => p.ruleId === id);
  assert.deepEqual(at('V-2').story, ['거부하던 설정을 끈다']);
  assert.deepEqual(at('X-6').story, ['사본을 계정 밖으로 내보낸다']);
  // 각주는 아이디와 등급뿐. 대상의 수는 카드가 말한다.
  assert.equal(at('X-6').note, 'X-6 · 높음');
  // 이야기가 없는 단계는 이야기 줄이 없다. 지어내지 않는다. 성분은 단계 아이디로 접히므로 판정
  // 전부가 같은 chain 을 들어야 한다 - 하나만 고치면 접기가 원래 것을 고른다.
  const mute = (self) => ({ ...CHAIN(self),
    steps: CHAIN(self).steps.map((s) => (s.id === 'V-2' ? { ...s, story: '' } : s)) });
  const bare = policyFlow([
    F('V-2', { escalationGrade: 'HIGH', chain: mute('V-2') }),
    F('X-5', { chain: mute('X-5') }),
    F('X-6', { escalationGrade: 'HIGH', chain: mute('X-6') }),
  ], WORDS);
  assert.deepEqual(bare.plates.find((p) => p.ruleId === 'V-2').story, []);
});

test('흐름에는 끝이 있다 - 도달한 곳이 판으로 선다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  const arrived = flow.plates.find((p) => p.kind === 'outcome');
  assert.ok(arrived, '흐름이 마지막 단계에서 그냥 멈췄다');
  assert.equal(arrived.w, OUT_W);
  assert.equal(arrived.ruleId, null, '도착 판이 카드를 여는 것으로 보인다');
  assert.equal(arrived.note, '도달', '도착이 단계 하나 더로 읽힌다');
  assert.ok(arrived.x > Math.max(...flow.plates.filter((p) => p.kind === 'step').map((p) => p.x)));
  // 나가는 간선이 없는 단계에서만 나간다. 중간 단계에서 도착으로 선을 그으면 흐름이 끊긴 것으로
  // 읽힌다.
  const toArrival = flow.lines.filter((l) => l.key.endsWith('-out'));
  assert.deepEqual(toArrival.map((l) => l.key), ['0:X-6-out']);
  // 도착의 한국어는 chain 이 값과 함께 싣고 온다 - 그림도 화면도 자기 표기표를 들지 않는다.
  assert.equal(arrived.label, '계정 밖으로 데이터 반출');
  const unnamed = policyFlow(POLICY().map((f) => (f.chain ? {
    ...f,
    chain: { ...f.chain, steps: f.chain.steps.map((s2) => ({ ...s2, outcomeLabel: null })) },
  } : f)), WORDS);
  assert.equal(unnamed.plates.find((p) => p.kind === 'outcome').label, 'data_egress',
               '표기가 없으면 값이 그대로 보여야 하고, 그림이 한국어를 지어내면 안 된다');
});

test('지금 결정이 끊은 단계가 그림에 표시된다', () => {
  const open = policyFlow(POLICY(), OPEN);
  assert.equal(open.openSteps, 3);
  assert.ok(open.plates.filter((p) => p.kind === 'step').every((p) => p.contained === 'none'));
  assert.ok(open.summary.includes('3개가 아직 차단되지 않았습니다'));

  const cut = policyFlow(POLICY(),
                         { ...WORDS, containmentOf: (f) => (f.id === 'X-6' ? 'full' : 'none') });
  assert.equal(cut.openSteps, 2);
  assert.equal(cut.plates.find((p) => p.ruleId === 'X-6').contained, 'full');
  assert.equal(cut.plates.find((p) => p.ruleId === 'V-2').contained, 'none');
  // 낱말표에 containmentOf 가 없으면 아무것도 주장하지 않는다 - 모른다와 열려 있다는 다르다.
  const silent = policyFlow(POLICY(), WORDS);
  assert.equal(silent.openSteps, null);
  assert.ok(silent.plates.every((p) => p.contained === null));
  assert.ok(!silent.summary.includes('차단되지 않았습니다'));
});

test('축이 둘인 규칙의 차단은 덜 막힌 쪽을 쓴다', () => {
  // 한쪽 축이 열려 있으면 그 경로는 열려 있다. 더 막힌 쪽을 적으면 그림이 실제보다 안전하다고
  // 말하고, 그것이 이 화면이 낼 수 있는 가장 나쁜 거짓말이다.
  const both = [...POLICY(), F('X-6', { axis: 'action', escalationGrade: 'HIGH',
                                        chain: CHAIN('X-6') })];
  const flow = policyFlow(both, {
    ...WORDS,
    containmentOf: (f) => (f.id === 'X-6' && f.axis === 'resource' ? 'full' : 'none'),
  });
  assert.equal(flow.plates.find((p) => p.ruleId === 'X-6').contained, 'none');
});

test('선은 파일이 말한 방향만 - 열의 곱집합이 아니다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  assert.deepEqual(flow.lines.map((l) => l.key).sort(),
                   ['0:V-2-X-6', '0:X-5-X-6', '0:X-6-out']);
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
    assert.equal(plate.w, plate.kind === 'outcome' ? OUT_W : STEP_W);
    assert.equal(plate.h, STEP_H);
    assert.ok(plate.x >= 0 && plate.x + plate.w <= flow.width, `${plate.key} 가 폭을 넘었다`);
    assert.ok(plate.y >= 0 && plate.y + plate.h <= flow.height, `${plate.key} 가 높이를 넘었다`);
    // 글자의 y 는 판을 기준으로 잰다 - 판이 y 0 에 있지 않다.
    assert.ok(plate.labelY > plate.y && plate.labelY <= plate.y + plate.h,
              `${plate.key} 의 label 이 판 밖이다`);
    for (const y of plate.storyY) {
      assert.ok(y > plate.y && y <= plate.y + plate.h, `${plate.key} 의 이야기가 판 밖이다`);
    }
    assert.equal(plate.storyY.length, plate.story.length, `${plate.key}: 줄과 자리의 수가 다르다`);
    if (plate.note) {
      assert.ok(plate.noteY <= plate.y + plate.h, `${plate.key} 의 각주가 판 밖이다`);
    }
    assert.equal(plate.midY, plate.y + STEP_H / 2);
  }
  assert.ok(flow.footY <= flow.height);
  assert.ok(flow.footY > Math.max(...flow.plates.map((p) => p.y + p.h)), '밑줄이 판과 겹친다');
  for (const line of flow.lines) {
    // 규칙 아이디에 하이픈이 있으므로 열쇠를 쪼개지 않고 알려진 판 이름으로 앞뒤를 찾는다.
    const tail = line.key.slice(line.key.indexOf(':') + 1);
    const from = flow.plates.find((p) => p.ruleId && tail.startsWith(`${p.ruleId}-`));
    const to = tail.endsWith('-out')
      ? flow.plates.find((p) => p.kind === 'outcome')
      : flow.plates.find((p) => p.ruleId && tail.endsWith(`-${p.ruleId}`));
    assert.ok(from && to, `${line.key}: 양 끝이 판이 아니다`);
    assert.ok(at.has(to.key));
    assert.deepEqual(line.points[0], [from.x + from.w, from.midY], `${line.key}: 앞 변이 아니다`);
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

test('흐름이 둘이면 위아래로 쌓이고, 각자 자기 도착을 가진다', () => {
  const second = {
    steps: [{ id: 'R-1', label: '정찰', title: '차단 불가 정찰', story: '역할과 정책을 읽는다',
              outcome: null, outcomeLabel: null, column: 0, self: true },
            { id: 'E-1', label: '권한 획득', title: '역할 전달', story: '역할을 넘겨 실행한다',
              outcome: 'code_execution_as', outcomeLabel: '그 역할로 코드 실행',
              column: 1, self: false }],
    edges: [{ from: 'R-1', to: 'E-1' }],
    omittedSteps: 0,
  };
  const flow = policyFlow([
    ...POLICY(),
    F('R-1', { escalationGrade: 'MEDIUM', chain: second }),
    F('E-1', { escalationGrade: 'CRITICAL', chain: second }),
  ], WORDS);
  assert.equal(flow.flows, 2);
  assert.equal(flow.steps, 5);
  // 흐름마다 자기 도착이 있다. 하나로 합치면 두 경로가 같은 곳에 닿는다고 말하게 된다.
  assert.deepEqual(flow.plates.filter((p) => p.kind === 'outcome').map((p) => p.label),
                   ['계정 밖으로 데이터 반출', '그 역할로 코드 실행']);
  // 두 번째 흐름이 첫 번째 아래에 선다. 겹치면 선이 남의 판을 지나간다.
  const first = flow.plates.filter((p) => p.key.startsWith('0:'));
  const next = flow.plates.filter((p) => p.key.startsWith('1:'));
  const bottom = Math.max(...first.map((p) => p.y + p.h));
  assert.ok(Math.min(...next.map((p) => p.y)) >= bottom + FLOW_GAP - PLATE_VGAP, '두 흐름이 겹친다');
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
  const drawn = JSON.stringify([flow.plates.map((p) => [p.label, p.story, p.note]), flow.summary]);
  for (const forbidden of ['118', '89', 's-1', 'opt-x', 'ec2:CreateSnapshot',
                           'ec2:ModifySnapshotAttribute']) {
    assert.ok(!drawn.includes(forbidden), `${forbidden} 이 그림에 들어갔다`);
  }
  assert.equal(flow.plates.find((p) => p.ruleId === 'X-6').note, 'X-6 · 높음');
});

test('등급의 낱말은 넘겨준 것만 쓴다 - 두 번째 벌을 두지 않는다', () => {
  const flow = policyFlow(POLICY(), WORDS);
  assert.ok(flow.plates.some((p) => p.note.includes('높음')));
  // 낱말표를 안 주면 원래 값이 그대로 나온다. 여기에 기본 한국어를 두면 배지와 그림이 갈라진다.
  const bare = policyFlow(POLICY());
  assert.ok(bare.plates.some((p) => p.note.includes('HIGH')));
  assert.ok(!bare.plates.some((p) => p.note.includes('높음')), '그림이 자기 낱말표를 들고 있다');
});

test('글자가 제 폭 예산 안에 든다 - 구성도가 쓰는 그 자로 재서', () => {
  // textUnits 는 server/topology.js 가 판의 이름을 자르는 데 쓰는 자다. 11px 에서 1 단위가 11.09px
  // 이므로 라벨(14px)과 덧말(12px)의 자가 각각 다르다. rules.js 의 stepLabel 상한이 이 라벨 예산에서
  // 나온 것이고, 같은 자로 재지 않으면 그 상한이 무의미해진다.
  const PX11 = 112 / 10.1;
  const room = STEP_W - 32;
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

test('이야기는 판 안에서 줄로 나뉘고, 두 줄에 안 들어가면 버려진다', () => {
  // SVG 는 스스로 줄바꿈하지 않으므로 여기서 미리 나눈다. 버려지는 일이 있으면 뜻이 달라진 문장이
  // 화면에 남으므로, rules.js 가 폭을 적재 때 확인한다 - 이 시험은 그 확인이 지키는 계약이다.
  assert.deepEqual(wrapStory('짧다'), ['짧다']);
  assert.deepEqual(wrapStory('한 줄에 겨우 들어가는 정도의 이야기'),
                   ['한 줄에 겨우 들어가는 정도의 이야기']);
  const long = wrapStory('두 줄로 나뉘어야 할 만큼 긴 이야기이고 여기서부터는 둘째 줄로 넘어간다');
  assert.equal(long.length, 2);
  assert.ok(long.every((line) => textUnits(line) <= (STEP_W - 32) / ((112 / 10.1) * (12 / 11))));
  // 세 줄이 될 것은 두 줄에서 끊긴다 - 그래서 검사기가 있다.
  assert.equal(wrapStory('가 나 다 라 마 바 사 아 자 차 카 타 파 하 거 너 더 러 머 버 서 어 저').length,
               2);
  // 도착 판은 좁으므로 자가 다르다.
  assert.ok(wrapStory('계정 밖으로 데이터 반출', ARRIVAL_UNITS).length <= 2);
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
  assert.ok(flow.summary.includes('보호 해제(거부하던 설정을 끈다)'), '요약이 무엇을 하는지 빼먹었다');
  assert.ok(flow.summary.includes('→ 외부 공유(사본을 계정 밖으로 내보낸다)'), '요약에 차례가 없다');
  assert.ok(flow.summary.includes('도달: 계정 밖으로 데이터 반출'), '요약이 끝을 말하지 않는다');
  assert.ok(flow.summary.includes('2건'), '요약이 칩을 말하지 않는다');
});

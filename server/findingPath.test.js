// 카드 안의 경로 그림 - 무엇을 그리지 않는지가 무엇을 그리는지만큼 중요하다.
//
// 구조적 약속은 둘이다. 첫 판은 부여이고 끝 판은 자원이며 그 자리는 무슨 일이 있어도 바뀌지 않는다.
// 가운데는 흐름이 있을 때만 늘어나고, 늘어나는 근거는 발화 동작의 개수가 아니라 finding.chain 이다
// - 규칙 파일이 방향을 말한 관계 중 이 정책에서 실제로 발화한 것만 담긴 값이다.
//
// 그래서 여기서 고정하는 것은 좌표가 맞는지보다 먼저, 어떤 문자열에도 동작 이름이 들어가지 않는다는
// 것이다. 발화 동작은 술어여서 값마다 판을 하나씩 내주는 순간 데이터에 없는 차례를 그리게 되고, 그
// 시험은 가운데가 늘어나게 된 뒤에도 그대로 남는다.
//
//     node --test server/findingPath.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAIN_FOOT, FOOT_Y, GAP, LINE_Y, LINK_H, LINK_W, PATH_FOOT, PATH_H, PATH_W, ROW_GAP,
  findingPath,
} from './findingPath.js';
import { textUnits } from './topology.js';

/** 화면의 낱말표. 카드가 CONTAINMENT[containment] 를 그대로 넘기는 것과 같은 모양. */
const WORDS = {
  full: { label: '완전 차단됨', why: '동작 자체 거부로 막혔습니다.' },
  fenced: { label: '전달 울타리로 차단됨', why: '울타리로 이미 거부되어 있습니다.' },
  partial: { label: '일부 차단됨', why: '전부를 무조건 막지는 않습니다.' },
  none: { label: '차단되지 않음', why: '아직 아무 제한도 없습니다.' },
};
const path = (finding, containment = 'none') =>
  findingPath(finding, containment, WORDS[containment]);

/** 규칙 판정 하나. server/findings.js 가 실제로 만드는 모양. */
const RULE = (over = {}) => ({
  id: 'E-1',
  axis: 'resource',
  policyName: 'AmazonEC2FullAccess',
  triggerActions: ['iam:PassRole', 'ec2:RunInstances'],
  requiredActions: ['iam:PassRole'],
  truncated: false,
  targets: [{
    type: 'ec2:instance', count: 12, scope: '*', sample: ['arn:aws:ec2:::instance/i-1'],
    sampleComplete: true, controlPlane: [], governed: 0, governedRoles: [],
    actions: ['ec2:RunInstances'], status: 'CONFIRMED',
  }],
  ...over,
});

/**
 * 모델 판정의 target. server/riskAnalysis.js 의 findingOf 는 여섯 필드만 만든다 - status 도
 * actions 도 governed 도 없다. 없는 것을 미확인으로 읽지 않는다는 것이 여기 걸린 주장이다.
 */
const MODEL = (over = {}) => ({
  id: 'C1',
  axis: 'resource',
  source: 'model',
  policyName: 'AmazonEC2FullAccess',
  triggerActions: ['lambda:UpdateFunctionCode'],
  truncated: false,
  targets: [{
    type: 'lambda:function', count: 3, scope: '*', sample: [], sampleComplete: true,
    controlPlane: [],
  }],
  ...over,
});

/**
 * EC2 전체 부여에서 실제로 나오는 흐름. server/findings.js 의 chainFor 가 내는 모양 그대로다.
 *
 * 두 갈래가 한 곳으로 모인다 - 「보호 해제」와 「사본 생성」은 어느 쪽도 다른 쪽을 성립시키지
 * 않으므로 같은 열에 서고, 둘 다 「외부 공유」로 간다. 선을 열의 곱집합으로 그리면 이 모양에서
 * 파일이 말하지 않은 방향이 두 개 생긴다.
 */
const CHAIN = (self = 'X-6') => ({
  steps: [
    { id: 'V-2', label: '보호 해제', title: '보호 설정 해제', column: 0, self: self === 'V-2' },
    { id: 'X-5', label: '사본 생성', title: '디스크 사본 생성', column: 0, self: self === 'X-5' },
    { id: 'X-6', label: '외부 공유', title: '디스크 사본의 외부 계정 공유', column: 1,
      self: self === 'X-6' },
  ],
  edges: [{ from: 'V-2', to: 'X-6' }, { from: 'X-5', to: 'X-6' }],
  omittedSteps: 0,
});

test('흐름이 없으면 판은 언제나 셋이고 언제나 같은 순서다 - 어떤 입력에서도', () => {
  const many = Array.from({ length: 40 }, (_, i) => `svc:Action${i}`);
  const inputs = [
    RULE(),
    RULE({ triggerActions: ['iam:PassRole'] }),
    RULE({ triggerActions: many }),
    RULE({ targets: Array.from({ length: 6 }, (_, i) => ({
      type: `svc:type${i}`, count: 1, scope: '*', sample: [], sampleComplete: true,
      controlPlane: [], governed: 0, governedRoles: [], actions: [], status: 'CONFIRMED',
    })) }),
    RULE({ axis: 'action', targets: [] }),
    MODEL(),
  ];
  for (const finding of inputs) {
    for (const state of ['full', 'fenced', 'partial', 'none']) {
      const p = path(finding, state);
      assert.deepEqual(p.links.map((l) => l.id), ['grant', 'action', 'target'],
                       `${finding.id}/${state}: 고리가 셋이 아니거나 순서가 다르다`);
      assert.equal(p.lines.length, 2);
      assert.equal(p.width, PATH_W);
      assert.equal(p.height, PATH_H);
    }
  }
});

test('어떤 고리의 label 도 sub 도 동작 이름을 담지 않는다', () => {
  // 순서를 발명하지 않는다는 규칙이 그림에서 지켜지는 방식이 이것이다. 이름이 들어가는 순간 여러
  // 개가 늘어선 차례로 읽힌다. 다음 판에서 고리 수를 데이터가 정하게 바꾸더라도 이 시험은 남는다.
  const finding = RULE({ triggerActions: ['iam:PassRole', 'ec2:RunInstances', 'lambda:InvokeFunction'] });
  for (const state of ['full', 'fenced', 'partial', 'none']) {
    const p = path(finding, state);
    for (const action of finding.triggerActions) {
      for (const link of p.links) {
        assert.ok(!link.label.includes(action), `${link.id} 의 label 이 ${action} 을 담았다`);
        assert.ok(!link.sub.includes(action), `${link.id} 의 sub 이 ${action} 을 담았다`);
      }
    }
  }
  // 필수 동작도 마찬가지다 - 모델 판정에는 requiredActions 가 아예 없고, 카드의 「발화 동작」 줄이
  // required 칩으로 이미 말한다.
  assert.ok(!JSON.stringify(path(finding).links).includes('iam:PassRole'));
});

test('발화 동작이 없으면 null - 아무것도 확인되지 않은 자리에 경로를 그리지 않는다', () => {
  // server/findings.js 의 catch 경로가 만드는 모양: axis 는 그대로, triggerActions·targets 는 비고
  // truncated 는 null.
  const broken = {
    id: 'E-9', axis: 'resource', policyName: 'p', triggerActions: [], targets: [], truncated: null,
  };
  for (const state of ['full', 'fenced', 'partial', 'none']) {
    assert.equal(path(broken, state), null);
  }
  assert.equal(findingPath(null, 'none', WORDS.none), null);
  assert.equal(findingPath({}, 'none', WORDS.none), null);
});

test('끊김 네 상태가 각각 다른 것을 낸다, 그리고 표는 부여와 동작 사이에 선다', () => {
  const finding = RULE();
  assert.deepEqual(
    ['full', 'fenced', 'partial', 'none'].map((s) => {
      const c = path(finding, s).cut;
      return c === null ? null : { kind: c.kind, state: c.state };
    }),
    [{ kind: 'cut', state: 'full' }, { kind: 'cut', state: 'fenced' },
     { kind: 'clamp', state: 'partial' }, null],
  );
  // blockPath.js 의 containmentState 가 내는 네 값은 전부 동작 집합에 대한 판정이므로, 끊긴 자리는
  // 부여가 동작을 내주는 입구다.
  for (const state of ['full', 'fenced', 'partial']) {
    const { cut, links } = path(finding, state);
    const grant = links[0]; const action = links[1];
    assert.ok(cut.cx > grant.x + grant.w, `${state}: 표가 부여 고리 위에 있다`);
    assert.ok(cut.cx < action.x, `${state}: 표가 동작 고리 위에 있다`);
    assert.equal(cut.cy, LINE_Y);
  }
});

test('끊긴 사슬만 하류를 낮춘다 - 조인 것은 낮추지 않는다', () => {
  const finding = RULE();
  for (const state of ['full', 'fenced']) {
    const p = path(finding, state);
    assert.deepEqual(p.links.map((l) => l.dim), [false, true, true], `${state}`);
    assert.deepEqual(p.lines.map((l) => l.dim), [false, true], `${state}`);
  }
  for (const state of ['partial', 'none']) {
    const p = path(finding, state);
    assert.ok(!p.links.some((l) => l.dim), `${state}: 경로가 닫히지 않았는데 낮췄다`);
    assert.ok(!p.lines.some((l) => l.dim), `${state}: 경로가 닫히지 않았는데 낮췄다`);
  }
});

test('자원을 지목하지 않는 판정의 자원 고리는 끊김이 아니라 주장 없음이다', () => {
  // 그리고 열거에 대한 의심은 열거를 한 판정에만 붙는다 - 동작 축은 목록을 만들지 않으므로 짧을
  // 목록 자체가 없고, 여기에 미확인을 띄우면 하지도 않은 주장에 대한 의심을 지어내는 것이 된다.
  const p = path(RULE({ axis: 'action', targets: [], truncated: null }));
  const target = p.links[2];
  assert.equal(target.state, 'unclaimed');
  assert.equal(target.sub, '없음');
  assert.equal(target.dim, false);
  assert.ok(!p.summary.includes('미확인'), '동작 축에 열거 의심을 붙였다');
  assert.ok(!p.summary.includes('잘렸'), '동작 축에 잘림 경고를 붙였다');
  // 자원 축인데 대상이 없는 것은 다른 사실이다 - 주장을 하지 않은 것이 아니라 기록이 없는 것이다.
  assert.equal(path(RULE({ targets: [] })).links[2].state, 'unverified');
});

test('status 가 없는 target 으로 미확인을 지어내지 않는다', () => {
  // 모델 판정의 target 에는 status 가 없다. 없는 것을 미확인으로 읽으면 근거가 확정된 판정 위에
  // 의심을 그리게 된다.
  const p = path(MODEL());
  assert.equal(p.links[2].state, 'established');
  assert.equal(p.links[2].sub, '1종');
  assert.ok(!p.summary.includes('미확인'));
});

test('잘린 것과 확인되지 않은 것이 다른 문장이다', () => {
  const cut = path(RULE({ truncated: true }));
  assert.ok(cut.summary.includes('잘렸습니다'), '잘림이 잘림으로 말해지지 않았다');
  assert.equal(cut.links[2].state, 'unverified');
  const unknown = path(RULE({ truncated: null }));
  assert.ok(unknown.summary.includes('확인된 바 없습니다'), '미확인이 미확인으로 말해지지 않았다');
  assert.equal(unknown.links[2].state, 'unverified');
  // 어느 경우에도 자원 고리의 sub 에 개수가 들어가지 않는다.
  for (const p of [cut, unknown]) assert.ok(!p.links[2].sub.includes('12'));
});

test('그림이 대는 수는 카드의 수와 같다 - count·governed·sample 은 그리지 않는다', () => {
  // FindingTarget.count 는 파이프라인 자원을 이미 뺀 수이고, truncated 가 true 면 하한이며,
  // scope 가 '*' 가 아니면 정책이 지목한 목록이다. 자격이 필요한 수를 자격 없이 옮기지 않는 유일한
  // 방법은 그 수를 옮기지 않는 것이다.
  const finding = RULE({
    targets: [
      { type: 'ec2:instance', count: 118, scope: 'arn:aws:ec2:::instance/i-1',
        sample: ['arn:aws:ec2:::instance/i-1'], sampleComplete: false, controlPlane: [],
        governed: 89, governedRoles: ['opt-x'], actions: [], status: 'CONFIRMED' },
      { type: 'ec2:volume', count: 7, scope: '*', sample: [], sampleComplete: true,
        controlPlane: [], governed: 0, governedRoles: [], actions: [], status: 'CONFIRMED' },
    ],
  });
  const p = path(finding);
  const drawn = JSON.stringify([p.links.map((l) => [l.label, l.sub]), p.summary]);
  for (const forbidden of ['118', '89', '7', 'i-1', 'opt-x']) {
    assert.ok(!drawn.includes(forbidden), `${forbidden} 이 그림에 들어갔다`);
  }
  // 그림이 대는 수는 둘뿐이고 둘 다 카드에 대응 줄이 있다.
  assert.equal(p.links[1].sub, `${finding.triggerActions.length}개`);
  assert.equal(p.links[2].sub, `${finding.targets.length}종`);
});

test('기하: 모든 판이 viewBox 안에 있고, 선이 판의 변에서 변으로 이어진다', () => {
  // 흐름이 없는 것과 있는 것을 같은 자로 잰다. 늘어난 그림이 지켜야 하는 것은 좁은 그림이 지키는
  // 것과 같기 때문이다 - 판은 폭 안, 글자는 판 안, 선은 변에서 변으로.
  for (const [what, finding] of [['좁은', RULE()], ['흐름', RULE({ chain: CHAIN() })]]) {
    const p = path(finding, 'partial');
    for (const link of p.links) {
      assert.equal(link.w, LINK_W);
      assert.equal(link.h, LINK_H);
      assert.ok(link.x >= 0 && link.x + link.w <= p.width, `${what} ${link.id} 가 폭을 넘었다`);
      assert.ok(link.y >= 0 && link.y + link.h <= p.height, `${what} ${link.id} 가 높이를 넘었다`);
      // 글자의 y 는 판을 기준으로 잰다 - 흐름이 있으면 판이 y 0 에 있지 않다.
      assert.ok(link.labelY > link.y && link.labelY <= link.y + link.h,
                `${what} ${link.id} 의 label 이 판 밖이다`);
      assert.ok(link.subY <= link.y + link.h, `${what} ${link.id} 의 sub 이 판 밖이다`);
      assert.equal(link.midY, link.y + LINK_H / 2);
    }
    assert.ok(p.footY <= p.height, `${what}: 그림 안 한 줄이 밖으로 나갔다`);
    assert.ok(p.footY > Math.max(...p.links.map((l) => l.y + l.h)),
              `${what}: 그림 안 한 줄이 판과 겹친다`);
    const byId = new Map(p.links.map((l) => [l.id, l]));
    for (const line of p.lines) {
      const [from, to] = line.key.split('-').length > 2
        // 규칙 아이디에 하이픈이 있으므로 앞뒤를 알려진 판 이름으로 찾는다.
        ? [p.links.find((l) => line.key.startsWith(`${l.id}-`)),
           p.links.find((l) => line.key.endsWith(`-${l.id}`))]
        : [byId.get(line.key.split('-')[0]), byId.get(line.key.split('-')[1])];
      assert.ok(from && to, `${line.key}: 양 끝이 판이 아니다`);
      const head = line.points[0];
      const tail = line.points[line.points.length - 1];
      assert.deepEqual(head, [from.x + LINK_W, from.midY],
                       `${line.key}: 앞 판의 변에서 시작하지 않는다`);
      assert.deepEqual(tail, [to.x, to.midY], `${line.key}: 뒤 판의 변에서 끝나지 않는다`);
      assert.equal(tail[0] - head[0], GAP, `${line.key}: 여백을 건너지 않는다`);
      // 높이가 같으면 두 점, 다르면 네 점. 그 사이는 없다.
      assert.equal(line.points.length, from.midY === to.midY ? 2 : 4, line.key);
      for (const [x, y] of line.points) {
        assert.ok(x >= 0 && x <= p.width && y >= 0 && y <= p.height, `${line.key}: 선이 밖이다`);
      }
    }
  }
});

test('흐름이 없는 판정의 좌표는 흐름이 생기기 전과 한 바이트도 다르지 않다', () => {
  // 가운데가 늘어날 수 있게 되었어도 늘어나지 않은 그림은 그대로여야 한다. 이 시험이 없으면
  // 「등뼈」와 「열」로 다시 쓴 기하가 좁은 그림을 조용히 1px 씩 옮겨도 아무도 모른다.
  for (const finding of [RULE(), RULE({ axis: 'action', targets: [] }), MODEL()]) {
    const p = path(finding, 'full');
    assert.equal(p.width, PATH_W);
    assert.equal(p.height, PATH_H);
    assert.equal(p.lineY, LINE_Y);
    assert.equal(p.footY, FOOT_Y);
    assert.equal(p.flow, null);
    assert.equal(p.foot, PATH_FOOT);
    assert.deepEqual(p.links.map((l) => [l.id, l.x, l.y]),
                     [['grant', 0, 0], ['action', LINK_W + GAP, 0], ['target', 2 * (LINK_W + GAP), 0]]);
    assert.deepEqual(p.links.map((l) => [l.labelY, l.subY]), [[18, 23], [12, 23], [12, 23]]);
    assert.deepEqual(p.lines.map((l) => l.points),
                     [[[LINK_W, LINE_Y], [LINK_W + GAP, LINE_Y]],
                      [[2 * LINK_W + GAP, LINE_Y], [2 * (LINK_W + GAP), LINE_Y]]]);
  }
});

test('흐름이 있으면 가운데만 늘어난다 - 첫 판은 부여, 끝 판은 자원', () => {
  const p = path(RULE({ chain: CHAIN() }), 'none');
  assert.deepEqual(p.links.map((l) => l.id), ['grant', 'V-2', 'X-5', 'X-6', 'target']);
  // 열 둘 + 부여 + 자원 = 판 넷 너비.
  assert.equal(p.width, 4 * LINK_W + 3 * GAP);
  // 한 열에 판이 둘이므로 띠가 두 줄이고, 등뼈는 그 가운데다.
  assert.equal(p.height, (2 * LINK_H + ROW_GAP) + (PATH_H - LINK_H));
  assert.equal(p.lineY, (2 * LINK_H + ROW_GAP) / 2);
  // 부여와 자원은 등뼈에 걸리고, 같은 열의 두 판은 등뼈를 사이에 두고 갈린다.
  const at = (id) => p.links.find((l) => l.id === id);
  assert.equal(at('grant').midY, p.lineY);
  assert.equal(at('target').midY, p.lineY);
  assert.equal(at('X-6').midY, p.lineY);
  assert.ok(at('V-2').midY < p.lineY && at('X-5').midY > p.lineY, '같은 열의 두 판이 겹친다');
  assert.deepEqual(p.flow, { steps: 3, omitted: 0 });
  // 밑줄이 다른 문장이다. 좁은 그림은 「차례가 아니다」라고 말해야 하고 이쪽은 차례가 맞다.
  assert.equal(p.foot, CHAIN_FOOT);
  assert.notEqual(CHAIN_FOOT, PATH_FOOT);
});

test('선은 파일이 말한 방향만 - 열의 곱집합이 아니다', () => {
  const p = path(RULE({ chain: CHAIN() }), 'none');
  // 부여는 첫 열의 모두에게, 규칙 사이는 edges 에 있는 둘만, 자원은 이 카드의 판에서만.
  assert.deepEqual(p.lines.map((l) => l.key).sort(),
                   ['V-2-X-6', 'X-5-X-6', 'X-6-target', 'grant-V-2', 'grant-X-5']);
  // 같은 열의 두 판 사이에는 선이 없다. 어느 쪽도 다른 쪽을 성립시키지 않는다.
  assert.ok(!p.lines.some((l) => l.key === 'V-2-X-5' || l.key === 'X-5-V-2'));
  // 모이는 선들은 같은 세로줄에서 꺾인다 - 그것이 모임으로 읽히는 이유다.
  const bends = p.lines.filter((l) => l.key.endsWith('-X-6')).map((l) => l.points[1][0]);
  assert.equal(new Set(bends).size, 1, '모이는 선이 서로 다른 곳에서 꺾인다');
});

test('자원 판은 이 카드의 단계에서만 나간다', () => {
  // 「대상」 줄이 세는 것은 이 규칙의 대상이고 옆 판정의 대상이 아니다. 모든 판에서 자원으로 선을
  // 그으면 남의 도달을 이 카드의 수로 말하게 된다.
  for (const self of ['V-2', 'X-5', 'X-6']) {
    const p = path(RULE({ chain: CHAIN(self) }), 'none');
    const toTarget = p.lines.filter((l) => l.key.endsWith('-target'));
    assert.equal(toTarget.length, 1, `${self}: 자원으로 가는 선이 하나가 아니다`);
    assert.equal(toTarget[0].key, `${self}-target`);
    // 그리고 이 카드의 판만 self 다.
    assert.deepEqual(p.links.filter((l) => l.self).map((l) => l.id), [self]);
  }
});

test('흐름의 판도 동작 이름을 담지 않고, 판보다 넓지 않다', () => {
  const PX = 112 / 10.1;
  const inner = (LINK_W - 16) / PX;
  const finding = RULE({
    chain: CHAIN(),
    triggerActions: ['ec2:CreateSnapshot', 'ec2:ModifySnapshotAttribute'],
  });
  const p = path(finding, 'full');
  for (const link of p.links) {
    for (const action of finding.triggerActions) {
      assert.ok(!link.label.includes(action) && !link.sub.includes(action),
                `${link.id} 이 ${action} 을 담았다`);
    }
    assert.ok(textUnits(link.label) <= inner, `${link.id} 의 label 이 판보다 넓다`);
    assert.ok(textUnits(link.sub) <= inner, `${link.id} 의 sub 「${link.sub}」 이 판보다 넓다`);
  }
  assert.ok(textUnits(p.foot) <= p.width / PX, '그림 안 한 줄이 그림보다 넓다');
  // 판마다 자기 규칙 아이디를 달고, 이 카드의 판은 예전 「동작」 판이 말했던 수를 계속 말한다.
  const at = (id) => p.links.find((l) => l.id === id);
  assert.equal(at('V-2').sub, 'V-2');
  assert.equal(at('X-6').sub, `X-6 · ${finding.triggerActions.length}개`);
});

test('흐름이 있어도 끊긴 자리는 부여의 입구이고, 하류가 전부 낮아진다', () => {
  const p = path(RULE({ chain: CHAIN() }), 'full');
  const grant = p.links[0];
  const firstColumn = p.links.filter((l) => ['V-2', 'X-5'].includes(l.id));
  assert.ok(p.cut.cx > grant.x + grant.w, '표가 부여 판 위에 있다');
  assert.ok(firstColumn.every((l) => p.cut.cx < l.x), '표가 첫 열의 판 위에 있다');
  assert.equal(p.cut.cy, p.lineY);
  // 부여만 서고 나머지는 전부 낮아진다 - 끊긴 뒤는 성립하지 않는다.
  assert.equal(grant.dim, false);
  assert.ok(p.links.slice(1).every((l) => l.dim), '흐름의 판이 낮아지지 않았다');
  // 부여에서 나가는 선은 낮추지 않는다. 끊긴 자리가 그 선 위이므로 그 선 자체는 끊기기 전이다.
  assert.deepEqual(p.lines.filter((l) => l.key.startsWith('grant-')).map((l) => l.dim),
                   [false, false]);
  assert.ok(p.lines.filter((l) => !l.key.startsWith('grant-')).every((l) => l.dim));
});

test('단계가 하나뿐인 흐름은 흐름이 아니다', () => {
  // chainFor 는 단계 둘 미만이면 null 을 내지만, 값이 어떻게 오든 그림이 스스로 판단해야 한다 -
  // 판 하나짜리 「흐름」은 「동작」 판을 규칙 이름으로 바꿔 놓기만 하고 순서를 하나도 말하지 않는다.
  const one = path(RULE({
    chain: { steps: [{ id: 'X-6', label: '외부 공유', title: 't', column: 0, self: true }],
             edges: [], omittedSteps: 0 },
  }));
  assert.deepEqual(one.links.map((l) => l.id), ['grant', 'action', 'target']);
  assert.equal(one.flow, null);
  assert.equal(one.foot, PATH_FOOT);
});

test('담지 못한 단계는 세어서 말한다', () => {
  const p = path(RULE({ chain: { ...CHAIN(), omittedSteps: 2 } }));
  assert.deepEqual(p.flow, { steps: 3, omitted: 2 });
  assert.ok(p.summary.includes('2개'), 'summary 가 담지 못한 단계를 말하지 않는다');
});

test('글자가 제 폭 예산 안에 든다 - 구성도가 쓰는 그 자로 재서', () => {
  // textUnits 는 server/topology.js 가 판의 이름을 자르는 데 쓰는 자다. 같은 자로 재지 않으면 이
  // 그림의 폭 근거가 다른 화면의 폭 근거와 어긋난다. 10.1 단위가 112px 이므로 1 단위는 11.09px 다.
  const PX = 112 / 10.1;
  const inner = (LINK_W - 16) / PX;
  const worst = path(RULE({
    triggerActions: Array.from({ length: 40 }, (_, i) => `svc:Action${i}`),
    truncated: true,
    targets: Array.from({ length: 12 }, (_, i) => ({
      type: `svc:type${i}`, count: 1, scope: '*', sample: [], sampleComplete: true,
      controlPlane: [], governed: 0, governedRoles: [], actions: [], status: 'CONFIRMED',
    })),
  }), 'full');
  for (const link of worst.links) {
    assert.ok(textUnits(link.label) <= inner, `${link.id} 의 label 이 판보다 넓다`);
    assert.ok(textUnits(link.sub) <= inner, `${link.id} 의 sub 「${link.sub}」 이 판보다 넓다`);
  }
  assert.ok(textUnits(worst.foot) <= PATH_W / PX, '그림 안 한 줄이 그림보다 넓다');
});

test('넘긴 낱말이 글자 그대로 들어가고, 같은 입력은 같은 것을 낸다', () => {
  const finding = RULE();
  for (const state of ['full', 'fenced', 'partial', 'none']) {
    const p = path(finding, state);
    assert.ok(p.summary.includes(WORDS[state].label), `${state}: 넘긴 낱말이 summary 에 없다`);
    if (p.cut) {
      assert.ok(p.cut.title.includes(WORDS[state].label));
      assert.ok(p.cut.title.includes(WORDS[state].why));
    }
  }
  assert.ok(path(finding).summary.includes(PATH_FOOT), 'summary 가 그림 안 한 줄을 담지 않는다');
  assert.equal(FOOT_Y, PATH_H - 4);
  // 흐름이 있는 그림은 자기 밑줄을 담는다.
  const flow = path(RULE({ chain: CHAIN() }));
  assert.ok(flow.summary.includes(CHAIN_FOOT));
  assert.ok(flow.summary.includes('보호 해제'), 'summary 가 단계의 이름을 말하지 않는다');
  assert.ok(flow.summary.includes('(이 카드)'), 'summary 가 어느 단계인지 말하지 않는다');
  // graph.test.js 의 결정성 시험과 같은 모양.
  assert.deepEqual(path(RULE(), 'full'), path(RULE(), 'full'));
  assert.deepEqual(path(RULE({ chain: CHAIN() }), 'full'), path(RULE({ chain: CHAIN() }), 'full'));
});

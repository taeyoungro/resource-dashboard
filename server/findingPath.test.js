// 카드 안의 경로 그림 - 무엇을 그리지 않는지가 무엇을 그리는지만큼 중요하다.
//
// 이 그림의 하나뿐인 구조적 약속은 「고리는 언제나 셋이고 언제나 같은 순서다」이다. 발화 동작은
// 순서가 아니라 술어여서, 값마다 고리를 하나씩 내주는 순간 데이터에 없는 차례를 그리게 된다. 그래서
// 여기서 고정하는 것은 좌표가 맞는지보다 먼저, 어떤 문자열에도 동작 이름이 들어가지 않는다는 것이다
// - 다음 판에서 고리 수를 데이터가 정하게 바꾸더라도 그 시험만은 남는다.
//
//     node --test server/findingPath.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOOT_Y, GAP, LINE_Y, LINK_H, LINK_W, PATH_FOOT, PATH_H, PATH_W, findingPath,
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

test('고리는 언제나 셋이고 언제나 같은 순서다 - 어떤 입력에서도', () => {
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

test('기하: 모든 고리가 viewBox 안에 있고, 선이 고리의 변에서 변으로 이어진다', () => {
  const p = path(RULE(), 'partial');
  for (const link of p.links) {
    assert.equal(link.w, LINK_W);
    assert.equal(link.h, LINK_H);
    assert.ok(link.x >= 0 && link.x + link.w <= p.width, `${link.id} 가 폭을 넘었다`);
    assert.ok(link.y >= 0 && link.y + link.h <= p.height, `${link.id} 가 높이를 넘었다`);
    assert.ok(link.labelY <= link.h && link.subY <= link.h, `${link.id} 의 글자가 판 밖이다`);
  }
  assert.ok(p.footY <= p.height && p.footY > LINK_H, '그림 안 한 줄이 판과 겹치거나 밖으로 나갔다');
  for (let i = 1; i < p.links.length; i += 1) {
    const line = p.lines[i - 1];
    assert.equal(line.x1, p.links[i - 1].x + LINK_W, `${line.key}: 앞 고리의 변에서 시작하지 않는다`);
    assert.equal(line.x2, p.links[i].x, `${line.key}: 뒤 고리의 변에서 끝나지 않는다`);
    assert.equal(line.x2 - line.x1, GAP);
  }
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
  // graph.test.js 의 결정성 시험과 같은 모양.
  assert.deepEqual(path(RULE(), 'full'), path(RULE(), 'full'));
});

import { useId, useMemo, useRef, useState } from "react";
import type { ContainmentState, Finding, Grade } from "../types";
import { GRADE_CLASS, GRADE_LABEL } from "../grades";
import { policyFlows } from "../../server/policyFlow.js";
import type { FlowChip, FlowPlate } from "../../server/policyFlow";

/**
 * 정책이 내주는 흐름을, 구역들 위에 한 번.
 *
 * 이 띠가 있기 전에는 흐름이 카드마다 작게 그려졌다. 두 가지가 잘못이었다. 하나는 반복 - 같은 흐름이
 * 그 흐름에 든 카드 수만큼 그려지고 정보는 한 번어치였다. 다른 하나가 더 무겁다: 흐름은 카드 목록의
 * 구역을 거꾸로 가로지른다. V-2 는 EVASION 이고 X-6 은 EXPOSURE 여서 먼저 일어나는 것이 뒤 구역에
 * 있고, R-1(RECON) 과 E-1(ESCALATION) 은 세 구역 떨어져 있다. 구역은 승인자가 침해와 비용을 따로
 * 읽기 위해 있으므로 목록 순서를 바꿔서 고칠 수 없고, 그래서 구역 위에 서는 자리가 필요했다.
 *
 * 판을 누르면 그 규칙의 카드가 열린다. 축이 둘인 규칙은 카드도 둘이고 둘 다 연다 - 같은 규칙이
 * 「지금 무엇에 닿나」와 「무엇을 하게 하나」에 각각 답한 것이라, 하나만 보이면 나머지 절반이 없는
 * 줄로 읽힌다.
 *
 * 차단 단추가 살아 있는 것이 구성도의 카드 창과 다른 점이고, 다를 수 있는 이유는 이 창이 제한
 * 편집기와 같은 패널 안에 서기 때문이다. 구성도는 다른 화면이라 패널의 제한 상태에 닿지 못해 거기
 * 카드는 읽기 전용이다. 여기서는 onBlock 이 RiskScope 의 setBlocking 을 그대로 부르고, 부를 때 이
 * 창을 먼저 닫는다 - 결정 화면이 목적지이므로 그 뒤에 카드가 남아 있을 이유가 없다.
 *
 * 좌표·낱말·문장은 전부 server/policyFlow.js 가 정한다. Topology.tsx 가 server/topology.js 에
 * 대해 지키는 그 분업이고 이유도 같다.
 */
export function PolicyFlowBand({ findings, renderCard, onBlock, containmentOf }: {
  /** 화면이 지금 보이고 있는 판정 전부. 정책으로 나누는 것은 순수 함수가 한다. */
  findings: Finding[];
  /** 카드 하나를 이 창 안에 그린다. 목록이 쓰는 그 카드여야 한다 - 두 벌이면 언젠가 갈라진다. */
  renderCard: (finding: Finding) => React.ReactNode;
  /** 이 판정을 제한하러 간다. null 이면 이 카드에는 차단이 없다 - 단추를 내지 않는다. */
  onBlock: (finding: Finding) => (() => void) | null;
  /** 지금 작성 중인 결정이 이 판정을 얼마나 끊었는가. 목록의 카드가 쓰는 그 함수여야 한다. */
  containmentOf: (finding: Finding) => ContainmentState;
}) {
  const uid = useId();
  const box = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState<string | null>(null);

  // GRADE_LABEL 은 모듈 상수이므로 신원이 렌더마다 같다. containmentOf 는 결정이 바뀔 때마다 새로
  // 오므로 의존성에 넣는다 - 그래야 제한을 하나 쓰면 그림의 단계가 바로 닫힌다. 도착의 한국어는
  // 여기서 넘기지 않는다: chain 이 값과 함께 싣고 오고, 그 표기표를 여는 rules.js 는 적재 때
  // 디스크를 읽어 브라우저 번들에 들어갈 수 없다.
  const flows = useMemo(
    () => policyFlows(findings, { grade: GRADE_LABEL, containmentOf }),
    [findings, containmentOf],
  );
  // 규칙 아이디 하나가 카드 한 장일 수도 두 장일 수도 있다. 정책까지 함께 열쇠로 쓰는 것은 같은
  // 규칙이 정책 둘에서 발화하면 다른 카드이기 때문이다.
  const cards = useMemo(() => {
    const out = new Map<string, Finding[]>();
    for (const finding of findings) {
      const key = `${finding.policyId}:${finding.id}`;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(finding);
    }
    return out;
  }, [findings]);

  if (flows.length === 0) return null;

  const show = (policyId: string, ruleId: string | null) => {
    if (!ruleId) return;
    setOpen(`${policyId}:${ruleId}`);
    box.current?.showModal();
  };
  const chosen = open ? (cards.get(open) ?? []) : [];

  return (
    <section className="flow-band">
      <h4 className="flow-band-head">
        차례가 확립된 흐름
        <span className="muted small">
          {flows.length}개 정책 — 규칙 파일이 방향을 말한 것만 그립니다. 판을 누르면 그 카드가 열립니다
        </span>
      </h4>

      {flows.map((flow) => (
        <div className="flow" key={flow.policyId}>
          <p className="flow-policy"><code>{flow.policyName}</code></p>
          {/* 줄이지 않는다. 좁으면 감싸개가 넘긴다 - .topology-figure 와 .finding-path 가 고른 답과
              같고 이유도 같다: 14px 한글을 줄인 것은 작은 그림이 아니라 읽을 수 없는 그림이다. */}
          <div className="flow-figure">
            <svg
              className="flow-svg"
              viewBox={`0 0 ${flow.width} ${flow.height}`}
              width={flow.width}
              height={flow.height}
              preserveAspectRatio="xMinYMin meet"
              fontFamily="inherit"
              role="img"
              aria-labelledby={`${uid}-${flow.policyId}-t ${uid}-${flow.policyId}-d`}
            >
              <title id={`${uid}-${flow.policyId}-t`}>{`${flow.policyName} 의 흐름`}</title>
              <desc id={`${uid}-${flow.policyId}-d`}>{flow.summary}</desc>

              {/* 선을 먼저, 판을 뒤에. 판이 선의 끝을 덮어야 선이 판 안으로 들어가 보이지 않는다.
                  꺾이는 x 가 여백 한가운데라 한 곳으로 모이는 선 여럿이 같은 세로줄에서 만난다. */}
              {flow.lines.map((line) => (
                <polyline key={line.key} className="flow-line"
                          points={line.points.map(([x, y]) => `${x},${y}`).join(" ")} />
              ))}

              {flow.plates.map((plate: FlowPlate) => (
                <FlowPlateShape key={plate.key} plate={plate}
                                onOpen={() => show(flow.policyId, plate.ruleId)} />
              ))}

              <text className="flow-foot" x={0} y={flow.footY}>{flow.foot}</text>
            </svg>
          </div>

          {/* 그림이 말하는 위험을 지금의 결정에 비추어 한 줄로. 요약(<desc>)에만 있으면 그림을
              보는 사람에게는 없는 것과 같고, 이것이 승인이 대답해야 하는 물음이다. */}
          {flow.openSteps !== null && (
            <p className={flow.openSteps > 0 ? "flow-open warn-inline" : "flow-open"}>
              {flow.openSteps > 0
                ? `단계 ${flow.steps}개 중 ${flow.openSteps}개가 아직 차단되지 않았습니다.`
                : `단계 ${flow.steps}개가 모두 차단되었습니다 — 이 경로는 지금 결정으로 닫힙니다.`}
            </p>
          )}

          {/* 판이 아니라 칩. 선이 닿지 않는 판은 무언가의 단계로 읽히고, 이것들은 단계가 아니라
              이 정책이 함께 내주는 다른 능력이다. */}
          {flow.chips.length > 0 && (
            <p className="flow-chips">
              <span className="muted small">
                차례 없이 함께 발화 {flow.chips.length}건
              </span>
              {flow.chips.map((chip: FlowChip) => (
                <button type="button" key={chip.ruleId} title={chip.title}
                        className={`flow-chip ${GRADE_CLASS[chip.grade as Grade]}`}
                        onClick={() => show(flow.policyId, chip.ruleId)}>
                  <code>{chip.ruleId}</code> {chip.label}
                </button>
              ))}
            </p>
          )}

          {flow.omittedSteps > 0 && (
            <p className="muted small">
              그림 폭에 담지 못한 단계 {flow.omittedSteps}개가 더 있습니다 — 아래 목록에는 있습니다.
            </p>
          )}
        </div>
      ))}

      {/* 카드 창. 세 가지로 닫히고(ESC, 단추, 바깥 클릭) 그중 둘은 클릭 핸들러를 돌리지 않으므로,
          onClose 가 상태를 되돌린다 - 없으면 같은 판을 다시 눌렀을 때 아무것도 열리지 않는다.
          Topology.tsx 의 카드 창이 같은 세 가지를 같은 방식으로 처리하고, 이유도 같다. */}
      <dialog ref={box} className="policy-dialog flow-dialog"
              aria-label={chosen[0] ? `${chosen[0].id} ${chosen[0].title}` : "위험 분석 카드"}
              onClose={() => setOpen(null)}
              onClick={(e) => {
                const it = box.current;
                if (!it || e.target !== it) return;
                const r = it.getBoundingClientRect();
                const inside = e.clientX >= r.left && e.clientX <= r.right
                  && e.clientY >= r.top && e.clientY <= r.bottom;
                if (!inside) it.close();
              }}>
        <div className="policy-dialog-body">
          {chosen.length > 1 && (
            <p className="muted small">
              이 규칙은 두 질문에 모두 답했습니다 — 지금 무엇에 닿는지와, 무엇을 하게 하는지. 두 장
              모두 아래에 있습니다.
            </p>
          )}
          {chosen.map((finding) => (
            <div key={`${finding.axis}:${finding.id}`} className="flow-dialog-card">
              {renderCard(finding)}
              {/* 목적지가 결정 화면이므로 이 창을 먼저 닫는다. 구성도의 카드 창과 달리 단추가 살아
                  있는 것은, 이 창이 제한 편집기와 같은 패널 안에 서기 때문이다. */}
              {(() => {
                const go = onBlock(finding);
                if (!go) return null;
                return (
                  <div className="row">
                    <button type="button" className="primary"
                            onClick={() => { box.current?.close(); go(); }}>
                      이 경로 차단
                    </button>
                  </div>
                );
              })()}
            </div>
          ))}
          <div className="row">
            <button type="button" onClick={() => box.current?.close()}>닫기</button>
          </div>
        </div>
      </dialog>
    </section>
  );
}

/**
 * 판 하나. 규칙을 가리키는 판만 눌린다.
 *
 * 눌리는 것을 <g> 가 아니라 그 안의 <rect> 에 걸지 않고 전체에 거는 이유: 글자도 판의 일부이고,
 * 글자 위를 눌렀을 때 아무 일도 일어나지 않으면 판이 죽은 것으로 읽힌다. 키보드로도 닿아야 하므로
 * role 과 tabIndex 를 준다 - SVG 안이라 <button> 을 쓸 수 없다.
 */
function FlowPlateShape({ plate, onOpen }: { plate: FlowPlate; onOpen: () => void }) {
  const live = plate.ruleId !== null;
  const box = [
    "flow-plate-box",
    plate.kind === "outcome" ? "flow-plate-arrival" : null,
    // 지금 결정이 이 단계를 끊었는가. 색은 카드 왼쪽 테두리(.finding.contained-*)가 쓰는 그 셋이고
    // 같은 세 상태를 말한다 - 왼쪽의 등급 띠와 다른 채널이라 둘이 겹치지 않는다.
    plate.contained && plate.contained !== "none" ? `flow-cut-${plate.contained}` : null,
  ].filter(Boolean).join(" ");
  return (
    <g className={live ? "flow-plate flow-plate-live" : "flow-plate"}
       role={live ? "button" : undefined}
       tabIndex={live ? 0 : undefined}
       aria-label={live ? `${plate.title} 카드 열기` : undefined}
       onClick={live ? onOpen : undefined}
       onKeyDown={live ? (e) => {
         if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
       } : undefined}>
      <rect className={box} x={plate.x} y={plate.y} width={plate.w} height={plate.h} rx={6}>
        <title>{plate.title}</title>
      </rect>
      {/* 등급 띠. 카드 왼쪽 테두리와 같은 것을 말하므로 스타일시트에서 같은 토큰을 쓴다 - 한 화면이
          같은 판정을 두 색으로 말하면 승인자는 어느 쪽을 믿을지 정해야 한다. 이름에 grade- 를 쓰지
          않는 것은 .grade-critical 이 배지와 카드 뿌리에 동시에 걸리는 자리라서다 - 그 충돌은 이미
          한 번 배포된 적이 있고 riskUi.test.js 가 그것을 막고 있다. */}
      {plate.grade && (
        <rect className={`flow-plate-grade flow-grade-${plate.grade.toLowerCase()}`}
              x={plate.x} y={plate.y + 8} width={4} height={plate.h - 16} rx={2} />
      )}
      {plate.kind === "step" ? (
        <>
          <text className="flow-label" x={plate.x + 16} y={plate.labelY}>
            <tspan className="flow-number">{plate.number}</tspan>{` ${plate.label}`}
          </text>
          {/* 이 단계가 무엇을 하는가. 이 줄이 있어서 그림이 규칙 아이디의 목차가 아니게 된다. */}
          {plate.story.map((line, i) => (
            <text className="flow-story" key={line} x={plate.x + 16} y={plate.storyY[i]}>{line}</text>
          ))}
          <text className="flow-note" x={plate.x + 16} y={plate.noteY}>
            {plate.note}
            {plate.contained && plate.contained !== "none"
              ? ` · ${CUT_WORD[plate.contained]}` : null}
          </text>
        </>
      ) : (
        <>
          <text className="flow-arrival-note" x={plate.x + 16} y={plate.noteY}>{plate.note}</text>
          {plate.story.map((line, i) => (
            <text className="flow-arrival" key={line} x={plate.x + 16} y={plate.storyY[i]}>{line}</text>
          ))}
        </>
      )}
    </g>
  );
}

/**
 * 끊긴 단계 옆에 붙는 낱말.
 *
 * 화면의 CONTAINMENT 낱말표를 그대로 쓸 수 없어 짧게 줄인 것이고, 온전한 문장은 카드가 말한다.
 * 색만으로는 말하지 않는다 - 색을 구별하지 못하는 사람에게 이 줄이 두 번째 채널이다.
 */
const CUT_WORD: Record<Exclude<ContainmentState, "none">, string> = {
  full: "차단됨",
  fenced: "울타리로 차단됨",
  partial: "일부 차단됨",
};

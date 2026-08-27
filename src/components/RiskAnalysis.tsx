import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import type {
  AssetGrade, Finding, FindingAxis, FindingCategory, FindingStatus, Grade,
  Impact as ImpactAssessment, Restriction, RiskAnalysisAnswer, RiskAnalysisCitation,
} from "../types";
import { BlockPath } from "./BlockPath";
import { alreadyRestricted, containmentState } from "../../server/blockPath.js";

// The findings, as an approver reads them.
//
// The order is fixed by the design and it is not a style choice. Summary metrics first, then
// ESCALATION, EXPOSURE, RECON, DESTRUCTIVE, then everything that could not be assessed. A reader
// who stops after the first screen has to have seen the worst thing, and "could not be assessed"
// has to be a list they can see the length of rather than items scattered through the sections.
//
// Two rules this file exists to keep:
//
//   The asset grade is never a sort key. It is UNDETERMINED on almost everything - only a resource
//   this deployment was CONFIGURED with can raise it - and sorting by a column that is one value
//   with a few exceptions produces a ranking that means nothing.
//
//   triggerActions is shown in full. Not "iam:PassRole 등 3건": an approver has to be able to see
//   what made the card appear, and a count is not that. Where a card reaches nine hundred resources
//   the COUNT is shown and the ARNs are a sample that says it is one - the opposite convention, for
//   the opposite reason.
//
// And one it refuses to break: no sentence here describes what a resource is FOR. The narrative is
// the rule's own text or the model's, both of which were held to the same rule, and nothing in this
// file composes prose from a resource name.
//
// Two buttons now, 정책 기반 분석 and AI 분석, where there used to be one - see the `run` function
// and `View` below. They are independent toggles rather than a two-way choice: pressing one does
// not undo the other, and pressing BOTH renders exactly what the single button used to render. That
// last part is not a coincidence kept up by convention - every place below that composes text or
// filters findings by `view` was checked against the ORIGINAL unconditional rendering to produce
// the same bytes when `view === "both"`.
//
// The split exists because the two halves have different costs. Rule findings are deterministic and
// free; the model half calls Bedrock, costs money, and takes seconds to minutes. 정책 기반 분석 must
// never start it as a side effect of asking for the free half - see server/api.js's `engine` field
// and the comment on `run` below for how that is kept true even when both buttons are pressed in
// either order, or one is pressed while the other's request is still in flight.

interface Props {
  planId: string;
  /** Whether an assessment exists at all. Without one there is nothing to analyse. */
  ready: boolean;
  /** Raised whenever an answer arrives, so a decision can cite the analysis it was taken against. */
  onAnalysis: (citation: RiskAnalysisCitation | null) => void;
  /**
   * The assessment and the SHARED restriction set, for cutting a path from its card. The card's
   * 차단 dialog writes into the same array the per-policy editor composes - one decision list, one
   * inline document, one 인라인 정책 보기 - which is the entire point: a restriction born here is
   * indistinguishable from one born in the editor by the time it reaches the wire.
   */
  assessment: ImpactAssessment | null;
  restrictions: Restriction[];
  onRestrictions: (next: Restriction[]) => void;
  /** Decisions are closed - the plan is decided or a decision is in flight. Buttons only. */
  restrictDisabled: boolean;
}

/**
 * Which half or halves of the analysis are on screen right now.
 *
 * Not a radio - it is DERIVED from two independent booleans, `wantRules` and `wantAi`, each set by
 * its own button and never unset by the other. "both" is deliberately not a third kind of request:
 * it is what happens when both booleans are true, and it renders the same JSX the single old button
 * did. See the comment above the exported component.
 */
type View = "rules" | "ai" | "both";
/** 카드 배지가 말하는 세 상태. server/blockPath.js가 판정한다. */
type ContainmentState = "full" | "partial" | "none";

const GRADE_ORDER: Record<Grade, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4,
};
const STATUS_ORDER: Record<FindingStatus, number> = {
  CONFIRMED: 0, UNVERIFIED: 1, NOT_ASSESSABLE: 2,
};
/**
 * The two areas, in the order they are read.
 *
 * 영향 자원 위험 first because it is the one an approver can act on immediately: it names ARNs, and
 * a restriction is validated against exactly those names. Action 자체 위험 second because it is the
 * one that outlives the plan - it holds for resources nobody has created yet, and on a new account
 * it is the ONLY area with anything in it.
 *
 * They are never merged. The same rule can appear in both and the pair carries a badge saying so;
 * collapsing them would mean choosing which sentence to lose, and on an account midway between
 * empty and full both are true and neither implies the other.
 */
const AREAS: { axis: FindingAxis; label: string; why: string; empty: string }[] = [
  {
    axis: "resource",
    label: "영향 자원 위험",
    why: "이 부여가 지금 계정에 있는 자원에 실제로 닿는 것. 자원을 지목하므로 제한을 걸어 끊을 수 있고, "
      + "제한이 대조되는 울타리도 이 목록이다",
    empty: "지금 계정에 이 부여가 닿는 자원이 없습니다. 자원이 없는 계정이라면 당연한 결과이며, "
      + "아래 Action 자체 위험이 이 부여에 대한 판정 전부입니다.",
  },
  {
    axis: "action",
    label: "Action 자체 위험",
    why: "자원이 있든 없든 이 부여가 할 수 있게 하는 것. 인벤토리를 보지 않으므로 아직 만들어지지 "
      + "않은 자원에도 그대로 성립하고, 다음 배포 뒤에도 남는다",
    empty: "이 부여의 동작만으로 성립하는 경로가 없습니다.",
  },
];

const AREA_LABEL: Record<FindingAxis, string> = {
  resource: "영향 자원 위험",
  action: "Action 자체 위험",
};

const SECTIONS: { category: FindingCategory; label: string; why: string }[] = [
  { category: "ESCALATION", label: "권한 상승",
    why: "다른 권한을 얻는 경로. 자원이 무엇이든 동작 조합만으로 성립한다" },
  { category: "EXPOSURE", label: "노출",
    why: "내용이 밖으로 나가거나 외부에서 닿을 수 있게 되는 경로" },
  { category: "RECON", label: "정찰",
    why: "무엇이 있는지 읽을 수 있는 경로. 그 자체로 접근을 주지는 않으며, 일부는 선언 경로에 "
      + "있어 정책 축소로 막을 수 없다 — 어느 쪽인지는 카드의 차단 불가 표시가 말한다" },
  { category: "DESTRUCTIVE", label: "파괴",
    why: "있는 것을 지우거나 멈출 수 있는 경로" },
];

const GRADE_LABEL: Record<Grade, string> = {
  CRITICAL: "치명", HIGH: "높음", MEDIUM: "보통", LOW: "낮음", NONE: "없음",
};
const GRADE_CLASS: Record<Grade, string> = {
  CRITICAL: "grade grade-critical",
  HIGH: "grade grade-high",
  MEDIUM: "grade grade-medium",
  LOW: "grade grade-low",
  NONE: "grade",
};
const STATUS_LABEL: Record<FindingStatus, string> = {
  CONFIRMED: "확인",
  UNVERIFIED: "미확인",
  NOT_ASSESSABLE: "평가 불가",
};
const MECHANISM_LABEL: Record<string, string> = {
  new_resource: "신규 자원 생성",
  existing_resource: "기존 자원 변조",
  both: "생성과 변조 모두",
  neither: "자원을 만들지도 바꾸지도 않음",
};
const ROLE_LABEL: Record<string, string> = {
  approval_store: "승인 저장소",
  state_lock: "상태 잠금",
  terraform_state: "terraform 상태",
  inline_state: "인라인 정책 상태",
  marker_store: "표식 저장소",
  event_queue: "이벤트 대기열",
  task_cluster: "작업 클러스터",
  pipeline_role: "파이프라인 역할",
  governed_artifact: "거버넌스 산출물",
  operator_declared: "운영자 선언",
};

/**
 * escalationGrade 내림차순 → status → id 오름차순. assetImpactGrade 는 키가 아니다.
 *
 * The server sorts each half already; this sorts the two halves merged into one, which is the list
 * a person actually reads down.
 */
function compare(a: Finding, b: Finding): number {
  return (GRADE_ORDER[a.escalationGrade] ?? 9) - (GRADE_ORDER[b.escalationGrade] ?? 9)
    || (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    || a.id.localeCompare(b.id, undefined, { numeric: true })
    || a.policyId.localeCompare(b.policyId);
}

const policyName = (arn: string) => arn.split("/").pop() ?? arn;

function AssetGradeBadge({ grade, evidence }: { grade: AssetGrade; evidence: Finding["assetEvidence"] }) {
  if (grade === "UNDETERMINED") {
    // Said, not hidden. An approver who sees no asset grade at all will assume there is nothing to
    // weigh; what is true is that nothing here established what the resource is worth.
    return (
      <span className="badge" title="이 배포의 설정으로 식별되지 않은 자원입니다. 자원 이름으로 용도를 추정하지 않습니다.">
        자산 등급 미판정
      </span>
    );
  }
  const roles = [...new Set(evidence.map((e) => ROLE_LABEL[e.role] ?? e.role))].join(", ");
  // Outlined, never filled, however high it goes. The filled badge is the escalation grade and it
  // has to stay the only one in the row that reads as a headline - two identical-looking CRITICAL
  // marks on one card is how a reader ends up remembering the wrong number.
  return (
    <span className={`${GRADE_CLASS[grade as Grade]} grade-asset`} title={`설정으로 식별: ${roles}`}>
      자산 {GRADE_LABEL[grade as Grade]}
    </span>
  );
}

function Targets({ finding }: { finding: Finding }) {
  if (finding.targets.length === 0) {
    // Only ever an action-axis card: a resource-axis finding that reaches nothing is dropped, since
    // it says exactly what the action-axis one says under a heading promising ARNs.
    return (
      <div className="finding-row muted">
        지목한 자원 없음 — 이것은 <strong>부여 자체의 능력</strong>이고, 대상 유형의 자원이 생기는
        즉시 그 자원에 적용됩니다. 특정 ARN을 지목하는 제한으로는 끊을 수 없습니다.
      </div>
    );
  }
  return (
    <>
      {finding.targets.map((target) => (
        <div className="finding-row" key={`${target.type}:${target.scope}`}>
          <span className="finding-label">대상</span>
          <span>
            <code>{target.type}</code> {target.count}개
            {target.scope === "*" ? "" : " (정책이 지목한 자원)"}
            {target.controlPlane.length > 0 && (
              <>
                {" · "}
                {target.controlPlane.map((hit) => (
                  <span
                    key={hit.arn}
                    className={hit.basis === "prefix" ? "badge" : "badge badge-danger"}
                    title={
                      hit.basis === "prefix"
                        ? "이름이 이 파이프라인이 발급하는 접두사에 속합니다. 이름에 대한 판단이므로 등급을 움직이지 않습니다."
                        : hit.basis === "declared"
                          ? "운영자가 ARN을 직접 선언했습니다."
                          : "이 배포가 설정으로 갖고 있는 이름입니다."
                    }
                  >
                    {ROLE_LABEL[hit.role] ?? hit.role}
                    {hit.basis === "prefix" ? " (접두사)" : ""}
                  </span>
                ))}
              </>
            )}
            {target.sample.length > 0 && (
              <ul className="arn-list small">
                {target.sample.map((arn) => (
                  <li key={arn}><code>{arn}</code></li>
                ))}
                {!target.sampleComplete && (
                  <li className="muted">
                    표본입니다 — {target.count}개 중 {target.sample.length}개만 표시합니다.
                  </li>
                )}
              </ul>
            )}
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * 무엇을 빼면 이 경로가 끊기고, 그러면 무엇이 깨지는가.
 *
 * 제한 편집기가 같은 화면에 있으므로 카드에서 그 화면으로 이어지는 항목은 이것 하나다. 끊는 동작만
 * 적고 대가를 적지 않으면 승인자는 한 번 끊고 되돌린다 — 그래서 '막히는 일'은 접히지 않고 항상 함께
 * 나온다.
 *
 * 선언 경로의 동작은 목록에서 빼지 않고 따로 표시한다. 모델이 제안했다는 사실 자체가 기록이고,
 * 조용히 지우면 승인자는 그 동작을 제한에 넣어도 되는 줄로 읽는다.
 */
function Containment({ finding }: { finding: Finding }) {
  const c = finding.containment;
  if (!c || c.denyActions.length === 0) return null;
  const forbidden = new Set(c.notRestrictable);
  const usable = c.denyActions.filter((a) => !forbidden.has(a));

  return (
    <div className="finding-containment">
      <strong>이 경로를 끊으려면</strong>
      <div className="finding-row">
        <span className="finding-label">거부할 동작</span>
        <span className="finding-actions">
          {c.denyActions.map((action) => (
            <code key={action} className={forbidden.has(action) ? "deny-forbidden" : "deny"}>
              {action}
            </code>
          ))}
        </span>
      </div>
      <div className="finding-row">
        <span className="finding-label">막히는 일</span>
        <span>{c.breaks}</span>
      </div>
      {forbidden.size > 0 && (
        <div className="finding-row warn-inline">
          취소선이 그어진 동작은 선언 경로에 있습니다. 제한에 넣으면 파이프라인이 이 권한 세트를 읽지
          못하므로 실제로 거부할 수 있는 것은
          {usable.length > 0
            ? ` ${usable.join(", ")} 뿐입니다.`
            : " 없습니다 — 이 경로는 정책을 줄여서 끊을 수 없습니다."}
        </div>
      )}
      {c.blockedElsewhere && (
        <div className="finding-row muted">
          <span className="finding-label">이미 차단</span>
          <span>이 경로는 정책 밖의 다른 통제로 이미 막혀 있다고 판정되었습니다.</span>
        </div>
      )}
    </div>
  );
}

/**
 * One finding, folded shut.
 *
 * Thirty-eight cards open at once is a page nobody reads to the end - and the reader's first job is
 * not to read any one of them, it is to see how many there are and at what grade. So the summary
 * row carries everything that decides whether to open it: the grade, the id, the title, and the
 * badges that say whether it can be restricted at all and whether a rule already found it.
 *
 * <details> rather than a useState toggle. It is open/closed in the DOM, so the browser's own find
 * and the keyboard both work on it, and a card cannot get stuck open in a state nothing resets when
 * the plan changes.
 */
/**
 * 이 경로가 지금 결정에서 얼마나 끊기는가.
 *
 * "동작 자체 거부"만 완전 차단이다. 그 의도는 Resource "*"에 Condition 없이 Deny를 쓰므로 계정의
 * 어떤 것도 옆으로 빠져나가지 못한다. 나머지 넷은 전부 무언가에 조건부다 — allow_only·deny_only는
 * 오늘 존재하는 ARN 목록에, 조건 의도 둘은 누군가 값을 고를 수 있는 태그나 요청 키에.
 * 둘 다 진짜 통제이지만 같은 주장이 아니고, 같은 색으로 보이면 안 된다.
 */
const CONTAINMENT: Record<ContainmentState, { label: string; className: string; why: string }> = {
  full: {
    label: "완전 차단됨",
    className: "badge-ok",
    why: "이 경로의 동작이 전부 '동작 자체 거부'로 막혔습니다. Resource \"*\"에 조건 없는 Deny이므로 "
      + "자원이 무엇이든, 앞으로 무엇이 생기든 통합니다.",
  },
  partial: {
    label: "일부 차단됨",
    className: "badge-warn",
    why: "이 경로에 제한이 걸렸으나 전부를 무조건 막지는 않습니다. 자원을 지목하는 제한은 오늘 있는 "
      + "자원의 목록이고, 조건 제한은 태그나 요청 키의 값에 달려 있습니다.",
  },
  none: {
    label: "차단되지 않음",
    className: "badge-danger",
    why: "이 경로에 대해 아직 아무 제한도 작성되지 않았습니다. 승인하면 이 경로는 그대로 남습니다.",
  },
};

function Card({ finding, block, containment, showAxis = false }: {
  finding: Finding;
  /** 이 경로가 지금 작성 중인 결정에서 얼마나 끊기는가. */
  containment: ContainmentState;
  /**
   * The path-cut control, when this finding can have one: the dialog opener and the actions of
   * this finding already sitting in the restriction set. null hides the row entirely - a finding
   * whose policy the assessment cannot restrict, or a decision already closed.
   */
  block: { open: () => void; applied: string[] } | null;
  /** Name the area outright, for cards shown outside one - the 평가 불가 group spans both. */
  showAxis?: boolean;
}) {
  const model = finding.source === "model";
  return (
    <details className={`finding grade-${finding.escalationGrade.toLowerCase()}`}>
      <summary className="finding-head">
        <span className={GRADE_CLASS[finding.escalationGrade]}>
          {GRADE_LABEL[finding.escalationGrade]}
        </span>
        <code className="finding-id">{finding.id}</code>
        <strong className="finding-title">{finding.title}</strong>
        <span className="finding-tags">
          <span className={model ? "badge badge-svc" : "badge"}>
            {model ? "모델 판정" : "규칙"}
          </span>
          {showAxis && <span className="badge">{AREA_LABEL[finding.axis]}</span>}
          {/* 같은 규칙이 두 영역에 다 있다는 사실. 이것이 없으면 두 영역의 건수를 더한 값이 서로
              다른 경로의 수로 읽히고, 승인자는 같은 규칙의 두 판정을 조정하려 든다 — 다른 것은
              답이 아니라 질문이다. */}
          {finding.alsoOnOtherAxis && (
            <span
              className="badge badge-twin"
              title={
                finding.axis === "action"
                  ? "같은 규칙이 지금 있는 자원에도 닿습니다. 영향 자원 위험에서 그 자원을 봅니다."
                  : "같은 규칙이 부여 자체의 능력으로도 성립합니다. 자원을 지목하는 제한만으로는 남습니다."
              }
            >
              ↔ {AREA_LABEL[finding.axis === "action" ? "resource" : "action"]}에도 있음
            </span>
          )}
          {!finding.restrictable && (
            <span
              className="badge badge-danger"
              title="선언 경로의 동작입니다. 정책을 줄여도 막을 수 없습니다 — 줄이면 파이프라인이 이 권한 세트를 읽지 못합니다."
            >
              차단 불가
            </span>
          )}
          {finding.isBaseline && (
            <span className="badge" title="요청 이전에 이미 붙어 있던 정책입니다.">기준선</span>
          )}
          {/* 같은 경로를 규칙도 찾았다는 사실. 두 카드를 각각 새 발견으로 세면 건수가 부풀고, 두
              등급이 어긋났을 때 승인자가 자기 도구의 어느 쪽을 믿을지 정해야 한다. */}
          {(finding.alreadyFoundBy ?? []).length > 0 && (
            <span
              className="badge"
              title={`같은 정책·같은 자원 유형에서 규칙 ${finding.alreadyFoundBy?.join(", ")}도 이 경로를 찾았습니다.`}
            >
              규칙 {finding.alreadyFoundBy?.join(", ")} 중복
            </span>
          )}
          <AssetGradeBadge grade={finding.assetImpactGrade} evidence={finding.assetEvidence} />
          <span className={finding.status === "CONFIRMED" ? "badge badge-ok" : "badge badge-warn"}>
            {STATUS_LABEL[finding.status]}
          </span>
          {/* 증거의 상태 옆에, 이 결정이 그 경로를 실제로 얼마나 끊는가. 앞의 배지는 판정이
              확실한지를 말하고 이것은 그것에 대해 무엇을 했는지를 말한다 — 승인 직전에 둘을
              나란히 읽을 수 있어야 한다. */}
          <span className={`badge ${CONTAINMENT[containment].className}`}
                title={CONTAINMENT[containment].why}>
            {CONTAINMENT[containment].label}
          </span>
        </span>
      </summary>

      <p className="finding-narrative">{finding.narrative}</p>

      <div className="finding-row">
        <span className="finding-label">발화 동작</span>
        {/* 전량. 축약하지 않는다 (T-7). */}
        <span className="finding-actions">
          {finding.triggerActions.map((action) => (
            <code key={action}>{action}</code>
          ))}
        </span>
      </div>

      <Targets finding={finding} />

      <div className="finding-row">
        <span className="finding-label">정책</span>
        <span><code>{policyName(finding.policyName)}</code></span>
      </div>

      {block && (
        <div className="finding-row block-row">
          <span className="finding-label">차단</span>
          <span>
            <button type="button" onClick={block.open}>이 경로 차단</button>
            {block.applied.length > 0 && (
              <span className="muted small">
                {" "}이 경로의 동작 {block.applied.length}개가 제한에 반영되어 있다 — 위{" "}
                <strong>인라인 정책 보기</strong>가 문서로 보여준다.
              </span>
            )}
          </span>
        </div>
      )}

      {model && (
        <>
          <div className="finding-row">
            <span className="finding-label">사고 형태</span>
            <span>
              {MECHANISM_LABEL[finding.mechanism ?? ""] ?? "미분류"}
              {" · "}
              {finding.humanError
                ? "운영자의 실수로도 일어날 수 있습니다"
                : "의도 없이는 일어나기 어렵습니다"}
            </span>
          </div>
          {(finding.preconditions ?? []).length > 0 && (
            <div className="finding-row">
              <span className="finding-label">선행 조건</span>
              <ul className="finding-list">
                {finding.preconditions?.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
          )}
          {finding.finalImpact && (
            <div className="finding-row">
              <span className="finding-label">최종 영향</span>
              <span>{finding.finalImpact}</span>
            </div>
          )}
          {finding.capped && (
            <div className="finding-row muted">
              <span className="finding-label">등급 조정</span>
              <span>
                모델은 {GRADE_LABEL[finding.proposedGrade ?? "NONE"]}을 제안했고, 이 경로의 결과
                유형이 정한 상한에 맞춰 {GRADE_LABEL[finding.escalationGrade]}으로 내렸습니다.
              </span>
            </div>
          )}
          <Containment finding={finding} />
        </>
      )}

      {/* 실제로 이 정책에서 함께 발화한 것만. 전에는 relatedTo가 비어 있지 않으면 무조건 찍혀서,
          R-1이 E-1이 발화하지 않은 정책에서도 "함께 성립합니다"라고 말했다 — 이 계정에 대한
          주장인데 확인하지 않고 인쇄한 것이다. */}
      {(finding.relatedFired ?? []).length > 0 && (
        <div className="finding-row">
          <span className="finding-label">연결</span>
          <span>
            {finding.relatedFired!.join(", ")} 과 같은 정책에서 함께 성립합니다.
          </span>
        </div>
      )}

      {/* 열거에 대한 경고이므로 열거를 한 카드에만 붙는다. Action 자체 위험은 자원 목록을 만들지
          않으므로 짧을 목록 자체가 없고, 여기에 "미확인"을 띄우면 하지도 않은 주장에 대한 의심을
          지어내는 것이 된다. */}
      {finding.axis !== "action" && finding.truncated !== false && (
        <div className="finding-row warn-inline">
          {finding.truncated === true
            ? "자원 목록이 잘렸습니다 — 여기 보이는 것이 전부가 아닙니다."
            : "열거 완전성 미확인 — 목록이 전부인지 확인된 바 없습니다."}
        </div>
      )}

      {finding.status !== "CONFIRMED" && (
        <div className="finding-blocked">
          <strong>{STATUS_LABEL[finding.status]}인 이유</strong>
          <ul className="finding-list">
            {finding.blockedBy.length > 0
              ? finding.blockedBy.map((why) => <li key={why}>{why}</li>)
              : <li>사유가 기록되지 않았습니다.</li>}
          </ul>
        </div>
      )}

      {finding.notes && <div className="finding-row muted small">{finding.notes}</div>}
    </details>
  );
}

/**
 * The meta line's pieces, filtered to what `view` shows - as an array joined by " · " rather than
 * one long conditional string, because which pieces appear now depends on which button was pressed
 * and a template string with the separator baked into each fragment cannot drop a LEADING fragment
 * without leaving a stray " · " at the front of the line.
 *
 * For `view === "both"` every fragment that appeared before this split still appears, in the same
 * order, with the same wording - this function is what was inlined in the JSX before, unrolled and
 * with view-scoping added, not a rewrite of what it says.
 */
function metaParts(answer: RiskAnalysisAnswer, model: RiskAnalysisAnswer["analysis"], view: View): ReactNode[] {
  const parts: ReactNode[] = [];
  if (view !== "ai") parts.push(`규칙 ${answer.rule_findings.length}건`);
  if (view !== "rules" && model) {
    parts.push(`모델 판정 ${model.findings.length}건 (후보 ${model.candidates}건 중)`);
  }
  // 두 절반이 같은 자료를 읽으므로 겹친다. 겹친 수를 적지 않으면 위 숫자들의 합이 서로 다른 경로의
  // 수로 읽힌다 - 오직 두 절반이 함께 보일 때만 나오는 이유다. "AI 분석" 단독 화면에는 규칙 카드가
  // 아예 없으므로, 보이지 않는 카드를 가리키는 문장이 된다.
  if (view === "both" && (answer.candidates_covered_by_rules ?? 0) > 0) {
    parts.push(`그중 ${answer.candidates_covered_by_rules}건은 규칙이 이미 찾은 경로`);
  }
  parts.push(`질의 크기 ${(answer.digest_bytes / 1024).toFixed(1)} KB`);
  // 걸린 시간과 그것을 그렇게 만든 모양. 묶음들이 겹쳐 돌므로 가장 느린 묶음과 전체의 차이가 동시
  // 실행으로 실제로 번 시간이다.
  if (view !== "rules" && model?.timing) {
    parts.push(
      `${(model.timing.totalMs / 1000).toFixed(1)}초 (${model.timing.batchMs.length}묶음 · `
      + `동시 ${model.timing.concurrency} · 가장 느린 묶음 `
      + `${(Math.max(0, ...model.timing.batchMs) / 1000).toFixed(1)}초)`,
    );
  }
  if (view !== "ai") parts.push(<>규칙 <code>{answer.rules_sha256.slice(0, 12)}</code></>);
  if (view !== "rules" && model) {
    parts.push(<>모델 <code>{model.model_id}</code> · 프롬프트 <code>{model.prompt_version}</code></>);
  }
  return parts;
}

function Summary({ answer, findings, view }: {
  answer: RiskAnalysisAnswer; findings: Finding[]; view: View;
}) {
  const count = (grade: Grade) => findings.filter((f) => f.escalationGrade === grade).length;
  const confirmed = findings.filter((f) => f.status === "CONFIRMED").length;
  const blocked = findings.filter((f) => !f.restrictable).length;
  const incomplete = findings.filter((f) => f.truncated !== false).length;
  const model = answer.analysis;

  return (
    <div className="finding-summary">
      <div className="metrics">
        {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as Grade[]).map((grade) => (
          <div className="metric" key={grade}>
            <span className={GRADE_CLASS[grade]}>{GRADE_LABEL[grade]}</span>
            <strong>{count(grade)}</strong>
          </div>
        ))}
        <div className="metric">
          <span className="badge badge-ok">확인</span>
          <strong>{confirmed} / {findings.length}</strong>
        </div>
        <div className="metric">
          <span className="badge badge-danger">차단 불가</span>
          <strong>{blocked}</strong>
        </div>
        <div className="metric">
          <span className="badge badge-warn">열거 미확인</span>
          <strong>{incomplete}</strong>
        </div>
      </div>
      <div className="meta small muted">
        {/* Keyed by position on purpose. The array is rebuilt whole on every render from `answer`
            and `view` - there is no identity to key a fragment by other than where it sits. */}
        {metaParts(answer, model, view).map((part, i) => (
          <span key={i}>{i > 0 ? " · " : null}{part}</span>
        ))}
      </div>
    </div>
  );
}

/** How often the page asks how the model half is going. */
const POLL_MS = 3000;

export function RiskAnalysis({
  planId, ready, onAnalysis, assessment, restrictions, onRestrictions, restrictDisabled,
}: Props) {
  const [answer, setAnswer] = useState<RiskAnalysisAnswer | null>(null);
  // Independent toggles, one per button, and never unset by the other - "both pressed" is a state
  // this pair can BE, not an action a click on either one takes. See the View type above.
  const [wantRules, setWantRules] = useState(false);
  const [wantAi, setWantAi] = useState(false);
  const [busyRules, setBusyRules] = useState(false);
  const [busyAi, setBusyAi] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The finding whose 차단 dialog is open, or null. One at a time - it is modal. */
  const [blocking, setBlocking] = useState<Finding | null>(null);

  // The poll in flight. A ref rather than state because nothing renders from it and because the
  // cleanup below has to be able to stop it without waiting for a re-render.
  const polling = useRef<{ timer: number | null; stopped: boolean }>({ timer: null, stopped: false });

  const stopPolling = () => {
    polling.current.stopped = true;
    if (polling.current.timer !== null) window.clearTimeout(polling.current.timer);
    polling.current.timer = null;
  };

  // Opening another plan abandons this one's poll. Without this the answer for the plan the
  // reviewer just left would arrive and overwrite the one they are looking at now.
  useEffect(() => {
    setAnswer(null);
    setError(null);
    setWantRules(false);
    setWantAi(false);
    setBusyRules(false);
    setBusyAi(false);
    setBlocking(null);
    return stopPolling;
  }, [planId]);

  /**
   * The citation the decision will carry.
   *
   * Only when a model answered: the rule findings are reproducible from the assessment and its
   * digest already travels, so there is nothing for a rules-only run to cite that the marker does
   * not already have.
   *
   * And never for a DISCARDED run. That run cited an action granted nowhere, so every verdict in it
   * was thrown away and the reviewer is looking at the rule findings alone - a citation there would
   * record that a decision was taken while reading an analysis that does not exist.
   */
  const settle = (next: RiskAnalysisAnswer) => {
    setAnswer(next);
    onAnalysis(
      next.analysis && !next.analysis.discarded
        && next.analysis.findings_sha256 && next.analysis.impact_sha256
        ? {
          findings_sha256: next.analysis.findings_sha256,
          model_id: next.analysis.model_id,
          prompt_version: next.analysis.prompt_version,
          impact_sha256: next.analysis.impact_sha256,
        }
        : null,
    );
  };

  const poll = () => {
    polling.current.timer = window.setTimeout(async () => {
      if (polling.current.stopped) return;
      try {
        const next = await api.analysisRun(planId);
        if (polling.current.stopped) return;
        if (next.run?.state === "running") {
          // Only the progress moved. Merged rather than replaced so the rule findings the POST
          // already returned stay on screen while the model half is still being written.
          setAnswer((prev) => (prev ? { ...prev, run: next.run } : prev));
          poll();
          return;
        }
        setBusyAi(false);
        if (next.run?.state === "failed") {
          setError(next.run.error ?? "분석 실행이 끝나지 못했습니다.");
          setAnswer((prev) => (prev ? { ...prev, run: next.run } : prev));
          return;
        }
        settle(next);
      } catch (e) {
        if (polling.current.stopped) return;
        setBusyAi(false);
        setError((e as Error).message);
      }
    }, POLL_MS);
  };

  /**
   * One request function for both buttons - the two engines diverge inside it rather than being
   * two copies of the same fetch/poll plumbing, and the divergence is where "정책 기반 분석 must
   * never bill the model" actually lives.
   *
   * "ai" is the old single button, verbatim: stop any poll, ask, show the rules the POST returns
   * immediately, and poll for the model half if it is still running. It is the ONLY branch that
   * ever starts or stops the poll, and the only one that ever calls onAnalysis - a citation is a
   * claim about what the MODEL found, and a rules-only ask has nothing new to claim.
   *
   * "rules" never touches the poll and never starts the model - that is the entire reason two
   * buttons exist rather than one relabelled into two. It folds the fresh rule findings into
   * whatever the AI side already holds (analysis, analysis_error, run) instead of overwriting them,
   * so a rules click landing while AI 분석 is actively being polled cannot regress that state back
   * to "nothing running" under a response that was never asked about the model at all. If AI 분석
   * already finished or is in flight for this same assessment, its answer or its running state
   * rides along on the rules response too (see server/api.js) - not because this call started
   * anything, but because handing back work already paid for costs nothing further.
   */
  const run = async (engine: "rules" | "ai") => {
    setError(null);

    if (engine === "ai") {
      stopPolling();
      polling.current.stopped = false;
      setWantAi(true);
      setBusyAi(true);
      try {
        const next = await api.analyse(planId, "ai");
        if (polling.current.stopped) return;
        // The rules are finished before this returns, so they go up now rather than after the
        // model. On a real assessment that is the difference between reading twelve findings
        // immediately and staring at a spinner for the minutes the model takes.
        setAnswer(next);
        onAnalysis(null);
        if (next.run?.state === "running") {
          poll();
          return;
        }
        setBusyAi(false);
        settle(next);
      } catch (e) {
        setBusyAi(false);
        setError((e as Error).message);
        setAnswer(null);
        onAnalysis(null);
      }
      return;
    }

    setWantRules(true);
    setBusyRules(true);
    try {
      const next = await api.analyse(planId, "rules");
      setAnswer((prev) => (prev
        ? { ...next, analysis: prev.analysis, analysis_error: prev.analysis_error, run: prev.run }
        : next));
      setBusyRules(false);
    } catch (e) {
      setBusyRules(false);
      setError((e as Error).message);
    }
  };

  if (!ready) {
    return (
      <div className="notice">
        위험 분석은 영향도 평가를 입력으로 씁니다. 평가가 없으면 분석할 것이 없습니다.
      </div>
    );
  }

  // Which half or halves are on screen. "both" is deliberately not distinguished below from what
  // the single old button rendered - see the module comment above the exported component.
  const view: View | null = wantRules && wantAi ? "both" : wantRules ? "rules" : wantAi ? "ai" : null;

  const model = answer?.analysis ?? null;
  const combined = answer ? [...answer.rule_findings, ...(model?.findings ?? [])].sort(compare) : [];
  // Filtered to what THIS view shows. For "both" this is every finding, unchanged from before the
  // split - `f.source` is unset on a rule finding and `"model"` on a model one (see types.ts), so
  // neither filter needs the raw `answer.rule_findings`/`model.findings` arrays directly.
  const visible = view === "ai" ? combined.filter((f) => f.source === "model")
    : view === "rules" ? combined.filter((f) => f.source !== "model")
      : combined;
  const assessable = visible.filter((f) => f.status !== "NOT_ASSESSABLE");
  const unassessable = visible.filter((f) => f.status === "NOT_ASSESSABLE");

  /**
   * The policy a finding's restriction would be keyed by - the digest writes policy.identifier
   * into finding.policyName, so the match is exact, not a name heuristic.
   */
  const policyOf = (finding: Finding) =>
    assessment?.policies.find(
      (p) => p.identifier === finding.policyName && p.restrictable && !p.unreadable,
    ) ?? null;

  /**
   * Whether this card gets a 차단 button, and what it says afterwards.
   *
   * No button rather than a dead one when the path cannot be cut by a restriction at all
   * (finding.restrictable false - the card already carries the 차단 불가 badge and the reason),
   * when the assessment does not hold the policy as restrictable, or when the decision is closed.
   */
  const blockProps = (finding: Finding) => {
    if (restrictDisabled || !finding.restrictable) return null;
    if (!policyOf(finding)) return null;
    return {
      open: () => setBlocking(finding),
      applied: alreadyRestricted(finding, restrictions),
    };
  };

  /**
   * 이 경로가 지금 작성 중인 결정에서 얼마나 끊기는가.
   *
   * blockProps와 달리 카드마다 항상 계산한다. 차단 단추를 내주지 않는 카드 — 선언 경로라 제한할 수
   * 없는 것, 결정이 이미 닫힌 것 — 에서도 "차단되지 않음"은 승인자가 알아야 하는 사실이고, 단추가
   * 없다는 것이 막혀 있다는 뜻으로 읽히면 안 된다.
   */
  const containmentOf = (finding: Finding): ContainmentState =>
    containmentState(finding, restrictions, assessment?.protected_actions ?? []);

  return (
    <section className="impact">
      <h3>위험 및 공격 경로</h3>
      <div className="row">
        <button onClick={() => run("rules")} disabled={busyRules}>
          {busyRules ? "분석 중…" : wantRules ? "정책 기반 분석 다시 실행" : "정책 기반 분석"}
        </button>
        <button onClick={() => run("ai")} disabled={busyAi}>
          {busyAi ? "분석 중…" : wantAi ? "AI 분석 다시 실행" : "AI 분석"}
        </button>
        <span className="muted small">
          정책 기반 분석은 결정론이고 비용 없이 언제나 같은 답을 냅니다. AI 분석은 정책 기반 분석이
          제안한 후보 경로만 판정하며, 경로를 새로 만들지 않고 호출마다 비용이 듭니다. 둘 다 실행하면
          한 화면에 합쳐서 보여줍니다.
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {/* AI 분석을 실제로 물어본 화면에서만 의미가 있는 줄이다 - 정책 기반 분석 단독 화면은 애초에
          모델에 대해 아무것도 말하지 않는다. 규칙 판정은 이미 아래에 떠 있다; 이 줄은 모델 절반이
          아직 오는 중이라는 사실만 말한다 — 없으면 화면이 "모델이 아무것도 찾지 못했다"와 구분되지
          않는다. */}
      {view !== "rules" && answer?.run?.state === "running" && (
        <div className="notice">
          <strong>규칙 판정을 먼저 표시합니다.</strong>{" "}
          모델은 후보를 묶음으로 판정하며 서버에서 계속 돌고 있습니다
          {answer.run.progress.batches
            ? ` — ${answer.run.progress.batches}묶음 중 ${answer.run.progress.done}묶음`
            : ""}
          {` · ${Math.round(answer.run.elapsed_ms / 1000)}초 경과`}. 이 화면을 떠나도 실행은 끝까지
          가고, 돌아와서 다시 누르면 이미 나온 답을 그대로 보여줍니다.
        </div>
      )}

      {answer && view && (
        <>
          {view !== "rules" && answer.analysis_error && (
            <div className="notice">
              <strong>규칙 판정만 표시합니다.</strong> {answer.analysis_error}
            </div>
          )}

          {view !== "rules" && model?.discarded && (
            <div className="error">
              <strong>모델 답변 전체를 버렸습니다.</strong> {model.discarded.why}
              <ul className="finding-list">
                {model.discarded.fabricated.map((f) => (
                  <li key={`${f.id}:${f.action}`}>
                    {f.id}: <code>{f.action}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Summary answer={answer} findings={visible} view={view} />

          {visible.length === 0 && (
            <div className="empty">
              {view === "both" && "발화한 규칙이 없고 모델이 인정한 경로도 없습니다."}
              {view === "rules" && "발화한 규칙이 없습니다."}
              {view === "ai" && "모델이 인정한 경로가 없습니다."}
              {" "}아래 <strong>판정 범위</strong>를 함께 읽으십시오 — 열거가 불완전하면 이 결과도
              불완전합니다.
            </div>
          )}

          {/* 두 영역. 합치지 않고 나란히 둔다 — 하나는 지금 있는 자원에 닿는 것이고 다른 하나는
              자원이 생기면 성립하는 것이라, 같은 규칙이 양쪽에 나와도 두 문장은 다른 것을 말한다.
              자원이 없는 계정에서는 아래쪽이 판정 전부이고, 그것이 이 분리의 이유다. */}
          {assessable.length > 0 && AREAS.map(({ axis, label, why, empty }) => {
            const mine = assessable.filter((f) => f.axis === axis);
            const grades = (["CRITICAL", "HIGH", "MEDIUM", "LOW"] as Grade[])
              .map((g) => ({ g, n: mine.filter((f) => f.escalationGrade === g).length }))
              .filter(({ n }) => n > 0);
            return (
              <div className="finding-area" key={axis}>
                <h4 className="area-head">
                  {label}
                  <span className="area-count">{mine.length}건</span>
                  {grades.map(({ g, n }) => (
                    <span className={GRADE_CLASS[g]} key={g}>{GRADE_LABEL[g]} {n}</span>
                  ))}
                </h4>
                <p className="muted small area-why">{why}</p>
                {mine.length === 0 ? (
                  <div className="empty">{empty}</div>
                ) : SECTIONS.map(({ category, label: section, why: reason }) => {
                  const items = mine.filter((f) => f.category === category);
                  if (items.length === 0) return null;
                  return (
                    <div className="finding-section" key={category}>
                      <h5>
                        {section} <span className="muted small">{items.length}건 — {reason}</span>
                      </h5>
                      {items.map((f) => (
                        <Card key={`${f.policyId}:${f.id}:${f.source ?? "rule"}`} finding={f}
                              block={blockProps(f)} containment={containmentOf(f)} />
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* 두 영역에 걸친다. 근거가 판정을 확정하지 못했다는 것은 어느 질문을 물었는지와 무관한
              사실이므로 영역 안에 나누어 넣지 않고, 카드마다 어느 영역의 것인지 붙인다. */}
          {unassessable.length > 0 && (
            <div className="finding-section">
              <h4>
                평가 불가 <span className="muted small">
                  {unassessable.length}건 — 근거가 판정을 확정하지 못했습니다. 없다는 뜻이 아닙니다
                </span>
              </h4>
              {unassessable.map((f) => (
                <Card key={`${f.policyId}:${f.id}:${f.source ?? "rule"}`} finding={f}
                      block={blockProps(f)} containment={containmentOf(f)} showAxis />
              ))}
            </div>
          )}

          {view !== "rules" && model && model.rejected.length > 0 && (
            <details className="finding-section">
              <summary>
                모델이 경로가 아니라고 판단한 후보 {model.rejected.length}건
              </summary>
              <p className="muted small">
                코드가 제안했고 모델이 부정한 것들입니다. 남겨두는 이유는, 이것이 보이지 않으면
                깨끗한 권한과 분석이 돌지 않은 것을 구분할 수 없기 때문입니다.
              </p>
              <ul className="finding-list">
                {model.rejected.map((r) => (
                  <li key={r.id}>
                    <code>{r.id}</code> {r.title} — {r.why}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {/* 판정 범위. 결과가 아니라 결과를 어디까지 믿을 수 있는지에 대한 것이므로 접지 않는다.
              model.failures/model.dropped는 AI 절반에 대한 것이므로 정책 기반 분석 단독 화면에서는
              빠진다 - answer.dropped(질의 구성 과정에서 줄인 것)는 어느 절반이든 같은 입력을 보므로
              view와 무관하게 남는다. */}
          {((view !== "rules" && (model?.dropped.length || model?.failures.length))
            || answer.dropped.length) ? (
            <div className="finding-section">
              <h4>판정 범위</h4>
              {view !== "rules" && model && model.failures.length > 0 && (
                <div className="row-warn">
                  <strong>후보 {model.failures.flatMap((f) => f.candidates).length}건은 답을 받지 못했습니다.</strong>
                  <ul className="finding-list">
                    {model.failures.map((f) => (
                      <li key={f.batch}>{f.candidates.join(", ")}: {f.why}</li>
                    ))}
                  </ul>
                </div>
              )}
              {view !== "rules" && model && model.dropped.length > 0 && (
                <div className="row-warn">
                  <strong>모델 답변 {model.dropped.length}건을 검증에서 버렸습니다.</strong>
                  <ul className="finding-list">
                    {model.dropped.map((d) => <li key={d.id}>{d.id}: {d.why}</li>)}
                  </ul>
                </div>
              )}
              {(answer.actions_unclassified ?? 0) > 0 && (
                <div className="row-warn">
                  <strong>
                    변경 동작 {answer.actions_unclassified}개를 분류하지 못했습니다.
                  </strong>
                  <p className="small">
                    선별표에도 없고, 평가서의 참조표도 무엇인지 말하지 못하고, 알려진 동사로도
                    읽히지 않는 동작입니다. 어떤 공격 경로 간선에도 닿지 않으므로 <strong>후보가
                    만들어지지 않고 모델에게 질문되지도 않았습니다.</strong> 위험하지 않다는 뜻이
                    아니라 판정 대상에 들지 못했다는 뜻입니다.
                  </p>
                  {(answer.actions_unclassified_sample ?? []).length > 0 && (
                    <ul className="finding-list">
                      {answer.actions_unclassified_sample!.map((a) => (
                        <li key={a}><code>{a}</code></li>
                      ))}
                      {answer.actions_unclassified! > answer.actions_unclassified_sample!.length && (
                        <li className="muted">
                          표본입니다 — {answer.actions_unclassified}개 중{" "}
                          {answer.actions_unclassified_sample!.length}개만 표시합니다.
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}
              {Object.keys(answer.types_unknown ?? {}).length > 0 && (
                <div className="row-warn">
                  <strong>
                    열거된 자원 유형 {Object.keys(answer.types_unknown!).length}종을 동작 표가 해석하지
                    못해 제외했습니다.
                  </strong>
                  <p className="small">
                    AWS는 같은 ARN을 두 어휘로 부른다 — 동작 표는 레퍼런스의 이름을, 인벤토리는
                    인덱스의 이름을 쓴다. 여기 있는 유형은 어느 쪽으로도 잇지 못한 것이고, 그만큼의
                    자원이 아래 어느 목록에도 <strong>없다.</strong>
                  </p>
                  <ul className="finding-list">
                    {Object.entries(answer.types_unknown!).map(([type, count]) => (
                      <li key={type}><code>{type}</code> {count}개</li>
                    ))}
                  </ul>
                </div>
              )}
              {answer.dropped.length > 0 && (
                <details>
                  <summary className="muted small">
                    질의를 만들면서 줄인 것 {answer.dropped.length}건
                  </summary>
                  <ul className="finding-list">
                    {answer.dropped.map((d) => (
                      <li key={d.what}>
                        {d.what} {d.count}건 — {d.why}
                        {d.recoverable ? "" : " (복원 불가)"}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ) : null}
        </>
      )}

      {blocking && assessment && policyOf(blocking) && (
        <BlockPath
          finding={blocking}
          policy={policyOf(blocking)!}
          protectedActions={assessment.protected_actions}
          reference={assessment.action_reference ?? null}
          restrictions={restrictions}
          onChange={onRestrictions}
          onClose={() => setBlocking(null)}
        />
      )}
    </section>
  );
}

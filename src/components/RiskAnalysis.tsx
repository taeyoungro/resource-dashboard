import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  AssetGrade, Finding, FindingCategory, FindingStatus, Grade, RiskAnalysisAnswer,
  RiskAnalysisCitation,
} from "../types";

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

interface Props {
  planId: string;
  /** Whether an assessment exists at all. Without one there is nothing to analyse. */
  ready: boolean;
  /** Raised whenever an answer arrives, so a decision can cite the analysis it was taken against. */
  onAnalysis: (citation: RiskAnalysisCitation | null) => void;
}

const GRADE_ORDER: Record<Grade, number> = {
  CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NONE: 4,
};
const STATUS_ORDER: Record<FindingStatus, number> = {
  CONFIRMED: 0, UNVERIFIED: 1, NOT_ASSESSABLE: 2,
};
const SECTIONS: { category: FindingCategory; label: string; why: string }[] = [
  { category: "ESCALATION", label: "권한 상승",
    why: "다른 권한을 얻는 경로. 자원이 무엇이든 동작 조합만으로 성립한다" },
  { category: "EXPOSURE", label: "노출",
    why: "내용이 밖으로 나가거나 외부에서 닿을 수 있게 되는 경로" },
  { category: "RECON", label: "정찰",
    why: "무엇이 있는지 읽을 수 있는 경로. 이 목록은 정책 축소로 막을 수 없다" },
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
    return (
      <div className="finding-row muted">
        대상 없음 — 존재하는 자원에 닿는 경로가 아니라 <strong>부여된 능력</strong>입니다. 해당
        유형의 자원이 아직 없어도 성립합니다.
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
function Card({ finding }: { finding: Finding }) {
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

      {finding.relatedTo.length > 0 && (
        <div className="finding-row">
          <span className="finding-label">연결</span>
          <span>
            {finding.relatedTo.join(", ")} 과 같은 정책에서 함께 성립합니다.
          </span>
        </div>
      )}

      {finding.truncated !== false && (
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

function Summary({ answer, findings }: { answer: RiskAnalysisAnswer; findings: Finding[] }) {
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
        규칙 {answer.rule_findings.length}건
        {model ? ` · 모델 판정 ${model.findings.length}건 (후보 ${model.candidates}건 중)` : ""}
        {/* 두 절반이 같은 자료를 읽으므로 겹친다. 겹친 수를 적지 않으면 위 숫자들의 합이 서로 다른
            경로의 수로 읽힌다. */}
        {model && (answer.candidates_covered_by_rules ?? 0) > 0
          ? ` · 그중 ${answer.candidates_covered_by_rules}건은 규칙이 이미 찾은 경로`
          : ""}
        {" · "}질의 크기 {(answer.digest_bytes / 1024).toFixed(1)} KB
        {" · "}규칙 <code>{answer.rules_sha256.slice(0, 12)}</code>
        {model ? <> · 모델 <code>{model.model_id}</code> · 프롬프트 <code>{model.prompt_version}</code></> : null}
      </div>
    </div>
  );
}

/** How often the page asks how the model half is going. */
const POLL_MS = 3000;

export function RiskAnalysis({ planId, ready, onAnalysis }: Props) {
  const [answer, setAnswer] = useState<RiskAnalysisAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setBusy(false);
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
        setBusy(false);
        if (next.run?.state === "failed") {
          setError(next.run.error ?? "분석 실행이 끝나지 못했습니다.");
          setAnswer((prev) => (prev ? { ...prev, run: next.run } : prev));
          return;
        }
        settle(next);
      } catch (e) {
        if (polling.current.stopped) return;
        setBusy(false);
        setError((e as Error).message);
      }
    }, POLL_MS);
  };

  const run = async () => {
    stopPolling();
    polling.current.stopped = false;
    setBusy(true);
    setError(null);
    try {
      const next = await api.analyse(planId);
      if (polling.current.stopped) return;
      // The rules are finished before this returns, so they go up now rather than after the model.
      // On a real assessment that is the difference between reading twelve findings immediately and
      // staring at a spinner for the minutes the model takes.
      setAnswer(next);
      onAnalysis(null);
      if (next.run?.state === "running") {
        poll();
        return;
      }
      setBusy(false);
      settle(next);
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
      setAnswer(null);
      onAnalysis(null);
    }
  };

  if (!ready) {
    return (
      <div className="notice">
        위험 분석은 영향도 평가를 입력으로 씁니다. 평가가 없으면 분석할 것이 없습니다.
      </div>
    );
  }

  const model = answer?.analysis ?? null;
  const all = answer ? [...answer.rule_findings, ...(model?.findings ?? [])].sort(compare) : [];
  const assessable = all.filter((f) => f.status !== "NOT_ASSESSABLE");
  const unassessable = all.filter((f) => f.status === "NOT_ASSESSABLE");

  return (
    <section className="impact">
      <h3>위험 및 공격 경로</h3>
      <div className="row">
        <button onClick={run} disabled={busy}>
          {busy ? "분석 중…" : answer ? "다시 분석" : "위험 분석 실행"}
        </button>
        <span className="muted small">
          규칙 판정은 결정론이고 언제나 같은 답을 냅니다. 모델은 코드가 제안한 후보 경로만 판정하며,
          경로를 새로 만들지 않습니다.
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {/* 규칙 판정은 이미 아래에 떠 있다. 이 줄은 모델 절반이 아직 오는 중이라는 사실만 말한다 —
          없으면 화면이 "모델이 아무것도 찾지 못했다"와 구분되지 않는다. */}
      {answer?.run?.state === "running" && (
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

      {answer && (
        <>
          {answer.analysis_error && (
            <div className="notice">
              <strong>규칙 판정만 표시합니다.</strong> {answer.analysis_error}
            </div>
          )}

          {model?.discarded && (
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

          <Summary answer={answer} findings={all} />

          {all.length === 0 && (
            <div className="empty">
              발화한 규칙이 없고 모델이 인정한 경로도 없습니다. 아래 <strong>판정 범위</strong>를
              함께 읽으십시오 — 열거가 불완전하면 이 결과도 불완전합니다.
            </div>
          )}

          {SECTIONS.map(({ category, label, why }) => {
            const items = assessable.filter((f) => f.category === category);
            if (items.length === 0) return null;
            return (
              <div className="finding-section" key={category}>
                <h4>
                  {label} <span className="muted small">{items.length}건 — {why}</span>
                </h4>
                {items.map((f) => <Card key={`${f.policyId}:${f.id}:${f.source ?? "rule"}`} finding={f} />)}
              </div>
            );
          })}

          {unassessable.length > 0 && (
            <div className="finding-section">
              <h4>
                평가 불가 <span className="muted small">
                  {unassessable.length}건 — 근거가 판정을 확정하지 못했습니다. 없다는 뜻이 아닙니다
                </span>
              </h4>
              {unassessable.map((f) => (
                <Card key={`${f.policyId}:${f.id}:${f.source ?? "rule"}`} finding={f} />
              ))}
            </div>
          )}

          {model && model.rejected.length > 0 && (
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

          {/* 판정 범위. 결과가 아니라 결과를 어디까지 믿을 수 있는지에 대한 것이므로 접지 않는다. */}
          {(model?.dropped.length || model?.failures.length || answer.dropped.length) ? (
            <div className="finding-section">
              <h4>판정 범위</h4>
              {model && model.failures.length > 0 && (
                <div className="row-warn">
                  <strong>후보 {model.failures.flatMap((f) => f.candidates).length}건은 답을 받지 못했습니다.</strong>
                  <ul className="finding-list">
                    {model.failures.map((f) => (
                      <li key={f.batch}>{f.candidates.join(", ")}: {f.why}</li>
                    ))}
                  </ul>
                </div>
              )}
              {model && model.dropped.length > 0 && (
                <div className="row-warn">
                  <strong>모델 답변 {model.dropped.length}건을 검증에서 버렸습니다.</strong>
                  <ul className="finding-list">
                    {model.dropped.map((d) => <li key={d.id}>{d.id}: {d.why}</li>)}
                  </ul>
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
    </section>
  );
}

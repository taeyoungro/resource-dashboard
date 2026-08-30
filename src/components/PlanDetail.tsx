import { useEffect, useMemo, useState } from "react";
import type {
  AssessmentState, Impact as Assessment, PlanDetail as Detail, PlanRefusal, Restriction,
  RestrictionTemplate, RiskAnalysisCitation,
} from "../types";
import { mergeTemplate, seedFromTemplate } from "../../server/templates.js";
import { Impact } from "./Impact";
import { RiskAnalysis } from "./RiskAnalysis";
import { clock } from "../time";

interface Props {
  detail: Detail;
  decided: boolean;
  busy: boolean;
  /** From the sweep, so the page can tell "still assessing" from "no assessment". */
  assessmentState: AssessmentState | null;
  /**
   * Which question this panel answers about the plan. Chosen on the row in the list, and kept here
   * rather than inside this component so that selecting a different plan can reset it - a view that
   * survived the selection would open one resource on another's question.
   */
  view: "assessment" | "passrole";
  onView: (view: "assessment" | "passrole") => void;
  /** IAM actions per service, so the restriction picker offers a list instead of asking for typing. */
  onDecide: (
    decision: "approve" | "deny",
    reviewer: string,
    comment: string,
    restrictions: Restriction[],
    passroleGrantTo: string[],
    passroleRevokeFrom: string[],
    analysis: RiskAnalysisCitation | null,
  ) => void;
}

const actionClass = (actions: string[]) => {
  if (actions.includes("delete")) return "badge badge-danger";
  if (actions.includes("update")) return "badge badge-warn";
  return "badge badge-ok";
};

/**
 * The PassRole requests on this plan, and the one place they can be confirmed.
 *
 * Deliberately its own section, below what the plan changes and above the plan text. A request is
 * not part of the plan's diff - tagging a role changes no resource, only the outputs that carry the
 * ask - so folding it into 바뀌는 것 would file an escalation under "nothing changed".
 *
 * What this screen may and may not do
 * -----------------------------------
 * It sends NAMES. Which role and which services the grant is conditioned on are read by the applier
 * from the plan's own outputs, exactly as a restriction travels as decisions rather than as a
 * policy document. This tier does not author IAM content, so the worst a defect here can do is
 * confirm the wrong person - and the applier checks each name against the requests the inspector
 * read off the source role, so even that is bounded.
 */
function PassroleRequests({ detail, confirmed, onConfirmed, withdrawn, onWithdrawn, disabled }: {
  detail: Detail;
  confirmed: string[];
  onConfirmed: (names: string[]) => void;
  withdrawn: string[];
  onWithdrawn: (names: string[]) => void;
  disabled: boolean;
}) {
  const requests = detail.passrole?.requested_by ?? [];
  if (requests.length === 0) return null;

  const services = detail.passrole?.services ?? [];
  // No service means no grant can be written: the condition would have to be invented, and an
  // unconditioned PassRole allows passing the role to anything. The applier refuses it and so does
  // the decision route, so the boxes are disabled rather than offered and then rejected.
  const grantable = services.length > 0;

  // Three answers, not two, and the third is not the absence of the first. Leaving somebody
  // unticked removes nothing - the writer keeps every grant a decision does not name - so taking
  // one back has to be said out loud. Withdrawing stays available when granting is not: a role
  // whose trust policy lost its services is exactly one whose grants should come off.
  const setChoice = (name: string, choice: "grant" | "none" | "revoke") => {
    onConfirmed(choice === "grant"
      ? [...confirmed.filter((n) => n !== name), name].sort()
      : confirmed.filter((n) => n !== name));
    onWithdrawn(choice === "revoke"
      ? [...withdrawn.filter((n) => n !== name), name].sort()
      : withdrawn.filter((n) => n !== name));
  };
  const choiceOf = (name: string): "grant" | "none" | "revoke" => {
    if (confirmed.includes(name)) return "grant";
    if (withdrawn.includes(name)) return "revoke";
    return "none";
  };

  return (
    <>
      <h3>
        PassRole 요청 <span className="muted small">{requests.length}건</span>
      </h3>
      <p className="muted small">
        이 역할을 서비스에 넘길 수 있게 해 달라는 요청입니다. 원본 역할에{" "}
        <code>&lt;사용자 이름&gt; = passrole</code> 태그를 붙여 요청합니다.{" "}
        <strong>요청은 아무것도 부여하지 않습니다</strong> — 계획을 승인하는 것과 부여하는 것은
        별개의 결정이고, 아래에서 이름을 고른 사람에게만 부여됩니다.
      </p>

      {!grantable && (
        <div className="warn-inline">
          이 역할의 신뢰 정책이 어떤 서비스도 맡기지 않습니다. 조건 없는 PassRole 은 역할을
          아무 서비스에나 넘길 수 있게 하므로, 부여할 수 없습니다. 원본 역할의 신뢰 정책을 먼저
          고치십시오.
        </div>
      )}

      <p className="muted small">
        <strong>고르지 않은 것은 회수가 아닙니다.</strong> 이미 부여된 권한은 그대로 남습니다 —
        지난번에 부여받은 사람을 이번에 고르지 않았다고 해서 그 사람의 권한이 사라지지는 않습니다.
        되돌리려면 <strong>회수</strong>를 골라야 합니다.
      </p>

      <table className="policy-table">
        <thead>
          <tr>
            <th>결정</th>
            <th>요청한 사람</th>
            <th>넘길 수 있게 되는 서비스</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((name) => (
            <tr key={name}>
              <td>
                <select
                  value={choiceOf(name)}
                  disabled={disabled}
                  onChange={(e) =>
                    setChoice(name, e.target.value as "grant" | "none" | "revoke")}
                >
                  <option value="none">그대로 두기</option>
                  <option value="grant" disabled={!grantable}>부여</option>
                  <option value="revoke">회수</option>
                </select>
              </td>
              <td><code>{name}</code></td>
              <td className="finding-actions">
                {services.length === 0
                  ? <span className="muted">없음</span>
                  : services.map((s) => <code key={s}>{s}</code>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted small">
        태그를 이미 뗀 사람은 이 목록에 없고, 그 사람의 권한은 여기서 회수할 수 없습니다. 화면은
        권한 세트의 인라인 정책을 읽지 못하므로 — 읽을 권한을 갖지 않는 것이 설계입니다 — 지금
        누구에게 부여되어 있는지 알 수 있는 곳이 없습니다. 태그와 실제 부여를 대조하는 주기 대사가
        아직 없어서 생기는 공백입니다.
      </p>

      <p className="muted small">
        부여 대상:{" "}
        {detail.passrole?.target_arn
          ? <code>{detail.passrole.target_arn}</code>
          : <span>이 계획이 만드는 역할입니다 — 적용 전에는 ARN 이 정해지지 않습니다.</span>}
        {" "}문장은 요청한 사람의 권한 세트 인라인 정책에 들어가며,{" "}
        <code>iam:PassedToService</code> 조건으로 위 서비스에 묶입니다.
      </p>
    </>
  );
}

export function PlanDetail({
  detail, decided, busy, assessmentState, view, onView, onDecide,
}: Props) {
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);
  const [analysis, setAnalysis] = useState<RiskAnalysisCitation | null>(null);
  // Whose PassRole request this approver has ticked. Nobody, until somebody is.
  const [grantTo, setGrantTo] = useState<string[]>([]);
  // And whose this approver has taken back. Separate state, because it is not the complement of the
  // one above - most people are in neither, and leaving somebody out of both changes nothing.
  const [revokeFrom, setRevokeFrom] = useState<string[]>([]);

  // Dropped when the plan changes, and that is the whole reason it is state here rather than inside
  // the analysis panel. The citation names an assessment digest; carrying one from the previous plan
  // into this decision would be citing an analysis of something else, which the server would refuse
  // - correctly, but after the reviewer had already pressed the button.
  useEffect(() => { setAnalysis(null); }, [detail.plan_id, detail.request_id]);
  // Dropped with the plan, for a harder reason than the citation above: a name carried over from a
  // previous inspection would confirm a request that inspection recorded and this one may not. The
  // server and the applier both refuse that, but only after the button was pressed.
  useEffect(() => { setGrantTo([]); setRevokeFrom([]); }, [detail.plan_id, detail.request_id]);

  const submit = (decision: "approve" | "deny") => {
    if (!reviewer.trim()) {
      window.alert("검토자 이름을 입력하세요.");
      return;
    }
    if (decision === "deny" && !comment.trim()) {
      window.alert("거부에는 사유가 필요합니다. 변경을 요청한 사람이 읽을 것은 이것뿐입니다.");
      return;
    }
    const active = decision === "approve" ? restrictions.filter((r) => r.actions.length > 0) : [];
    if (decision === "approve" && restrictions.length > active.length) {
      window.alert("동작을 고르지 않은 제한이 있습니다. 지우거나 동작을 고르세요.");
      return;
    }
    const granting = decision === "approve" ? grantTo : [];
    // A withdrawal rides on the apply that follows an approval. A denied plan applies nothing, so
    // there is no run to carry it - the server refuses that pairing and so does this.
    const withdrawing = decision === "approve" ? revokeFrom : [];
    const what = detail.resource ?? detail.plan_id;
    const suffix = active.length > 0 ? ` 제한 ${active.length}건과 함께` : "";
    // Named separately in the confirmation, because it is a separate act. Approving the plan and
    // granting somebody the ability to pass the role are different decisions, and a reviewer who
    // reads only this line has to see both.
    const grants = granting.length > 0
      ? `\n\n그리고 ${granting.join(", ")} 에게 이 역할의 PassRole 을 부여합니다.`
      : "";
    const revokes = withdrawing.length > 0
      ? `\n\n그리고 ${withdrawing.join(", ")} 에게서 이 역할의 PassRole 을 회수합니다.`
      : "";
    if (
      !window.confirm(
        `${what} 를${suffix} ${decision === "approve" ? "승인" : "거부"}합니다.${grants}${revokes}`)
    ) {
      return;
    }
    onDecide(decision, reviewer.trim(), comment.trim(), active, granting, withdrawing, analysis);
  };

  return (
    <div className="detail">
      <h2>{detail.resource ?? detail.plan_id}</h2>
      <div className="meta">
        <span>계정: {detail.account_id ?? "—"}</span>
        {/* Which inspection produced the plan currently stored. Not part of the key - the key is
            the governed resource - but it is what the approval marker gets named by. */}
        <span>요청: {detail.request_id ?? "—"}</span>
        <span>
          계획 시각: {detail.planned_at ? clock(detail.planned_at) : "—"}
        </span>
      </div>

      {/* Two questions about one resource, and the answer to one is not the answer to the other.
          Only offered where there is a PassRole request - a tab that opens an empty panel is a tab
          people learn to ignore. */}
      {(detail.passrole?.requested_by ?? []).length > 0 && (
        <div className="tabs detail-tabs">
          <button
            type="button"
            className={view === "assessment" ? "tab active" : "tab"}
            onClick={() => onView("assessment")}
          >
            영향도 · 위험 분석
          </button>
          <button
            type="button"
            className={view === "passrole" ? "tab active" : "tab"}
            onClick={() => onView("passrole")}
          >
            PassRole 요청 {detail.passrole.requested_by.length}
          </button>
        </div>
      )}

      {/* First on the page and above everything, because it outranks everything: it says the last
          thing that happened to this resource was a refusal, and until it existed that sentence
          lived only in the container's log. */}
      {detail.refusal && <RefusalNotice refusal={detail.refusal} planStored={detail.plan_stored} />}

      {/* Nothing below this line applies to a resource that has never been planned. The assessment
          notice, the empty change table, the plan pane and the decision form would each describe an
          absent plan as if it were an unremarkable one - and the decision form would offer buttons
          the server refuses. The reason above is the whole page. */}
      {!detail.plan_stored && detail.refusal ? null : (
      <>

      {/* The assessment, or what is happening instead of one.
          Approval is never blocked on this: a plan can be approved with no assessment at all, and
          making the decision path depend on the querier would turn an assessment outage into a
          pipeline outage. What is unavailable without one is the RESTRICTION - it names resources,
          and the enumerated set is the only fence those names can be checked against. */}
      {view === "passrole" ? null : detail.assessment ? (
        <>
          <RestrictionTemplates
            assessment={detail.assessment}
            disabled={busy || decided}
            onApply={(seeded) => setRestrictions((current) => mergeTemplate(current, seeded))}
          />
          <Impact
            assessment={detail.assessment}
            source={detail.assessment_source}
            restrictions={restrictions}
            onChange={setRestrictions}
            disabled={busy || decided}
          />
        </>
      ) : assessmentState === "in_progress" ? (
        <div className="notice">
          <strong>영향도 평가가 진행 중입니다.</strong> 이 계획은 지금도 승인할 수 있습니다 — 다만
          제한을 걸려면 평가가 끝나야 합니다. 평가가 끝나면 이 화면에 나타납니다.
        </div>
      ) : (
        <div className="notice">
          이 계획에는 영향도 평가가 없습니다. 승인은 가능하지만 <strong>제한은 걸 수 없습니다</strong> —
          제한은 자원을 지목하고, 그 이름을 대조할 근거가 평가뿐입니다.
        </div>
      )}

      {/* The findings. Below the assessment because it reads the assessment, and above the plan
          because a grade an approver has not seen yet is worth more than terraform's own output,
          which they will read next either way. */}
      {view === "passrole" ? null : (
      <RiskAnalysis
        planId={detail.plan_id}
        ready={!!detail.assessment}
        onAnalysis={setAnalysis}
        assessment={detail.assessment ?? null}
        restrictions={restrictions}
        onRestrictions={setRestrictions}
        restrictDisabled={busy || decided}
      />
      )}

      {/* What the plan does, and terraform's own words for it. On the PassRole view neither is the
          question - the plan that carries a request moves no resource, so the change table would
          read "변경 없음" over a screen that is entirely about a change of permission. */}
      {view === "passrole" ? null : (
      <>
      <h3>바뀌는 것</h3>
      {detail.changes.length === 0 ? (
        <div className="empty">
          변경 없음. 트윈이 이미 spec과 일치하므로 결정할 것이 없습니다. 이 계획이 저장된 이유는
          앞의 계획을 덮기 위해서입니다 — 건너뛰었다면 이미 되돌린 수정을 승인할 수 있는 계획이
          그대로 남았을 것입니다.
        </div>
      ) : (
        <table className="policy-table">
          <thead>
            <tr>
              <th>동작</th>
              <th>주소</th>
              <th>유형</th>
            </tr>
          </thead>
          <tbody>
            {detail.changes.map((c) => (
              <tr key={c.address}>
                <td>
                  <span className={actionClass(c.actions)}>{c.actions.join("+")}</span>
                </td>
                <td>{c.address}</td>
                <td className="muted">{c.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>terraform plan</h3>
      <pre className="plan">{detail.plan_text || "plan.txt 가 없습니다."}</pre>

      <details>
        <summary>생성된 구성 (main.tf.json)</summary>
        <pre className="plan">{detail.config_json || "main.tf.json 이 없습니다."}</pre>
      </details>
      </>
      )}

      {/* The other question. Always rendered on its own view; never on the assessment one, where a
          confirmation sitting under a restriction picker reads as part of the same decision. */}
      {view === "passrole" && (
        <PassroleRequests
          detail={detail}
          confirmed={grantTo}
          onConfirmed={setGrantTo}
          withdrawn={revokeFrom}
          onWithdrawn={setRevokeFrom}
          disabled={busy || decided}
        />
      )}

      {/* Both values go into the marker and both are checked before anything is applied. Worth
          being able to read them here: if a decision is ever disputed, these are what the applier
          compared against. The first is the file itself, the second is what it will do. */}
      <div className="meta small">
        tfplan sha256: <code>{detail.plan_file_sha256 ?? "계산할 수 없음"}</code>
        {detail.plan_bytes !== null ? ` · ${detail.plan_bytes} bytes` : ""}
      </div>
      <div className="meta small">
        변경 다이제스트: <code>{detail.changes_sha256 ?? "없음"}</code>
      </div>

      {detail.changes_sha256 ? null : (
        <div className="row-warn">
          이 계획에는 <code>changes.sha256</code>이 없어 <strong>승인할 수 없습니다.</strong> 그
          값을 쓰지 않던 검사기가 만든 계획입니다. 계획 접두사는 객체 다섯 개이고, 일부만 덮어써지면
          한 계획의 <code>tfplan</code> 옆에 다른 계획의 <code>plan.txt</code>가 남을 수 있습니다.
          그 다이제스트가 있어야 적용기가 <code>terraform show</code>로 위에 보이는 설명이 실제
          적용할 파일을 설명하는지 확인합니다. 자원을 다시 변경해 새 계획을 받으면 됩니다.
        </div>
      )}

      {detail.outcome ? (
        <div className="row-warn">
          {/* Terminal. The applier has finished with this plan and outcome.json records what it
              did - which is also the surviving copy of the decision, since the approval marker is
              deleted once this is written. */}
          <strong>
            {detail.outcome.applied ? "적용 완료" : "적용하지 않고 종료"}
          </strong>
          {" — "}
          {detail.outcome.reviewer ?? "검토자 미상"}
          {detail.outcome.decision === "deny" ? " 이(가) 거부했습니다." : " 의 승인."}
          {detail.outcome.finished_at
            ? ` (${clock(detail.outcome.finished_at)})`
            : ""}
          {detail.outcome.detail ? <pre className="plan">{detail.outcome.detail}</pre> : null}
          다시 결정하려면 자원을 변경해 새 계획을 받으십시오.
        </div>
      ) : null}

      {decided && !detail.outcome ? (
        <div className="row-warn">
          이 요청에는 이미 결정이 기록되어 있고 적용기가 아직 끝내지 않았습니다. 다시 결정하면
          기록을 덮어씁니다.
        </div>
      ) : null}

      <div className="decision">
        <div className="row">
          <input
            placeholder="검토자 (기록에 그대로 남습니다)"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          />
        </div>
        <textarea
          placeholder="사유 — 거부할 때는 필수"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="actions">
          {/* Approving is disabled when the server would refuse it - no digest to bind the
              decision to, or nothing for the applier to do. Offering a button that always fails is
              worse than not offering one. Denying stays available: a plan nobody can approve is
              exactly one somebody may want to refuse. */}
          <button
            className="btn-approve"
            disabled={busy || !detail.changes_sha256 || !detail.has_changes || !!detail.outcome}
            onClick={() => submit("approve")}
          >
            승인
          </button>
          <button
            className="btn-deny"
            disabled={busy || !!detail.outcome}
            onClick={() => submit("deny")}
          >
            거부
          </button>
        </div>
        <div className="meta small muted">
          승인은 <code>applier/{detail.request_id}.json</code> 객체 하나를 쓰는 것이 전부입니다.
          적용기를 직접 실행하지 않습니다 — 이 화면은 <code>ecs:RunTask</code> 권한을 갖지
          않습니다.
        </div>
      </div>

      </>
      )}
    </div>
  );
}

/**
 * Why the last inspection produced no plan.
 *
 * The observed silence this ends: a spec role carrying twelve managed policies was refused because
 * a permission set may hold ten. The run had genuinely completed, so its marker was deleted, so the
 * request left no row, no failure and no plan - the reason existed in the container's log and
 * nowhere the administrator who made the edit would ever look. Their side of it was that they
 * changed something and nothing happened.
 *
 * The reason is printed verbatim and never summarised into a category. "12 managed policies
 * including the baseline, and the limit is 10" tells somebody to remove two; a category would tell
 * them to go and read the log, which is where this started.
 *
 * Two shapes, because they ask for different things:
 *
 *   no plan stored     the first inspection of this resource refused. There is nothing to decide
 *                      and nothing else on the page
 *   plan stored        a plan is here and this refusal is NEWER than it. The plan is real and
 *                      approvable and describes an EARLIER version of the resource, which is the
 *                      part nothing said before
 */
function RefusalNotice({ refusal, planStored }: { refusal: PlanRefusal; planStored: boolean }) {
  return (
    <div className="refusal">
      <strong>
        {planStored
          ? "마지막 검사가 거부되어 이 계획은 최신이 아닙니다."
          : "이 자원의 검사가 거부되어 계획이 만들어지지 않았습니다."}
      </strong>
      {/* The sentence the container wrote, unchanged. */}
      <pre className="plan">{refusal.reason}</pre>
      <div className="meta small">
        <span>거부 시각: {refusal.refused_at ? clock(refusal.refused_at) : "—"}</span>
        <span>요청: {refusal.request_id ?? "—"}</span>
        {refusal.kind && <span>유형: {refusal.kind}</span>}
      </div>
      {planStored ? (
        <p>
          아래 계획은 그 이전 검사가 만든 것이고 지금의 자원을 설명하지 않습니다. 그대로 승인할 수는
          있으나, 승인하면 거부된 검사 이전의 spec이 적용됩니다. 위 사유가 가리키는 것을 고치고 자원을
          다시 변경하면 검사가 다시 돌아가고, 그때 만들어지는 계획이 이 계획을 덮습니다.
        </p>
      ) : (
        <p>
          결정할 것이 없습니다 — 승인하거나 거부할 계획 자체가 없습니다. 위 사유가 가리키는 것을
          고치고 자원을 다시 변경하십시오. 다음 검사가 계획을 만들면 이 자리에 나타납니다.
        </p>
      )}
    </div>
  );
}

/**
 * The decisions an organisation made once, offered as a pre-filled form.
 *
 * Deliberately not a policy installed anywhere. A template seeds the restriction array the approver
 * is already looking at - they see it, edit it, and approve it for THIS plan - so every gate the
 * route and the inline writer hold still runs, unchanged, on an ordinary decision with a reviewer
 * and a comment and an assessment digest behind it. server/templates.js records why the other shape
 * was refused.
 *
 * Above the editor because it fills the editor in, and what it drops is said before the button is
 * pressed: an action no attached policy grants cannot be restricted, and a template that quietly
 * shrank would read as a control that was fully applied.
 */
function RestrictionTemplates({ assessment, disabled, onApply }: {
  assessment: Assessment;
  disabled: boolean;
  onApply: (seeded: Restriction[]) => void;
}) {
  const [templates, setTemplates] = useState<RestrictionTemplate[]>([]);
  const [applied, setApplied] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((body) => { if (live) setTemplates(body.templates ?? []); })
      .catch(() => { if (live) setTemplates([]); });
    return () => { live = false; };
  }, []);

  // Recomputed per template because what survives depends on THIS assessment's grants.
  const seeded = useMemo(
    () => templates.map((template) => ({ template, ...seedFromTemplate(template, assessment) })),
    [templates, assessment],
  );
  if (seeded.length === 0) return null;

  return (
    <details className="templates">
      <summary>표준 제한 적용 ({seeded.length}개)</summary>
      <p className="muted small">
        조직이 한 번 정해 둔 결정이다. 누르면 아래 편집기가 채워질 뿐이고, 승인은 여전히 이 계획에
        대한 결정으로 나간다 — 고치고 빼는 것도 그대로 된다.
      </p>
      {seeded.map(({ template, restrictions, dropped }) => (
        <div key={template.id} className="template-row">
          <div className="control-row">
            <span className="section-name">{template.title}</span>
            <button
              type="button"
              disabled={disabled || restrictions.length === 0}
              onClick={() => { onApply(restrictions); setApplied((a) => [...a, template.id]); }}
            >
              {restrictions.length > 0 ? `제한 ${restrictions.length}건 채우기` : "적용할 것이 없다"}
            </button>
            {applied.includes(template.id) && <span className="rtype">채웠다</span>}
          </div>
          <p className="muted small">{template.why}</p>
          {dropped.length > 0 && (
            <p className="warn-inline">
              {dropped.length}개는 이 계획에 걸 수 없어 빠진다 —{" "}
              {dropped.slice(0, 4).map((d) => `${d.action}(${
                d.why === "protected" ? "선언 경로"
                  : d.why === "no_resource_tag" ? "태그를 읽지 않는 동작" : "부여되지 않음"})`)
                .join(", ")}
              {dropped.length > 4 && ` 외 ${dropped.length - 4}개`}
            </p>
          )}
        </div>
      ))}
    </details>
  );
}

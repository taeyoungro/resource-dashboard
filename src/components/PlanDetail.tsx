import { useState } from "react";
import type {
  AssessmentState, PlanDetail as Detail, Restriction,
} from "../types";
import { Impact } from "./Impact";

interface Props {
  detail: Detail;
  decided: boolean;
  busy: boolean;
  /** From the sweep, so the page can tell "still assessing" from "no assessment". */
  assessmentState: AssessmentState | null;
  /** IAM actions per service, so the restriction picker offers a list instead of asking for typing. */
  onDecide: (
    decision: "approve" | "deny",
    reviewer: string,
    comment: string,
    restrictions: Restriction[],
  ) => void;
}

const actionClass = (actions: string[]) => {
  if (actions.includes("delete")) return "badge badge-danger";
  if (actions.includes("update")) return "badge badge-warn";
  return "badge badge-ok";
};

export function PlanDetail({
  detail, decided, busy, assessmentState, onDecide,
}: Props) {
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);

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
    const what = detail.resource ?? detail.plan_id;
    const suffix = active.length > 0 ? ` 제한 ${active.length}건과 함께` : "";
    if (
      !window.confirm(`${what} 를${suffix} ${decision === "approve" ? "승인" : "거부"}합니다.`)
    ) {
      return;
    }
    onDecide(decision, reviewer.trim(), comment.trim(), active);
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
          계획 시각: {detail.planned_at ? new Date(detail.planned_at).toLocaleString() : "—"}
        </span>
      </div>

      {/* The assessment, or what is happening instead of one.
          Approval is never blocked on this: a plan can be approved with no assessment at all, and
          making the decision path depend on the querier would turn an assessment outage into a
          pipeline outage. What is unavailable without one is the RESTRICTION - it names resources,
          and the enumerated set is the only fence those names can be checked against. */}
      {detail.assessment ? (
        <Impact
          assessment={detail.assessment}
          source={detail.assessment_source}
          restrictions={restrictions}
          onChange={setRestrictions}
          disabled={busy || decided}
        />
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
            ? ` (${new Date(detail.outcome.finished_at).toLocaleString()})`
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
    </div>
  );
}

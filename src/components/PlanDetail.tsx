import { useState } from "react";
import type { PlanDetail as Detail } from "../types";

interface Props {
  detail: Detail;
  decided: boolean;
  busy: boolean;
  onDecide: (decision: "approve" | "deny", reviewer: string, comment: string) => void;
}

const actionClass = (actions: string[]) => {
  if (actions.includes("delete")) return "badge badge-danger";
  if (actions.includes("update")) return "badge badge-warn";
  return "badge badge-ok";
};

export function PlanDetail({ detail, decided, busy, onDecide }: Props) {
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");

  const submit = (decision: "approve" | "deny") => {
    if (!reviewer.trim()) {
      window.alert("검토자 이름을 입력하세요.");
      return;
    }
    if (decision === "deny" && !comment.trim()) {
      window.alert("거부에는 사유가 필요합니다. 변경을 요청한 사람이 읽을 것은 이것뿐입니다.");
      return;
    }
    const what = detail.resource ?? detail.request_id;
    if (!window.confirm(`${what} 를 ${decision === "approve" ? "승인" : "거부"}합니다.`)) return;
    onDecide(decision, reviewer.trim(), comment.trim());
  };

  return (
    <div className="detail">
      <h2>{detail.resource ?? detail.request_id}</h2>
      <div className="meta">
        <span>계정: {detail.account_id ?? "—"}</span>
        <span>요청: {detail.request_id}</span>
        <span>
          계획 시각: {detail.planned_at ? new Date(detail.planned_at).toLocaleString() : "—"}
        </span>
      </div>

      <h3>바뀌는 것</h3>
      {detail.changes.length === 0 ? (
        <div className="empty">변경 없음. 승인할 것이 없습니다.</div>
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

      {/* The digest is what the applier checks the plan against, so it is worth being able to
          read it here - if a decision is ever disputed, this is the value in the marker. */}
      <div className="meta small">
        tfplan sha256: <code>{detail.plan_sha256 ?? "계산할 수 없음"}</code>
        {detail.plan_bytes !== null ? ` · ${detail.plan_bytes} bytes` : ""}
      </div>

      {decided ? (
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
          <button className="btn-approve" disabled={busy} onClick={() => submit("approve")}>
            승인
          </button>
          <button className="btn-deny" disabled={busy} onClick={() => submit("deny")}>
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

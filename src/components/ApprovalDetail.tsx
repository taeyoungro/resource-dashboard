import { useState } from "react";
import type { ApprovalDetail as Detail } from "../types";

interface Props {
  detail: Detail;
  onDecide: (decision: "approve" | "deny", reviewer: string, comment: string) => Promise<void>;
  busy: boolean;
}

export function ApprovalDetail({ detail, onDecide, busy }: Props) {
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  const policyEntries = Object.entries(detail.policy_details ?? {});
  const disabled = busy || detail.status !== "pending" || reviewer.trim() === "";

  const submit = async (decision: "approve" | "deny") => {
    if (decision === "deny" && !comment.trim()) {
      alert("거부 시 사유(comment)를 입력해 주세요.");
      return;
    }
    await onDecide(decision, reviewer.trim(), comment.trim());
  };

  return (
    <div className="detail">
      <header>
        <h2>{detail.role_name}</h2>
        <div className="meta">
          <span>request_id: <code>{detail.request_id}</code></span>
          <span>account: {detail.account_id}</span>
          <span>action: {detail.action}</span>
          <span>requester: {detail.requester_iic_user ?? "—"}</span>
        </div>
        <div className="meta">
          <span>targets: {detail.target_accounts?.join(", ") || "—"}</span>
          <span>status: {detail.status}</span>
        </div>
      </header>

      <section>
        <h3>RAG Policy Analysis</h3>
        {policyEntries.length === 0 ? (
          <div className="empty small">정책 분석 결과 없음 (DELETE 요청일 수 있음).</div>
        ) : (
          <table className="policy-table">
            <thead>
              <tr>
                <th>Policy ARN</th>
                <th>Necessary</th>
                <th>Confidence</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {policyEntries.map(([arn, p]) => (
                <tr key={arn} className={p.is_necessary ? "" : "row-warn"}>
                  <td><code>{arn}</code></td>
                  <td>{p.is_necessary ? "✅" : "⚠️"}</td>
                  <td><span className={`conf conf-${String(p.confidence).toLowerCase()}`}>{p.confidence}</span></td>
                  <td>{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Approval Report</h3>
        <pre className="report">{detail.approval_report}</pre>
      </section>

      <section>
        <h3>Terraform Plan (tail)</h3>
        <pre className="plan">{detail.plan_tail}</pre>
      </section>

      <section className="decision">
        <h3>의사결정</h3>
        <div className="form-row">
          <label>
            Reviewer (IIC user)
            <input
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
              placeholder="admin@example.com"
              disabled={busy || detail.status !== "pending"}
            />
          </label>
          <label>
            Comment
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="필요 시 사유를 남기세요. 거부 시 필수."
              disabled={busy || detail.status !== "pending"}
            />
          </label>
        </div>
        <div className="actions">
          <button className="btn btn-approve" disabled={disabled} onClick={() => submit("approve")}>
            ✅ 승인 (Apply Terraform)
          </button>
          <button className="btn btn-deny" disabled={disabled} onClick={() => submit("deny")}>
            ❌ 거부
          </button>
        </div>
        {detail.status !== "pending" && (
          <div className="muted small">이미 처리된 요청입니다 (status: {detail.status}).</div>
        )}
      </section>
    </div>
  );
}

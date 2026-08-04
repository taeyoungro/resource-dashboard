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
    const what = detail.resource ?? detail.plan_id;
    if (!window.confirm(`${what} 를 ${decision === "approve" ? "승인" : "거부"}합니다.`)) return;
    onDecide(decision, reviewer.trim(), comment.trim());
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
          {/* Approving is disabled when the server would refuse it - no digest to bind the
              decision to, or nothing for the applier to do. Offering a button that always fails is
              worse than not offering one. Denying stays available: a plan nobody can approve is
              exactly one somebody may want to refuse. */}
          <button
            className="btn-approve"
            disabled={busy || !detail.changes_sha256 || !detail.has_changes}
            onClick={() => submit("approve")}
          >
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

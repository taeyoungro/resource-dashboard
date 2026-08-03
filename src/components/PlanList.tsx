import type { PlanSummary } from "../types";

interface Props {
  items: PlanSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const stateBadge = (s: PlanSummary["state"]) =>
  s === "awaiting_decision" ? (
    <span className="badge badge-warn">결정 대기</span>
  ) : (
    <span className="badge badge-ok">적용기로 넘어감</span>
  );

export function PlanList({ items, selectedId, onSelect }: Props) {
  if (items.length === 0) {
    return <div className="empty">저장된 계획이 없습니다.</div>;
  }
  return (
    <ul className="approval-list">
      {items.map((it) => (
        <li
          key={it.request_id}
          className={it.request_id === selectedId ? "selected" : ""}
          onClick={() => onSelect(it.request_id)}
        >
          <div className="row">{stateBadge(it.state)}</div>
          {/* The resource, not the request id. The id stopped carrying the name when it had to
              fit in 36 characters of startedBy, so it is the account and a digest and nothing a
              person recognises. */}
          <div className="role-name">{it.resource ?? "(이름을 읽지 못함)"}</div>
          <div className="meta">
            <span>계정: {it.account_id ?? "—"}</span>
          </div>
          <div className="meta small">
            {it.planned_at ? new Date(it.planned_at).toLocaleString() : "시각 없음"}
          </div>
        </li>
      ))}
    </ul>
  );
}

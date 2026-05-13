import type { ApprovalSummary } from "../types";

interface Props {
  items: ApprovalSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const actionBadge = (a: ApprovalSummary["action"]) => {
  const cls = a === "DELETE" ? "badge badge-danger" : a === "REFRESH" ? "badge badge-warn" : "badge badge-ok";
  return <span className={cls}>{a}</span>;
};

const statusBadge = (s: ApprovalSummary["status"]) => <span className={`badge status-${s}`}>{s}</span>;

export function ApprovalList({ items, selectedId, onSelect }: Props) {
  if (items.length === 0) {
    return <div className="empty">대기 중인 승인 요청이 없습니다.</div>;
  }
  return (
    <ul className="approval-list">
      {items.map((it) => (
        <li
          key={it.request_id}
          className={it.request_id === selectedId ? "selected" : ""}
          onClick={() => onSelect(it.request_id)}
        >
          <div className="row">
            {actionBadge(it.action)}
            {statusBadge(it.status)}
          </div>
          <div className="role-name">{it.role_name}</div>
          <div className="meta">
            <span>account: {it.account_id}</span>
            <span>by: {it.requester_iic_user ?? "—"}</span>
          </div>
          <div className="meta small">{new Date(it.last_event_at).toLocaleString()}</div>
        </li>
      ))}
    </ul>
  );
}

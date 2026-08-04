import type { PlanSummary } from "../types";

interface Props {
  items: PlanSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const stateBadge = (s: PlanSummary["state"]) => {
  if (s === "awaiting_decision") return <span className="badge badge-warn">결정 대기</span>;
  if (s === "decided") return <span className="badge badge-ok">적용기로 넘어감</span>;
  if (s === "applied") return <span className="badge badge-ok">적용됨</span>;
  if (s === "closed") return <span className="badge">거부됨</span>;
  // Stored so that it replaces the previous plan, not because anybody has to decide about it.
  // Shown rather than filtered out: "the twin already matches the spec" is worth being able to
  // see, and its absence from the list would be indistinguishable from never having been planned.
  return <span className="badge">변경 없음</span>;
};

export function PlanList({ items, selectedId, onSelect }: Props) {
  if (items.length === 0) {
    return <div className="empty">저장된 계획이 없습니다.</div>;
  }
  return (
    <ul className="approval-list">
      {items.map((it) => (
        <li
          key={it.plan_id}
          className={it.plan_id === selectedId ? "selected" : ""}
          onClick={() => onSelect(it.plan_id)}
        >
          <div className="row">{stateBadge(it.state)}</div>
          {/* The resource. It is also what the plan is keyed by now - one governed resource has
              one state and one plan, and a new inspection replaces the old one rather than adding
              another row for the same thing. */}
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

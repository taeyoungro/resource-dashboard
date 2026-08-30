import type { PlanSummary } from "../types";
import { planLinks } from "../../server/consoleLinks.js";
import { clock } from "../time";

interface Props {
  items: PlanSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Open the same plan on its PassRole confirmation instead of its assessment. */
  onSelectPassrole: (id: string) => void;
}

const stateBadge = (s: PlanSummary["state"]) => {
  // Loudest of the five, and the only one that is nobody's decision to make. A refusal means the
  // last inspection of this resource produced no plan at all - and before the inspector recorded
  // one, that request left no trace anywhere a person at this page would look.
  if (s === "refused") return <span className="badge badge-danger">계획 거부됨</span>;
  if (s === "awaiting_decision") return <span className="badge badge-warn">결정 대기</span>;
  if (s === "decided") return <span className="badge badge-ok">적용기로 넘어감</span>;
  if (s === "applied") return <span className="badge badge-ok">적용됨</span>;
  if (s === "closed") return <span className="badge">거부됨</span>;
  // Stored so that it replaces the previous plan, not because anybody has to decide about it.
  // Shown rather than filtered out: "the twin already matches the spec" is worth being able to
  // see, and its absence from the list would be indistinguishable from never having been planned.
  return <span className="badge">변경 없음</span>;
};

export function PlanList({ items, selectedId, onSelect, onSelectPassrole }: Props) {
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
          <div className="row">
            {stateBadge(it.state)}
            {/* Only worth a badge while it is outstanding. "ready" is the normal case and would be
                noise on every row; "unavailable" means the plan can be approved but not restricted,
                which the detail panel says where somebody is about to decide. */}
            {it.assessment === "in_progress" && (
              <span className="badge badge-warn">평가 중</span>
            )}
            {/* Beside the state, because it is a different question about the same resource and the
                row is where somebody chooses which one they came for. Shown only where there is a
                request: a way in to an empty screen teaches people to stop clicking.

                stopPropagation, or the row's own handler would open the assessment underneath. */}
            {it.passrole_requests > 0 && (
              <button
                type="button"
                className="row-action"
                onClick={(e) => { e.stopPropagation(); onSelectPassrole(it.plan_id); }}
                title={`이 역할을 넘길 수 있게 해 달라는 요청 ${it.passrole_requests}건. `
                  + '승인과는 별개의 결정입니다.'}
              >
                PassRole 요청 {it.passrole_requests}
              </button>
            )}
          </div>
          {/* The resource. It is also what the plan is keyed by now - one governed resource has
              one state and one plan, and a new inspection replaces the old one rather than adding
              another row for the same thing. */}
          <div className="role-name">{it.resource ?? "(이름을 읽지 못함)"}</div>
          <div className="meta">
            <span>계정: {it.account_id ?? "—"}</span>
          </div>
          <div className="meta small">
            {it.planned_at ? clock(it.planned_at) : "시각 없음"}
          </div>
          {/* The two ends of the projection. Spec is the resource the user edited and exists for
              every plan; the governed artifact only exists once an apply has run, so its link only
              shows on applied plans - a link to a thing that is not there yet teaches people to
              stop clicking. The permission set ARN travels from the applier's outcome record: with
              it the Governed link is the permission set's own detail page, without it the Identity
              Center console home. stopPropagation: the row's own click selects the plan. */}
          {(() => {
            const links = planLinks(it.account_id, it.resource, {
              permissionSetArn: it.outcome?.permission_set_arn ?? null,
            });
            if (!links.spec && !links.governed) return null;
            return (
              <div className="meta small plan-links" onClick={(e) => e.stopPropagation()}>
                {links.spec && (
                  <a
                    className="console-link"
                    href={links.spec}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="원본(spec/source) 자원의 관리콘솔 페이지"
                  >
                    Spec ↗
                  </a>
                )}
                {it.state === "applied" && links.governed && (
                  <a
                    className="console-link"
                    href={links.governed}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="거버넌스 산출물의 관리콘솔 페이지"
                  >
                    Governed ↗
                  </a>
                )}
              </div>
            );
          })()}
        </li>
      ))}
    </ul>
  );
}

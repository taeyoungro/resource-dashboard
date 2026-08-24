import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImpactGroup, Restriction } from "../types";
import { ResourceName, uniform } from "./ResourceName";
import { ServiceIcon } from "./ServiceIcon";
import { parseArn } from "../../server/arn.js";

/**
 * Which resources one action is scoped to.
 *
 * Opened from a chosen action in the action picker, and that is the whole point of it existing. The two
 * used to be separate fields: a list of actions in one place and a list of resources in another, with
 * the resources applying to every action at once. Deciding "kms:DescribeKey on the Lambda key only" was
 * not expressible - you ticked the action here and the key there and nothing on the screen connected
 * them, and what the container built was every chosen action against every chosen resource.
 *
 * That was not merely awkward. generator/restriction.py writes ONE STATEMENT PER ACTION precisely
 * because actions do not share an ARN shape - s3:GetObject takes bucket/* and s3:ListBucket takes the
 * bucket - and a single shared resource list put the mismatch straight back in. Scoping per action is
 * the half of that design the screen was missing.
 *
 * What is offered is what the assessment says THIS action reaches: the groups whose actions list
 * contains it. That list is now trustworthy - it used to be every action of the service - so the
 * question "which resources can this action touch" has an answer that comes from the document rather
 * than from a guess made here.
 */

interface Props {
  /** The action being scoped, or null when one pick is being spread across several. */
  action: string | null;
  /** For the bulk case: how many actions it will land on, and how many cannot take it. */
  spread?: { applies: number; skipped: string[] };
  intent: Restriction["intent"];
  /** The groups the assessment says this action reaches. Empty is meaningful - see the body. */
  groups: ImpactGroup[];
  chosen: string[];
  onCommit: (resources: string[]) => void;
  onCancel: () => void;
}

// The last two are unreachable in practice - neither section opens this dialog, because neither
// statement carries a resource list. Present so the map is total: a heading that reads as an error
// beats an undefined one if a route ever appears.
const HEADING: Record<Restriction["intent"], string> = {
  allow_only: "허용할 자원 — 고른 것만 남고 나머지는 거부된다",
  deny_only: "거부할 자원 — 고른 것만 거부된다",
  deny_action: "동작 자체 거부는 자원을 지목하지 않는다",
  tag_condition: "태그 조건은 자원을 지목하지 않는다",
};

export function ResourcePicker({
  action, spread, intent, groups, chosen, onCommit, onCancel,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<string[]>(chosen);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    search.current?.focus();
  }, []);

  const everything = useMemo(
    () => groups.flatMap((g) => g.resources.map((r) => r.arn)),
    [groups],
  );

  const q = query.trim().toLowerCase();
  const shownGroups = groups
    .map((group) => ({
      group,
      resources: group.resources.filter(
        (r) => !q
          || r.arn.toLowerCase().includes(q)
          || Object.entries(r.tags).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(q)),
      ),
    }))
    .filter((entry) => entry.resources.length > 0);

  const shown = shownGroups.reduce((n, e) => n + e.resources.length, 0);

  const toggle = (arn: string) =>
    setDraft((current) =>
      current.includes(arn) ? current.filter((a) => a !== arn) : [...current, arn]);

  return createPortal(
    <dialog
      className="picker"
      ref={dialog}
      onCancel={() => onCancel()}
      onClick={(e) => {
        if (e.target === dialog.current) onCancel();
      }}
    >
      <header>
        <h4>
          자원 고르기{" "}
          <span className="muted">
            {action !== null ? <>— <code>{action}</code></> : `— 고른 동작 ${spread?.applies ?? 0}개 전체`}
          </span>
        </h4>
        <p className="muted">{HEADING[intent]}</p>
        {action === null && (
          <p className="muted">
            고른 자원은 그것을 다룰 수 있는 동작에만 들어간다.
            {spread && spread.skipped.length > 0 && (
              <>
                {" "}
                <strong>{spread.skipped.length}개 동작은 비워진다</strong> — 자원을 지목하지 않거나
                다른 자원 유형을 다루는 동작이다: {spread.skipped.slice(0, 4).join(", ")}
                {spread.skipped.length > 4 && ` 외 ${spread.skipped.length - 4}개`}
              </>
            )}
          </p>
        )}
        <div className="picker-search">
          <input
            ref={search}
            type="search"
            placeholder="ARN 또는 태그로 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="count">
            {shown === everything.length ? `${everything.length}개` : `${everything.length}개 중 ${shown}개`}
          </span>
        </div>
      </header>

      <div className="picker-body">
        {groups.length === 0 && (
          <p className="muted pick-empty">
            이 동작이 닿는 자원이 평가에 없다. 자원을 지목하지 않는 계정 단위 동작이거나, 해당 유형의
            자원이 계정에 없다는 뜻이다. 자원 없이 거부하면 동작 자체가 막힌다 — 의도를
            <strong> 이 자원만 거부</strong>로 두고 자원을 비워 두면 그렇게 기록된다.
          </p>
        )}

        {shownGroups.map(({ group, resources }) => (
          <PickGroup
            key={`${group.service}:${group.resource_type}`}
            group={group}
            resources={resources}
            draft={draft}
            toggle={toggle}
          />
        ))}

        {groups.length > 0 && shown === 0 && (
          <p className="muted pick-empty">"{query.trim()}"에 해당하는 자원이 없다.</p>
        )}
      </div>

      <footer>
        <span className="muted">고른 자원 {draft.length}개</span>
        <button
          type="button"
          disabled={everything.length === 0 || draft.length === everything.length}
          onClick={() => setDraft(everything)}
        >
          전부 선택
        </button>
        <button type="button" disabled={draft.length === 0} onClick={() => setDraft([])}>
          비우기
        </button>
        <button type="button" className="grow" onClick={() => onCancel()}>
          취소
        </button>
        <button type="button" className="commit" onClick={() => onCommit(draft)}>
          적용
        </button>
      </footer>
    </dialog>,
    document.body,
  );
}

/**
 * One resource-type group inside the picker. Split out so the group's uniform region and account -
 * the values every row shares, printed once in the heading - are computed once per group rather
 * than once per row: a truncated Resource Explorer group still holds a thousand rows.
 */
function PickGroup({
  group, resources, draft, toggle,
}: {
  group: ImpactGroup;
  resources: ImpactGroup["resources"];
  draft: string[];
  toggle: (arn: string) => void;
}) {
  const groupRegion = uniform(resources.map((r) => r.region || parseArn(r.arn)?.region));
  const groupAccount = uniform(resources.map((r) => parseArn(r.arn)?.account || undefined));
  return (
    <div className="pick-group">
      <span className="pick-head">
        <ServiceIcon service={group.service} resourceType={group.resource_type} />
        <code>{group.resource_type}</code> {group.total}개
        {group.truncated && " 이상 (잘림)"} · 범위 {group.scope}
        {groupRegion && ` · ${groupRegion}`}
        {groupAccount && ` · 계정 ${groupAccount}`}
        {group.attribution === "service" && " · 서비스 단위 귀속"}
      </span>
      <div className="pick-level">
        {resources.map((resource) => (
          <label
            key={resource.arn}
            className={
              (draft.includes(resource.arn) ? "pick-item on" : "pick-item")
              + (resource.sensitive ? " sensitive" : "")
            }
          >
            <input
              type="checkbox"
              checked={draft.includes(resource.arn)}
              onChange={() => toggle(resource.arn)}
            />
            <ResourceName
              arn={resource.arn}
              groupRegion={groupRegion}
              groupAccount={groupAccount}
            />
            {Object.keys(resource.tags).length > 0 && (
              <span className="rtype">
                {Object.entries(resource.tags).map(([k, v]) => `${k}=${v}`).join(" ")}
              </span>
            )}
          </label>
        ))}
      </div>
    </div>
  );
}


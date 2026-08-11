import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImpactAccessLevel, Restriction } from "../types";

/**
 * Choosing the actions a restriction covers, in a modal dialog.
 *
 * It used to be a list on the page, under the policy. That worked at twenty SQS actions and stops
 * working immediately after: a service like EC2 has actions in the hundreds, and the page a person
 * approves a plan on would become one long checkbox field with the plan pushed off the screen. So the
 * page keeps a button and a summary of what is chosen, and the offering lives here, behind search and
 * a scroll of its own.
 *
 * Two things are deliberate.
 *
 * A native <dialog> opened with showModal(), not a positioned overlay. The editor sits inside a
 * <details> inside a scrolling column, and an overlay would be clipped by both. showModal() puts the
 * element in the top layer, which is outside every ancestor's overflow and stacking context, and it
 * brings Escape, a backdrop, and focus containment with it rather than needing them written.
 *
 * A draft, committed by 적용. The dialog can be dismissed by Escape or by clicking the backdrop, and
 * both of those mean cancel everywhere else, so live edits would make Escape a silent commit. What is
 * chosen only reaches the restriction when somebody says so.
 *
 * It renders through a portal into document.body. The top layer changes where the dialog is painted
 * and not where it sits in the tree, so rendered in place it would still be a descendant of the
 * editor's fieldset - inheriting the editor's stylesheet rules by specificity, and going disabled with
 * the fieldset if that ever gets a disabled attribute. Neither is a thing to leave standing.
 *
 * This is still an input aid and not a trust boundary. Anything ticked or typed here is checked again
 * by the decision route against what the plan grants and against the protected set, and a third time
 * by the inline writer against the fence the applier handed it.
 *
 * The list comes from the assessment, not from a file of this server's own. It used to be the latter -
 * server/data/aws-actions.json, written by hand, covering SQS - and it was a second copy of data AWS
 * owns which had already drifted from it: four of its twenty entries had the wrong access level or the
 * wrong resource type. The container reads AWS's Service Reference to decide the enumeration anyway, so
 * it hands over exactly the actions this plan grants, with wildcards expanded and protected actions
 * already removed.
 */

/** The order an administrator looks in. Somebody restricting a queue wants Write, not Read. */
const ACCESS_ORDER: ImpactAccessLevel[] = [
  "Write", "Permissions management", "Tagging", "Read", "List",
];

/** One offerable action, resolved from the assessment's reference. */
export interface Offer {
  action: string;
  access: ImpactAccessLevel;
  resources: string[];
  /** No resource type at all. An allow_only restriction on it would deny it outright. */
  account_level: boolean;
}

const INTENT_NOTE: Record<Restriction["intent"], string> = {
  allow_only:
    "고른 자원만 허용하고 나머지는 거부한다. 자원을 지목하지 않는 계정 단위 동작은 이 의도에서 고를 수 "
    + "없다 — 거부 목록에 예외로 적을 이름이 없으므로 동작 자체가 막힌다.",
  deny_only: "고른 자원만 거부한다. 이후에 생기는 자원은 이 제한에 걸리지 않는다.",
  tag_condition: "태그가 붙은 자원을 거부한다. 나중에 태그가 붙는 자원까지 덮는다.",
};

interface Props {
  /** Which policy this restriction is on, for the heading. */
  policy: string;
  intent: Restriction["intent"];
  /** The actions already on the restriction. The draft starts here. */
  chosen: string[];
  /** Actions the policy literally names, already stripped of wildcards and protected names. */
  named: string[];
  /** Services whose actions the assessment listed, with the offers themselves. */
  covered: { service: string; offers: Offer[] }[];
  /** Services this policy grants that the assessment did not list. Those are typed. */
  uncovered: string[];
  /** Why the reference is missing, when it is. The same sentence the file error used to carry. */
  referenceError: string | null;
  protectedActions: string[];
  onCommit: (actions: string[]) => void;
  onCancel: () => void;
}

export function ActionPicker({
  policy, intent, chosen, named, covered, uncovered, referenceError, protectedActions,
  onCommit, onCancel,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<string[]>(chosen);
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");

  // Mounted only while open, so this runs once. showModal() rather than the open attribute: the
  // attribute alone leaves the element in the page flow, unclipped by nothing and modal to nobody.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    search.current?.focus();
  }, []);

  // An account-level action names no resource, so an allow_only restriction on it would deny it
  // outright rather than narrow it - generator/restriction.py refuses exactly that. Offered for the
  // other two intents, where a flat Deny is what the administrator meant.
  const usable = (offer: Offer) =>
    !protectedActions.includes(offer.action)
    && !(intent === "allow_only" && offer.account_level);

  // Everything the dialog offers, regardless of the search. Anything in the draft that is NOT in here
  // gets its own group: an action typed earlier, or one that was ticked under deny_only and became
  // unofferable when the intent changed to allow_only. Without that group it would sit in the
  // restriction with no checkbox to clear it.
  const offered = useMemo(() => {
    const set = new Set(named);
    for (const group of covered) {
      for (const offer of group.offers) {
        if (usable(offer)) set.add(offer.action);
      }
    }
    return set;
    // intent and protectedActions are here because usable() reads them, which is not something a
    // dependency list can see for itself.
  }, [named, covered, intent, protectedActions]);

  const q = query.trim().toLowerCase();
  const hit = (action: string, access = "", resources: string[] = []) =>
    !q
    || action.toLowerCase().includes(q)
    || access.toLowerCase().includes(q)
    || resources.some((r) => r.toLowerCase().includes(q));

  const namedShown = named.filter((action) => hit(action));
  const strays = draft.filter((action) => !offered.has(action));
  const straysShown = strays.filter((action) => hit(action));
  const groups = covered.map(({ service, offers }) => {
    const offering = offers.filter(usable);
    // The resource type earns a column only where it tells two actions apart. Every SQS action operates
    // on a queue, so printing "queue" twenty times is twenty pieces of noise; S3 has buckets and
    // objects, and there it decides which restriction is possible at all.
    const shapes = new Set(offering.map((o) => o.resources.join(",")));
    return {
      service,
      label: service,
      showResource: shapes.size > 1,
      entries: offering.filter((o) => hit(o.action, o.access, o.resources)),
    };
  });

  const total = offered.size + strays.length;
  const shown = namedShown.length + straysShown.length
    + groups.reduce((n, g) => n + g.entries.length, 0);

  const toggle = (action: string) =>
    setDraft((current) =>
      current.includes(action) ? current.filter((a) => a !== action) : [...current, action]);

  const add = () => {
    const action = typed.trim();
    if (!action) return;
    // Add, never toggle. A text box whose second Enter removes what the first one added is a text box
    // that punishes a double press.
    setDraft((current) => (current.includes(action) ? current : [...current, action]));
    setTyped("");
  };

  const item = (action: string, resource?: string) => (
    <label key={action} className={draft.includes(action) ? "pick-item on" : "pick-item"}>
      <input type="checkbox" checked={draft.includes(action)} onChange={() => toggle(action)} />
      <code>{action}</code>
      {resource && <span className="rtype">{resource}</span>}
    </label>
  );

  return createPortal(
    <dialog
      className="picker"
      ref={dialog}
      onCancel={() => onCancel()}
      // The dialog element's own box is the backdrop region - its children fill it and it has no
      // padding - so a click that lands on it landed outside the panel.
      onClick={(e) => {
        if (e.target === dialog.current) onCancel();
      }}
    >
      <header>
        <h4>
          동작 고르기 <span className="muted">— <code>{policy}</code></span>
        </h4>
        <p className="muted">{INTENT_NOTE[intent]}</p>
        <div className="picker-search">
          <input
            ref={search}
            type="search"
            placeholder="동작 이름, 접근 수준, 자원 유형으로 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="count">
            {shown === total ? `${total}개` : `${total}개 중 ${shown}개`}
          </span>
        </div>
      </header>

      <div className="picker-body">
        {namedShown.length > 0 && (
          <div className="pick-group">
            <span className="pick-head">이 정책이 직접 지목한 동작</span>
            <div className="pick-level">{namedShown.map((action) => item(action))}</div>
          </div>
        )}

        {straysShown.length > 0 && (
          <div className="pick-group">
            <span className="pick-head">
              목록에 없는 동작 — 직접 적었거나, 의도를 바꾸면서 고를 수 없게 된 것이다
            </span>
            <div className="pick-level">{straysShown.map((action) => item(action))}</div>
          </div>
        )}

        {groups.map((group) => (
          <div key={group.service} className="pick-group">
            <span className="pick-head">{group.label} — 이 정책이 닿는 서비스</span>
            {ACCESS_ORDER.map((access) => {
              const ofLevel = group.entries.filter((e) => e.access === access);
              if (ofLevel.length === 0) return null;
              return (
                <div key={access} className="pick-level">
                  <span className="level-name">{access}</span>
                  {ofLevel.map((offer) =>
                    item(offer.action,
                         group.showResource ? (offer.resources.join(", ") || "자원 없음") : undefined))}
                </div>
              );
            })}
          </div>
        ))}

        {shown === 0 && (
          <p className="muted pick-empty">
            {total === 0
              ? "고를 수 있는 동작이 없다. 아래에 이름을 직접 적으면 된다."
              : `"${query.trim()}"에 해당하는 동작이 없다.`}
          </p>
        )}

        {/* Always here, not only for services the assessment did not list. A service can be omitted
            because its list did not fit the byte budget, the reference may not have known an action,
            and an assessment written before the container carried lists has none at all. Both the
            server and the inline writer check what is typed, so an action that does not exist is
            refused with a sentence rather than accepted. */}
        <div className="pick-group">
          <span className="pick-head">
            {uncovered.length > 0
              ? `${uncovered.join(", ")} — 평가가 목록을 싣지 않았다. 동작 이름을 직접 적는다`
              : "목록에 없는 동작을 직접 적는다"}
          </span>
          <div className="picker-typed">
            <input
              type="text"
              placeholder={`${uncovered[0] ?? covered[0]?.service ?? "service"}:...`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button type="button" disabled={!typed.trim()} onClick={add}>
              동작 추가
            </button>
          </div>
        </div>

        {referenceError && (
          <p className="warn-inline">
            평가가 동작 목록을 싣지 못했다 ({referenceError}). 이름을 직접 적으면 된다 — 서버와 인라인
            작성기가 어차피 검사한다.
          </p>
        )}
      </div>

      <footer>
        <span className="muted">고른 동작 {draft.length}개</span>
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

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ImpactAccessLevel, ImpactGroup, Restriction } from "../types";
import { ResourcePicker } from "./ResourcePicker";

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
 * A chosen action carries its own resources, picked in a second dialog opened from its row. They used
 * to be a separate field applying to every action at once, which made "kms:DescribeKey on the Lambda
 * key only" inexpressible - and put back the ARN-shape mismatch that generator/restriction.py writes one
 * statement per action to avoid. One action, its own resources, its own statement.
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
  /**
   * It brings the resource it names into being, so a list of what EXISTS is no scope for it.
   * lambda:CreateFunction with NotResource [A, B] reads as "you may create a function called A or
   * B", and A and B are already there. Same remedy as account_level - a flat Deny - so the two
   * share a block, and different words, because the reasons are different.
   */
  creates_target: boolean;
}

/** Whether a list of enumerated ARNs can scope this action at all, for either reason. */
const flatOnly = (offer: Offer) => offer.account_level || offer.creates_target;

const INTENT_NOTE: Record<Restriction["intent"], string> = {
  allow_only:
    "고른 자원만 허용하고 나머지는 거부한다. 자원을 지목하지 않는 계정 단위 동작은 이 의도에서 고를 수 "
    + "없다 — 거부 목록에 예외로 적을 이름이 없으므로 동작 자체가 막힌다.",
  deny_only: "고른 자원만 거부한다. 이후에 생기는 자원은 이 제한에 걸리지 않는다.",
  tag_condition: "태그가 붙은 자원을 거부한다. 나중에 태그가 붙는 자원까지 덮는다.",
};

/** One chosen action and the resources it is scoped to. */
export interface Choice {
  action: string;
  resources: string[];
}

interface Props {
  /** Which policy this restriction is on, for the heading. */
  policy: string;
  intent: Restriction["intent"];
  /** The actions already chosen, with their resources. The draft starts here. */
  chosen: Choice[];
  /** Actions the policy literally names, already stripped of wildcards and protected names. */
  named: string[];
  /** Services whose actions the assessment listed, with the offers themselves. */
  covered: { service: string; offers: Offer[] }[];
  /** Services this policy grants that the assessment did not list. Those are typed. */
  uncovered: string[];
  /** Why the reference is missing, when it is. The same sentence the file error used to carry. */
  referenceError: string | null;
  protectedActions: string[];
  /** Every group the assessment enumerated for this policy, so a row can offer its own resources. */
  affected: ImpactGroup[];
  /** The service the policy is named for. Its block is shown; the others fold away. */
  primary: string | null;
  onCommit: (choices: Choice[]) => void;
  onCancel: () => void;
}

export function ActionPicker({
  policy, intent, chosen, named, covered, uncovered, referenceError, protectedActions, affected,
  primary, onCommit, onCancel,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<Choice[]>(chosen);
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  /** The action whose resources are being picked, in a dialog above this one. */
  const [scoping, setScoping] = useState<string | null>(null);
  /** True while one resource pick is being spread across every chosen action. */
  const [spreading, setSpreading] = useState(false);

  const held = (action: string) => draft.find((c) => c.action === action);

  // What the assessment says an action reaches. group.actions is the list of actions that reach THAT
  // resource type, which is the corrected meaning of the field - it used to be every action of the
  // service, and scoping per action off it would have offered resources the action cannot touch.
  const reachedBy = (action: string) => affected.filter((g) => g.actions.includes(action));

  // Which group each enumerated ARN came from, so a resource picked once can be handed only to the
  // actions that can actually reach it. This is what keeps a bulk apply from putting the same list on
  // every action regardless of shape - the mismatch generator/restriction.py splits statements to avoid.
  const owner = useMemo(() => {
    const map = new Map<string, ImpactGroup>();
    for (const group of affected) {
      for (const resource of group.resources) map.set(resource.arn, group);
    }
    return map;
  }, [affected]);

  const reachable = (action: string, arns: string[]) =>
    arns.filter((arn) => owner.get(arn)?.actions.includes(action));

  // Mounted only while open, so this runs once. showModal() rather than the open attribute: the
  // attribute alone leaves the element in the page flow, unclipped by nothing and modal to nobody.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    search.current?.focus();
  }, []);

  // An account-level action names no resource, so it cannot be narrowed - only denied outright.
  //
  // It used to be REMOVED from the offering under allow_only, and that was the wrong answer to a
  // real constraint: 전체 선택 across EC2 then quietly skipped 257 of its 793 actions and nothing
  // on the page said which, or why, or that they existed. An approver who ticked everything
  // believed they had covered everything.
  //
  // So it is offered under every intent now, in its own block, and ticking one composes a flat Deny
  // instead - which is what the editor emits and what the container will accept. The block says so;
  // this is a different decision from the one being made about the rest and it is made knowingly.
  /** Every offer by action name, so a row can ask whether its action names a resource at all. */
  const offerFor = useMemo(() => {
    const map = new Map<string, Offer>();
    for (const group of covered) {
      for (const offer of group.offers) map.set(offer.action, offer);
    }
    return map;
  }, [covered]);

  const usable = (offer: Offer) => !protectedActions.includes(offer.action);

  /**
   * Whether an action still NEEDS a resource before the container will write it.
   *
   * generator/restriction.py refuses a decision that names no resource unless every action in it is
   * account-level - a flat Deny on "*" being the only shape that restricts one of those. An action
   * that DOES take a resource and has none is refused, and rightly: allow_only would compose an
   * empty NotResource, which denies everywhere, and deny_only would compose Resource "*", which
   * denies the action outright rather than on the resources the administrator meant.
   *
   * That refusal used to arrive on submit, after the whole restriction was assembled. Same rule,
   * asked here instead.
   *
   * null for an action the reference does not carry - one typed by hand. Nothing here can say
   * whether it names a resource, and the container has a floor list of its own, so the escape hatch
   * stays open and the refusal stays where it can be made correctly.
   */
  const needsResource = (action: string): boolean | null => {
    if (intent === 'tag_condition') return false;
    const offer = offerFor.get(action);
    if (!offer) return null;
    return !flatOnly(offer);
  };

  /**
   * Takes a resource, and the assessment holds NONE it can reach.
   *
   * Not the same thing as "no resource picked yet", and conflating the two is what this exists to
   * stop. An action waiting on a pick is a step the administrator has left to take; one of these is
   * a step nobody can take - athena:CreateCapacityReservation names capacity-reservation and the
   * account has no capacity reservation, so no list of ARNs will ever scope it. Blocking 적용 on it
   * is a dead end with no way out of the dialog except 비우기.
   *
   * It is dropped rather than written. A flat Deny on "*" would be a defensible reading of
   * allow_only - "these resources only, and there are none" does mean deny, and for a create action
   * it is the only reading that restricts anything - but it is a decision the administrator did not
   * take: these arrive through 전체 선택, not through a checkbox somebody ticked. The dialog says
   * which ones went and why.
   *
   * What that leaves undone, said rather than hidden: there is no way here to express "deny
   * creating a resource type this account has none of". The row is unselectable and a hand-typed
   * name lands in the same set and is dropped with the rest. It needs a shape of its own before it
   * can be offered, and inventing one silently out of a 전체 선택 is not it.
   */
  const unreachableAction = (action: string) =>
    needsResource(action) === true && reachedBy(action).length === 0;

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

  // An action the policy names literally is usually also in its service's block, and rendering it in
  // both put two checkboxes and two resource buttons on screen for one action. This group is now what
  // it is actually for: the actions the reference does not cover, which would otherwise be offered
  // nowhere.
  const inBlocks = useMemo(
    () => new Set(covered.flatMap((g) => g.offers.map((o) => o.action))),
    [covered],
  );
  const namedShown = named.filter((action) => !inBlocks.has(action) && hit(action));
  const strays = draft.map((c) => c.action).filter((action) => !offered.has(action));
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

  // An action with no resources yet. Reported in the footer rather than refused: for an action that
  // reaches nothing it is the correct and only state, and the container decides which of those is a
  // legitimate flat deny.
  /**
   * Chosen, takes a resource, has none - and there IS one to pick.
   *
   * The shape generator/restriction.py refuses, and the one 적용 must wait for. Separate from
   * `unscoped` below, which counts every choice with an empty list including the account-level ones
   * a flat Deny covers. Those are fine; these are not, and conflating the two either blocks a
   * legitimate flat Deny or lets an empty NotResource through.
   *
   * And separate from `unreachable`: an action nothing can scope is not waiting for anything, so
   * holding 적용 for it is a dialog with no exit. That distinction is the whole of this pair.
   */
  const needsPick = draft.filter((c) => c.resources.length === 0
    && needsResource(c.action) === true && !unreachableAction(c.action));

  /** Chosen, and nothing in the assessment can ever scope it. Named below, and not written. */
  const unreachable = draft.filter((c) => c.resources.length === 0
    && unreachableAction(c.action));

  /** What 적용 hands back. Everything the container can actually compose a statement from. */
  const writable = draft.filter((c) => !unreachableAction(c.action));

  const unscoped = draft.filter((c) => c.resources.length === 0);

  // What a bulk apply would reach. An action that names no resource type, or one whose type nothing in
  // the assessment holds, cannot take a resource at all - and that is a different thing from "not
  // chosen yet", so it is counted separately and said before the pick rather than after.
  const spreadable = useMemo(() => {
    const applies: string[] = [];
    const skipped: string[] = [];
    for (const choice of draft) {
      (reachedBy(choice.action).length > 0 ? applies : skipped).push(choice.action);
    }
    // affected is the dependency; reachedBy closes over it.
    return { applies: applies.length, skipped };
  }, [draft, affected]);

  /** Every resource any chosen action can reach, for the bulk dialog to offer. */
  const spreadGroups = useMemo(() => {
    const seen = new Set<ImpactGroup>();
    for (const choice of draft) for (const group of reachedBy(choice.action)) seen.add(group);
    return [...seen];
  }, [draft, affected]);

  // The policy's own service is shown; the services it only reaches incidentally fold away, exactly as
  // their resources do on the page. AWSLambda_FullAccess grants three cloudformation and kms actions
  // beside ninety lambda ones, and those three are not what anybody opened this dialog for.
  const primaryBlocks = primary === null ? groups : groups.filter((g) => g.service === primary);
  const relatedBlocks = primary === null ? [] : groups.filter((g) => g.service !== primary);
  const relatedShown = relatedBlocks.reduce((n, g) => n + g.entries.length, 0);

  const total = offered.size + strays.length;
  const shown = namedShown.length + straysShown.length
    + groups.reduce((n, g) => n + g.entries.length, 0);

  const toggle = (action: string) =>
    setDraft((current) => (current.some((c) => c.action === action)
      ? current.filter((c) => c.action !== action)
      : [...current, { action, resources: [] }]));

  const scope = (action: string, resources: string[]) =>
    setDraft((current) => current.map((c) => (c.action === action ? { ...c, resources } : c)));

  /** One pick, handed to each chosen action filtered down to what that action can reach. */
  const spread = (arns: string[]) =>
    setDraft((current) => current.map((c) => ({ ...c, resources: reachable(c.action, arns) })));

  const selectAll = (offers: Offer[], on: boolean) =>
    setDraft((current) => {
      const names = offers.map((o) => o.action);
      if (!on) return current.filter((c) => !names.includes(c.action));
      const held = new Set(current.map((c) => c.action));
      return [...current, ...names.filter((n) => !held.has(n)).map((action) => ({
        action, resources: [] as string[],
      }))];
    });

  const add = () => {
    const action = typed.trim();
    if (!action) return;
    // Add, never toggle. A text box whose second Enter removes what the first one added is a text box
    // that punishes a double press.
    setDraft((current) => (current.some((c) => c.action === action)
      ? current
      : [...current, { action, resources: [] }]));
    setTyped("");
  };

  /**
   * 전체 선택 for one block. Acts on what is SHOWN, so it follows the search rather than ignoring it.
   *
   * And only on the actions that reach a resource. The ones that do not are a different kind of
   * statement - a flat Deny, unconditional - and sweeping them in with everything else would make
   * that decision on the administrator's behalf while a button labelled 전체 선택 implied it had
   * merely selected some checkboxes. They have their own 전체 선택 in their own block.
   *
   * The unreachable ones go for a second reason. Their own checkbox is disabled, so sweeping them
   * in here was the one way into a state the dialog could not leave: six athena capacity-reservation
   * actions arrived through 전체 선택 66개, each needing a resource, none having one to be given,
   * and 적용 stayed grey with no row to go and fix.
   */
  const blockToggle = (group: { service: string; entries: Offer[] }) => {
    const scoped = group.entries.filter(
      (o) => !flatOnly(o) && !unreachableAction(o.action),
    );
    if (scoped.length === 0) return null;
    const all = scoped.every((o) => Boolean(held(o.action)));
    return (
      <button
        type="button"
        className="block-all"
        onClick={() => selectAll(scoped, !all)}
        title={q ? "검색으로 걸러진 것만 대상이다" : undefined}
      >
        {all ? "전체 해제" : `전체 선택 ${scoped.length}개`}
      </button>
    );
  };

  /**
   * The actions that reach a resource, by access level. The ordinary case.
   *
   * `only` picks which half: false is everything that names a resource type, true is everything
   * that names none. They are never rendered together, because ticking one of each produces two
   * different KINDS of statement and a single list would hide that.
   */
  const byLevel = (group: { entries: Offer[]; showResource: boolean }, accountOnly: boolean) =>
    ACCESS_ORDER.map((access) => {
      const ofLevel = group.entries.filter(
        (e) => e.access === access && flatOnly(e) === accountOnly,
      );
      if (ofLevel.length === 0) return null;
      return (
        <div key={access} className="pick-level">
          <span className="level-name">{access}</span>
          {ofLevel.map((offer) =>
            item(offer.action,
                 group.showResource && !accountOnly
                   ? (offer.resources.join(", ") || "자원 없음")
                   : undefined))}
        </div>
      );
    });

  /**
   * The actions that name no resource, folded, with what ticking one actually does.
   *
   * These cannot be narrowed. A NotResource list denies them whatever is in it - their resource is
   * "*" and "*" is in no list - and a Resource list of ARNs never matches them. The only statement
   * that means anything is a flat Deny, so the editor emits deny_only for these whatever intent the
   * rest are under, and the sentence here is what makes that a decision rather than a surprise.
   *
   * Folded because they are the minority case and the ordinary one should be what the eye lands on
   * - but PRESENT, which is the change. They used to be filtered out of the offering under
   * allow_only, so 전체 선택 across EC2 skipped 257 of 793 actions in silence.
   */
  const flatDenyBlock = (group: { service: string; entries: Offer[]; showResource: boolean }) => {
    const flat = group.entries.filter(flatOnly);
    if (flat.length === 0) return null;
    const all = flat.every((o) => Boolean(held(o.action)));
    return (
      <details className="pick-flat" open={Boolean(q)}>
        <summary>
          자원 목록으로 좁힐 수 없는 동작 {flat.length}개 — 통째로 거부하는 것만 가능하다
          <button type="button" className="block-all"
                  onClick={(e) => { e.preventDefault(); selectAll(flat, !all); }}>
            {all ? "전체 해제" : `전체 선택 ${flat.length}개`}
          </button>
        </summary>
        <p className="muted small">
          고르면 지금 고른 나머지와 달리 <strong>평면 거부</strong>(<code>Deny</code> ·{" "}
          <code>Resource: &quot;*&quot;</code>)로 작성된다 — 조건 없이 완전히 막힌다는 뜻이다. 위의{" "}
          <strong>인라인 정책 보기</strong>에서 실제 문장을 확인할 수 있다.
        </p>
        {/* 두 가지 이유가 섞여 있고, 승인자에게는 다른 문장이다. 하나는 자원이라는 것이 없고,
            다른 하나는 자원이 아직 없다. */}
        {flat.some((o) => o.account_level) && (
          <p className="muted small">
            <strong>{flat.filter((o) => o.account_level).length}개</strong>는 자원을 인자로 받지
            않는다. 자원 절에 적을 이름 자체가 없다.
          </p>
        )}
        {flat.some((o) => o.creates_target) && (
          <p className="muted small">
            <strong>{flat.filter((o) => o.creates_target).length}개</strong>는 자기가 지목하는 자원을{" "}
            <strong>만드는</strong> 동작이다. 목록에 있는 자원은 이미 존재하는 것들이므로,{" "}
            <code>NotResource</code>에 적으면 &quot;이 이름으로는 만들어도 된다&quot;가 되어 통제가
            되지 않는다. 예: <code>lambda:CreateFunction</code>
          </p>
        )}
        {byLevel(group, true)}
      </details>
    );
  };

  // The resource button sits OUTSIDE the label. Inside one, a click on it would also toggle the
  // checkbox the label is for, so ticking an action and scoping it would fight each other.
  const item = (action: string, resource?: string) => {
    const chosenFor = held(action);
    const reachable = reachedBy(action);
    // Needs a resource, and the assessment holds none it can reach. Nothing the administrator can
    // pick will ever scope it, so whatever is ticked here the container refuses - it is not ticked,
    // and the row says why rather than being quietly absent. An approver looking for an action
    // needs to find out it is unrestrictable, not fail to find it.
    const dead = unreachableAction(action);
    return (
      <div key={action} className="pick-row">
        <label className={[chosenFor ? "pick-item on" : "pick-item", dead ? "dead" : ""]
          .filter(Boolean).join(" ")}
               title={dead
                 ? "이 평가에 이 동작이 닿는 자원이 없다. 자원을 지정할 수 없으므로 제한을 쓸 수 없다"
                 : undefined}>
          <input type="checkbox" checked={Boolean(chosenFor)} disabled={dead}
                 onChange={() => toggle(action)} />
          <code>{action}</code>
          {resource && <span className="rtype">{resource}</span>}
          {dead && <span className="rtype">닿는 자원 없음</span>}
        </label>
        {chosenFor && intent !== "tag_condition" && (
          <button
            type="button"
            className={chosenFor.resources.length === 0 ? "scope empty" : "scope"}
            title={reachable.length === 0
              ? "이 동작이 닿는 자원이 평가에 없다"
              : `${action}의 자원을 고른다`}
            onClick={() => setScoping(action)}
          >
            {chosenFor.resources.length > 0
              ? `자원 ${chosenFor.resources.length}개`
              : (reachable.length === 0 ? "자원 없음" : "자원 고르기")}
          </button>
        )}
      </div>
    );
  };

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
            <span className="pick-head">이 정책이 직접 지목한 동작 — 목록에 없다</span>
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

        {primaryBlocks.map((group) => (
          <div key={group.service} className="pick-group">
            <span className="pick-head">
              {group.label} — 이 정책이 닿는 서비스
              {blockToggle(group)}
            </span>
            {byLevel(group, false)}
            {flatDenyBlock(group)}
          </div>
        ))}

        {relatedBlocks.length > 0 && (
          // Open while a search is running. The count above includes matches in here, and a hit the
          // person cannot see is worse than no fold at all.
          <details className="related" open={Boolean(q)}>
            <summary>
              연관 서비스 동작 {relatedBlocks.reduce((n, g) => n + g.entries.length, 0)}개 —{" "}
              {relatedBlocks.map((g) => g.service).join(", ")}
              {q && relatedShown > 0 && ` · 검색 결과 ${relatedShown}개`}
            </summary>
            <p className="muted">
              {primary} 작업을 위해 함께 부여된 동작이다. 제한 대상으로 고를 수는 있다.
            </p>
            {relatedBlocks.map((group) => (
              <div key={group.service} className="pick-group">
                <span className="pick-head">
                  {group.label}
                  {blockToggle(group)}
                </span>
                {byLevel(group, false)}
                {flatDenyBlock(group)}
              </div>
            ))}
          </details>
        )}

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
        <span className="muted">
          고른 동작 {draft.length}개
          {intent !== "tag_condition" && unscoped.length > 0
            && ` · 자원 미지정 ${unscoped.length}개`}
        </span>
        {/* Named, not counted. "자원 미지정 3개" tells an administrator that something is wrong and
            not which row to open, and the footer is where they are looking when 적용 will not
            press. */}
        {needsPick.length > 0 && (
          <span className="unwritable">
            자원을 지정해야 쓸 수 있다 —{" "}
            {needsPick.slice(0, 3).map((c) => c.action).join(", ")}
            {needsPick.length > 3 && ` 외 ${needsPick.length - 3}개`}
          </span>
        )}
        {/* A statement, not a warning. These do not hold 적용 up and there is nothing to go and fix
            - the reason they are here is that an administrator who ticked 66 and got 60 is owed the
            other six by name. */}
        {unreachable.length > 0 && (
          <span className="dropped-actions">
            닿는 자원이 없어 빠진다 —{" "}
            {unreachable.slice(0, 3).map((c) => c.action).join(", ")}
            {unreachable.length > 3 && ` 외 ${unreachable.length - 3}개`}
          </span>
        )}
        {intent !== "tag_condition" && (
          <button
            type="button"
            disabled={draft.length === 0 || spreadable.applies === 0}
            title={spreadable.skipped.length > 0
              ? `${spreadable.skipped.length}개 동작은 자원을 받을 수 없어 비워진다`
              : "고른 동작 전체에 같은 자원을 적용한다"}
            onClick={() => setSpreading(true)}
          >
            자원 일괄 적용
            {spreadable.skipped.length > 0 && ` (${spreadable.applies}/${draft.length})`}
          </button>
        )}
        <button type="button" disabled={draft.length === 0} onClick={() => setDraft([])}>
          비우기
        </button>
        <button type="button" className="grow" onClick={() => onCancel()}>
          취소
        </button>
        <button
          type="button"
          className="commit"
          disabled={needsPick.length > 0}
          title={needsPick.length > 0
            ? `자원을 지정하지 않은 동작이 ${needsPick.length}개 있다: `
              + `${needsPick.slice(0, 3).map((c) => c.action).join(", ")}`
              + `${needsPick.length > 3 ? " 외" : ""}`
            : unreachable.length > 0
              ? `${unreachable.length}개 동작은 닿는 자원이 없어 빠진다`
              : undefined}
          onClick={() => onCommit(writable)}
        >
          적용
        </button>
      </footer>

      {/* Above this dialog, in the same top layer. Escape closes the topmost one, which is the one the
          person is looking at. */}
      {spreading && (
        <ResourcePicker
          action={null}
          spread={spreadable}
          intent={intent}
          groups={spreadGroups}
          chosen={[]}
          onCommit={(resources) => {
            spread(resources);
            setSpreading(false);
          }}
          onCancel={() => setSpreading(false)}
        />
      )}

      {scoping !== null && (
        <ResourcePicker
          action={scoping}
          intent={intent}
          groups={reachedBy(scoping)}
          chosen={held(scoping)?.resources ?? []}
          onCommit={(resources) => {
            scope(scoping, resources);
            setScoping(null);
          }}
          onCancel={() => setScoping(null)}
        />
      )}
    </dialog>,
    document.body,
  );
}

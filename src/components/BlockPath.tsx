import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  Finding, ImpactActionReference, ImpactGroup, ImpactPolicy, Restriction,
} from "../types";
import { ResourcePicker } from "./ResourcePicker";
import { INTENT_LABEL, INTENT_NOTE, SECTIONS, isScoped } from "./intents";
import { blockOffer, mergeBlock } from "../../server/blockPath.js";

/**
 * From a finding card straight to the restriction that cuts the path, in one dialog.
 *
 * The card already names everything a decision needs - the actions that make the path real, the
 * policy that grants them, the resources they reach - and the editor that can act on it sits one
 * screen-height up, keyed by policy rather than by path. Walking there meant re-finding the same
 * actions in a picker that offers hundreds. This dialog is the same decision offered where the
 * reason for it is on screen.
 *
 * What it deliberately is NOT is a second restriction system. It writes into the SAME array the
 * per-policy editor composes - mergeBlock replaces any earlier decision on the same (policy,
 * action), because the editor's own rule is one action, one section, and an appended duplicate
 * would be the contradiction that rule exists to prevent. The result lands in the one inline
 * document, visible in 인라인 정책 보기 and in the policy block's own sections, which re-seed from
 * the shared array when it changes under them.
 *
 * Three rules carried over from the editor rather than reinvented:
 *
 *   flat-only actions route to 동작 자체 거부   an action a list of ARNs cannot scope composes a
 *                                              flat Deny whatever intent the rest are under, and
 *                                              the row says so before 적용 rather than after
 *   resources are picked, never assumed        the card's target list can be a SAMPLE
 *                                              (sampleComplete false), and under 이 자원만 허용 a
 *                                              silently pre-ticked sample would deny everything
 *                                              outside an incomplete list - so the picker opens on
 *                                              the assessment's enumeration and nothing is
 *                                              pre-ticked
 *   protected actions are shown struck out     same as the card's containment row: dropping them
 *                                              silently would read as a shorter answer, and an
 *                                              approver could not tell which list they are seeing
 */
export function BlockPath({
  finding, policy, protectedActions, reference, restrictions, onChange, onClose,
}: {
  finding: Finding;
  /** The assessment's policy matching finding.policyName. The button does not render without it. */
  policy: ImpactPolicy;
  protectedActions: string[];
  reference: ImpactActionReference | null;
  /** The WHOLE restriction set - this dialog merges into it, it does not own a copy. */
  restrictions: Restriction[];
  onChange: (next: Restriction[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const offer = useMemo(
    () => blockOffer(finding, protectedActions), [finding, protectedActions],
  );

  /** Same test as the editor's: no resource type at all, or it makes the one it names. */
  const flatOnly = (action: string) => {
    const cut = action.indexOf(":");
    const entry = reference?.services[action.slice(0, cut)]?.[action.slice(cut + 1)];
    return entry ? entry[1].length === 0 || entry[2] === true : false;
  };

  /** Same vocabulary as the editor's condition section: the keys an action declares, or []. */
  const declaredKeys = (action: string): string[] => {
    const cut = action.indexOf(":");
    return reference?.condition_keys?.[action.slice(0, cut)]?.[action.slice(cut + 1)] ?? [];
  };
  const conditionKeyListId = useId();

  const reachedBy = (action: string): ImpactGroup[] =>
    policy.affected.filter((g) => g.actions.includes(action));

  const [intent, setIntent] = useState<Restriction["intent"]>("deny_action");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(offer.filter((o) => !o.protected).map((o) => o.action)),
  );
  const [resources, setResources] = useState<Map<string, string[]>>(new Map());
  const [scoping, setScoping] = useState<string | null>(null);
  const [tagKey, setTagKey] = useState("");
  const [tagValues, setTagValues] = useState("");
  const [conditionKey, setConditionKey] = useState("");
  const [conditionOperator, setConditionOperator] = useState<"StringNotEquals" | "StringEquals">(
    "StringNotEquals",
  );
  const [conditionValues, setConditionValues] = useState("");

  const toggle = (action: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(action)) next.delete(action);
    else next.add(action);
    return next;
  });

  /** Actions this 적용 will write, split exactly the way the editor splits them. */
  const chosen = offer.filter((o) => !o.protected && selected.has(o.action));
  const scopable = chosen.filter((o) => !flatOnly(o.action));
  // Reaches nothing the assessment enumerated - nothing to pick, so under a scoped intent it is
  // dropped and named, exactly as the picker drops them, rather than holding 적용 shut forever.
  const unreachable = isScoped(intent)
    ? scopable.filter((o) => reachedBy(o.action).length === 0)
    : [];
  const needsPick = isScoped(intent)
    ? scopable.filter((o) => reachedBy(o.action).length > 0
                             && (resources.get(o.action) ?? []).length === 0)
    : [];
  const tagMissing = intent === "tag_condition"
    && (!tagKey.trim() || tagValues.split(",").every((v) => !v.trim()));
  const conditionMissing = intent === "key_condition"
    && (!conditionKey.trim() || conditionValues.split(",").every((v) => !v.trim()));
  // Chosen actions that do not declare the typed key. Dropped and named, exactly as unreachable
  // actions are under a scoped intent: on these the condition would never evaluate and the writer
  // refuses the statement. Only judged once a key is typed - before that the gate above holds
  // 적용 shut anyway.
  const keyless = intent === "key_condition" && conditionKey.trim()
    ? chosen.filter((o) => !declaredKeys(o.action).includes(conditionKey.trim()))
    : [];

  /** The decisions 적용 hands to mergeBlock. One restriction per action, like everywhere else. */
  const additions = (): Restriction[] => {
    const tag = {
      tag_key: tagKey.trim(),
      tag_values: tagValues.split(",").map((v) => v.trim()).filter(Boolean),
    };
    const rows: Restriction[] = [];
    for (const { action } of chosen) {
      if (intent === "key_condition") {
        // BEFORE the flat-only routing, which must not apply here: the condition gates the
        // REQUEST, not a resource, so an action a list of ARNs cannot scope carries it fine
        // (ec2:DescribeVpcs declares ec2:Region) - rerouting would drop the condition. What is
        // dropped instead is an action that does not declare the key, named in the footer.
        if (!declaredKeys(action).includes(conditionKey.trim())) continue;
        rows.push({
          policy: finding.policyName, intent, actions: [action],
          condition_key: conditionKey.trim(),
          condition_operator: conditionOperator,
          condition_values: conditionValues.split(",").map((v) => v.trim()).filter(Boolean),
        });
        continue;
      }
      if (flatOnly(action)) {
        // A list of ARNs cannot scope it, so the flat Deny is the only statement it has -
        // whatever intent the rest are under. Said in the row, decided here.
        rows.push({ policy: finding.policyName, intent: "deny_action", actions: [action] });
        continue;
      }
      if (isScoped(intent)) {
        if (reachedBy(action).length === 0) continue;
        rows.push({
          policy: finding.policyName, intent, actions: [action],
          resources: resources.get(action) ?? [],
        });
        continue;
      }
      rows.push(intent === "tag_condition"
        ? { policy: finding.policyName, intent, actions: [action], ...tag }
        : { policy: finding.policyName, intent, actions: [action] });
    }
    return rows;
  };

  const writable = chosen.length - unreachable.length - keyless.length;
  /** Prior decisions 적용 will replace - a newer decision, and the row says it is one. */
  const held = new Set(
    restrictions.filter((r) => r.policy === finding.policyName)
      .flatMap((r) => r.actions ?? []),
  );

  return (
    <dialog
      className="picker block-path"
      ref={dialog}
      onCancel={onClose}
      onClick={(e) => { if (e.target === dialog.current) onClose(); }}
    >
      <header>
        <h4>
          이 경로 차단 <span className="muted">— <code>{finding.id}</code> {finding.title}</span>
        </h4>
        <p className="muted">
          여기서 만든 제한은 별도 문서가 아니다 — 아래 정책 구역과 같은 결정 목록에 들어가고, 위의{" "}
          <strong>인라인 정책 보기</strong>가 그 전체를 하나의 문서로 보여준다.
        </p>
      </header>

      <div className="picker-body">
        <label className="control-row">
          형태
          <select value={intent}
                  onChange={(e) => setIntent(e.target.value as Restriction["intent"])}>
            {SECTIONS.map((one) => (
              <option key={one} value={one}>{INTENT_LABEL[one]}</option>
            ))}
          </select>
        </label>
        <p className="muted small">{INTENT_NOTE[intent]}</p>

        <div className="pick-group">
          <span className="pick-head">
            거부할 동작 — <code>{finding.policyName.split("/").pop()}</code>
          </span>
          <div className="pick-level">
            {offer.map(({ action, protected: forbidden }) => {
              const on = selected.has(action) && !forbidden;
              const isFlat = flatOnly(action);
              const reach = reachedBy(action);
              return (
                <div key={action} className="pick-row">
                  <label className={[on ? "pick-item on" : "pick-item", forbidden ? "dead" : ""]
                    .filter(Boolean).join(" ")}
                         title={forbidden
                           ? "선언 경로의 동작입니다. 제한에 넣으면 파이프라인이 이 권한 세트를 읽지 못합니다."
                           : undefined}>
                    <input type="checkbox" checked={on} disabled={forbidden}
                           onChange={() => toggle(action)} />
                    <code className={forbidden ? "deny-forbidden" : undefined}>{action}</code>
                    {isFlat && !forbidden && intent !== "key_condition" && (
                      <span className="rtype" title="자원 목록으로 좁힐 수 없어, 어느 형태를 골라도 동작 자체 거부로 작성됩니다.">
                        동작 자체 거부로 작성
                      </span>
                    )}
                    {held.has(action) && !forbidden && (
                      <span className="rtype">기존 결정을 이 결정으로 바꾼다</span>
                    )}
                  </label>
                  {on && isScoped(intent) && !isFlat && (
                    <button
                      type="button"
                      className={(resources.get(action) ?? []).length === 0 ? "scope empty" : "scope"}
                      title={reach.length === 0
                        ? "이 동작이 닿는 자원이 평가에 없다"
                        : `${action}의 자원을 고른다`}
                      onClick={() => setScoping(action)}
                    >
                      {(resources.get(action) ?? []).length > 0
                        ? `자원 ${(resources.get(action) ?? []).length}개`
                        : (reach.length === 0 ? "자원 없음" : "자원 고르기")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* The card's target list is NOT pre-ticked into the resource picker, and that is a
            decision: targets can be a sample of a larger group, and under 이 자원만 허용 a silently
            adopted sample would deny everything outside an incomplete list. The picker below opens
            on the assessment's enumeration - the same fence the server checks names against. */}

        {intent === "tag_condition" && (
          <fieldset>
            <legend>태그</legend>
            <input type="text" placeholder="env" value={tagKey}
                   onChange={(e) => setTagKey(e.target.value)} />
            <input type="text" placeholder="prod (쉼표로 여러 개)" value={tagValues}
                   onChange={(e) => setTagValues(e.target.value)} />
          </fieldset>
        )}

        {intent === "key_condition" && (
          <fieldset>
            <legend>요청 조건</legend>
            <select value={conditionOperator}
                    onChange={(e) => setConditionOperator(
                      e.target.value as "StringNotEquals" | "StringEquals",
                    )}>
              <option value="StringNotEquals">StringNotEquals — 이 값이 아니면 거부</option>
              <option value="StringEquals">StringEquals — 이 값이면 거부</option>
            </select>
            <input type="text" list={conditionKeyListId}
                   placeholder="lambda:FunctionUrlAuthType" value={conditionKey}
                   onChange={(e) => setConditionKey(e.target.value)} />
            {/* The union of what the chosen actions declare, because a key some of them lack drops
                only those - named in the footer - where the editor's stricter list would offer
                nothing until the selection shrank. */}
            <datalist id={conditionKeyListId}>
              {[...new Set(chosen.flatMap((o) => declaredKeys(o.action)))].sort()
                .map((key) => <option key={key} value={key} />)}
            </datalist>
            <input type="text" placeholder="AWS_IAM (쉼표로 여러 개)" value={conditionValues}
                   onChange={(e) => setConditionValues(e.target.value)} />
          </fieldset>
        )}
      </div>

      <footer>
        <span className="muted">고른 동작 {chosen.length}개</span>
        {needsPick.length > 0 && (
          <span className="unwritable">
            자원을 지정해야 쓸 수 있다 —{" "}
            {needsPick.slice(0, 3).map((o) => o.action).join(", ")}
            {needsPick.length > 3 && ` 외 ${needsPick.length - 3}개`}
          </span>
        )}
        {unreachable.length > 0 && (
          <span className="dropped-actions">
            닿는 자원이 없어 빠진다 —{" "}
            {unreachable.slice(0, 3).map((o) => o.action).join(", ")}
          </span>
        )}
        {keyless.length > 0 && (
          <span className="dropped-actions">
            <code>{conditionKey.trim()}</code> 키를 선언하지 않아 빠진다 —{" "}
            {keyless.slice(0, 3).map((o) => o.action).join(", ")}
            {keyless.length > 3 && ` 외 ${keyless.length - 3}개`}
          </span>
        )}
        <button type="button" className="grow" onClick={onClose}>취소</button>
        <button
          type="button"
          className="commit"
          disabled={writable <= 0 || needsPick.length > 0 || tagMissing || conditionMissing}
          title={tagMissing ? "태그 키와 값이 필요하다"
            : conditionMissing ? "조건 키와 값이 필요하다" : undefined}
          onClick={() => {
            onChange(mergeBlock(restrictions, finding.policyName, additions()));
            onClose();
          }}
        >
          제한에 추가
        </button>
      </footer>

      {scoping !== null && (
        <ResourcePicker
          action={scoping}
          intent={intent}
          groups={reachedBy(scoping)}
          chosen={resources.get(scoping) ?? []}
          onCommit={(picked) => {
            setResources((current) => new Map(current).set(scoping, picked));
            setScoping(null);
          }}
          onCancel={() => setScoping(null)}
        />
      )}
    </dialog>
  );
}

import { useMemo, useState } from "react";
import type {
  Impact as Assessment, ImpactActionReference, ImpactGroup, ImpactPolicy, Restriction,
} from "../types";
import { ActionPicker } from "./ActionPicker";
import type { Offer } from "./ActionPicker";

/**
 * What the permission set will reach, and the place a restriction is chosen.
 *
 * The enumeration is not decoration. It is the input to the restriction: an approver picks resources
 * from this list, and the list is also the fence the server and the inline writer check those names
 * against. So an unscoped grant is enumerated here rather than counted - a count of 47 buckets gives
 * nobody anything to tick.
 *
 * Three things this panel deliberately does NOT do:
 *
 *   it does not offer the baseline      IAMFullAccess is on every governed permission set and
 *                                      expands to every IAM entity in the account. Ticking
 *                                      iam:CreatePolicy would leave the user unable to write a spec,
 *                                      and therefore unable to ask for the fix
 *   it does not build a policy document only decisions travel. A defect here must not be able to
 *                                      write Allow where somebody clicked Deny, so the container
 *                                      composes the statements and refuses anything impossible
 *   it does not hide an incomplete run  a truncated enumeration or a policy that could not be read
 *                                      is said out loud, because a number that reads as complete
 *                                      when it is not is worse than an obvious gap
 */

interface Props {
  assessment: Assessment;
  source: "pushed" | "stored" | null;
  restrictions: Restriction[];
  onChange: (restrictions: Restriction[]) => void;
  disabled: boolean;
}

const INTENT_LABEL: Record<Restriction["intent"], string> = {
  allow_only: "이 자원만 허용 — 이후 생기는 자원은 거부된다",
  deny_only: "이 자원만 거부 — 이후 생기는 자원은 허용된다",
  tag_condition: "태그로 거부 — 나중에 태그가 붙는 자원까지 덮는다",
};

export function Impact({
  assessment, source, restrictions, onChange, disabled,
}: Props) {
  const restrictable = assessment.policies.filter((p) => p.restrictable && !p.unreadable);
  const baseline = assessment.policies.filter((p) => p.is_baseline);
  const unreadable = assessment.policies.filter((p) => p.unreadable);

  const sensitiveTotal = useMemo(
    () =>
      restrictable.reduce(
        (sum, policy) => sum + policy.affected.reduce((n, g) => n + g.sensitive_hits, 0),
        0,
      ),
    [restrictable],
  );

  return (
    <section className="impact">
      <header>
        <h3>영향도 평가</h3>
        <span className="muted">
          {assessment.inventory_as_of} 기준 · 자원 {assessment.allowed_resources.length}개
          {sensitiveTotal > 0 && ` · 민감 ${sensitiveTotal}개`}
          {source === "stored" && " · 버킷에서 읽음"}
        </span>
      </header>

      {!assessment.coverage.complete && (
        <div className="warn">
          <strong>이 평가는 완전하지 않다.</strong>
          <ul>
            {assessment.coverage.services_failed.length > 0 && (
              <li>조회 실패: {assessment.coverage.services_failed.join(", ")}</li>
            )}
            {assessment.coverage.truncated_groups.length > 0 && (
              <li>
                열거가 잘림 {assessment.coverage.truncated_groups.length}건 — 표시된 개수는 최소값이다
                (Resource Explorer가 질의당 1,000건까지만 반환한다)
              </li>
            )}
            {assessment.coverage.policies_unreadable.length > 0 && (
              <li>읽을 수 없는 정책: {assessment.coverage.policies_unreadable.join(", ")}</li>
            )}
          </ul>
        </div>
      )}

      {assessment.current_admin_deny.length > 0 && (
        <div className="warn">
          이 권한 세트에는 이미 관리자 제한 {assessment.current_admin_deny.length}건이 있다.
          <strong> 새 제한은 그것을 대체한다</strong> — 유지할 것은 다시 골라야 한다.
        </div>
      )}

      {restrictable.length === 0 && (
        <p className="muted">제한할 수 있는 정책이 없다. 기반 정책만 붙어 있다.</p>
      )}

      {restrictable.map((policy) => (
        <PolicyBlock
          key={`${policy.source}:${policy.identifier}`}
          policy={policy}
          protectedActions={assessment.protected_actions}
          restrictions={restrictions}
          onChange={onChange}
          disabled={disabled}
          reference={assessment.action_reference ?? null}
          referenceError={assessment.coverage.reference ?? null}
          omitted={assessment.coverage.action_lists_omitted ?? []}
        />
      ))}

      {baseline.length > 0 && (
        <details className="baseline">
          <summary>기반 정책 {baseline.length}개 — 제한 대상이 아니다</summary>
          <p className="muted">
            모든 거버넌스 사용자에게 권한 세트 계층에서 부여된다. 사용자의 선언 안에 없으므로 떼어낼 수
            없고, 그래서 자기 잠금이 불가능하다. 제한하면 사용자가 spec을 쓸 수 없게 되므로 여기서는
            열거하지 않는다.
          </p>
          <ul>
            {baseline.map((p) => (
              <li key={p.identifier}>
                <code>{p.identifier}</code>
              </li>
            ))}
          </ul>
        </details>
      )}

      {unreadable.length > 0 && (
        <div className="error">
          다음 정책의 본문을 읽지 못했다. <strong>부여하는 것이 없다는 뜻이 아니다.</strong>
          <ul>
            {unreadable.map((p) => (
              <li key={p.identifier}>
                <code>{p.identifier}</code> — {p.unreadable}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PolicyBlock({
  policy,
  protectedActions,
  restrictions,
  onChange,
  disabled,
  reference,
  referenceError,
  omitted,
}: {
  policy: ImpactPolicy;
  protectedActions: string[];
  restrictions: Restriction[];
  onChange: (restrictions: Restriction[]) => void;
  disabled: boolean;
  reference: ImpactActionReference | null;
  referenceError: string | null;
  omitted: string[];
}) {
  const mine = restrictions.find((r) => r.policy === policy.identifier) ?? null;

  // Wildcards cannot be restricted - with NotResource a wildcard action denies everything outside the
  // list, including the baseline. What the policy literally names is offered as its own group; the
  // concrete actions BEHIND a wildcard now arrive in actions_offerable, expanded by the container from
  // the AWS Service Reference, which is what this page could never do for itself.
  const offerable = policy.actions_granted.filter(
    (a) => !a.includes("*") && !protectedActions.includes(a),
  );
  const blocked = policy.actions_granted.filter((a) => protectedActions.includes(a));

  const set = (next: Restriction | null) => {
    const others = restrictions.filter((r) => r.policy !== policy.identifier);
    onChange(next ? [...others, next] : others);
  };

  return (
    <details className="policy" open={policy.affected.some((g) => g.sensitive_hits > 0)}>
      <summary>
        <code>{policy.identifier}</code>
        <span className="muted">
          {" "}
          {policy.affected.reduce((n, g) => n + g.total, 0)}개 자원
          {policy.affected.some((g) => g.sensitive_hits > 0) && " · 민감 포함"}
          {policy.default_version_id && ` · ${policy.default_version_id}`}
        </span>
      </summary>

      {policy.affected.length === 0 && (
        <p className="muted">이 정책이 닿는 자원이 인벤토리에 없다.</p>
      )}

      {policy.affected.map((group) => (
        <GroupBlock key={`${group.service}:${group.resource_type}`} group={group} />
      ))}

      {blocked.length > 0 && (
        <p className="muted">
          제한할 수 없는 동작: {blocked.map((a) => <code key={a}>{a} </code>)} — 선언 경로다.
        </p>
      )}

      <div className="restrict">
        <label>
          <input
            type="checkbox"
            disabled={disabled}
            checked={Boolean(mine)}
            onChange={(e) =>
              set(
                e.target.checked
                  ? { policy: policy.identifier, intent: "allow_only", actions: [], resources: [] }
                  : null,
              )
            }
          />{" "}
          이 정책에 제한을 건다
        </label>

        {mine && (
          <RestrictionEditor
            restriction={mine}
            groups={policy.affected}
            offerable={offerable}
            granted={policy.actions_offerable ?? []}
            protectedActions={protectedActions}
            disabled={disabled}
            onChange={set}
            reference={reference}
            referenceError={referenceError}
            omitted={omitted}
          />
        )}
      </div>
    </details>
  );
}

function GroupBlock({ group }: { group: ImpactGroup }) {
  return (
    <div className="group">
      <div className="group-head">
        <code>{group.resource_type}</code>
        <span className="muted">
          {" "}
          {group.total}개{group.truncated && " 이상 (잘림)"} · 범위 {group.scope} ·{" "}
          {group.actions.join(", ")}
        </span>
        {/* The actions above are the ones that reach this type. When the reference could not decide
            that, the group is every resource of the service and the actions beside it may not touch any
            of them - which is what this whole panel used to do silently. */}
        {group.attribution === "service" && (
          <span className="badge badge-warn" title={
            "이 서비스의 자원 전부이다. 참조가 동작별 자원 유형을 판정하지 못해, 옆의 동작이 이 자원에 "
            + "작용하지 않을 수 있다."
          }> 서비스 단위</span>
        )}
      </div>
      <ul className="resources">
        {group.resources.slice(0, 50).map((resource) => (
          <li key={resource.arn} className={resource.sensitive ? "sensitive" : undefined}>
            <code>{resource.arn}</code>
            {Object.entries(resource.tags).length > 0 && (
              <span className="tags">
                {Object.entries(resource.tags)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")}
              </span>
            )}
          </li>
        ))}
        {group.resources.length > 50 && (
          <li className="muted">…그리고 {group.resources.length - 50}개 더</li>
        )}
      </ul>
    </div>
  );
}

function RestrictionEditor({
  restriction,
  groups,
  offerable,
  granted,
  protectedActions,
  disabled,
  onChange,
  reference,
  referenceError,
  omitted,
}: {
  restriction: Restriction;
  groups: ImpactGroup[];
  offerable: string[];
  /** Every concrete action this policy grants, wildcards already expanded by the container. */
  granted: string[];
  protectedActions: string[];
  disabled: boolean;
  onChange: (next: Restriction) => void;
  reference: ImpactActionReference | null;
  referenceError: string | null;
  omitted: string[];
}) {
  const [picking, setPicking] = useState(false);
  const everyArn = groups.flatMap((g) => g.resources.map((r) => r.arn));

  // Keyed off what the policy GRANTS, never off the enumerated groups.
  //
  // That distinction is the whole point. Fixing the attribution defect removes ec2's groups from
  // AmazonDynamoDBFullAccess - correctly, since its three ec2 describes reach nothing - and keying the
  // offer off groups would therefore make those three actions unrestrictable. The fix would have taken
  // away the ability to restrict exactly what it stopped over-reporting.
  const { covered, uncovered } = useMemo(() => {
    const services = [...new Set(granted.map((a) => a.split(":", 1)[0]))].sort();
    const listed: { service: string; offers: Offer[] }[] = [];
    const missing: string[] = [];
    for (const service of services) {
      const block = reference?.services[service];
      const offers = granted
        .filter((a) => a.startsWith(`${service}:`))
        .map((action): Offer | null => {
          const entry = block?.[action.slice(service.length + 1)];
          if (!entry) return null;
          return {
            action,
            access: entry[0],
            resources: entry[1],
            // No resource type at all. generator/restriction.py refuses an allow_only restriction on
            // one of these, so the picker greys it out for that intent.
            account_level: entry[1].length === 0,
          };
        })
        .filter((o): o is Offer => o !== null);
      if (offers.length > 0) listed.push({ service, offers });
      else missing.push(service);
    }
    return { covered: listed, uncovered: missing };
  }, [granted, reference]);

  const toggleResource = (arn: string) => {
    const current = restriction.resources ?? [];
    const resources = current.includes(arn)
      ? current.filter((a) => a !== arn)
      : [...current, arn];
    onChange({ ...restriction, resources });
  };

  return (
    <div className="editor">
      <label>
        의도
        <select
          disabled={disabled}
          value={restriction.intent}
          onChange={(e) =>
            onChange({
              ...restriction,
              intent: e.target.value as Restriction["intent"],
              // The three forms take different inputs. Carrying a resource list into a tag condition
              // would send something the server refuses, and refusing it here would be a worse
              // message than simply clearing it.
              resources: e.target.value === "tag_condition" ? [] : restriction.resources,
            })
          }
        >
          {(Object.keys(INTENT_LABEL) as Restriction["intent"][]).map((intent) => (
            <option key={intent} value={intent}>
              {INTENT_LABEL[intent]}
            </option>
          ))}
        </select>
      </label>

      {/* A button, not a list. The offering is in a dialog with its own search and scroll: this page
          is where a plan is read and approved, and one service with several hundred actions would
          push the plan off the screen. What is chosen stays here, because it is part of the decision
          and has to be readable without opening anything. */}
      <fieldset>
        <legend>동작</legend>

        <div className="pick-open">
          <button type="button" disabled={disabled} onClick={() => setPicking(true)}>
            동작 고르기
            {restriction.actions.length > 0 && ` (${restriction.actions.length}개)`}
          </button>
          <span className="muted">
            {covered.length > 0
              && `${covered.map((c) => `${c.service} ${c.offers.length}개`).join(", ")} 중에서 고른다`}
            {covered.length > 0 && uncovered.length > 0 && " · "}
            {uncovered.length > 0 && `${uncovered.join(", ")}는 이름을 직접 적는다`}
          </span>
        </div>

        {restriction.actions.length > 0 ? (
          <p className="muted chosen">
            {restriction.actions.map((a) => (
              <code key={a}>{a} </code>
            ))}
          </p>
        ) : (
          <p className="warn-inline">
            동작을 하나 이상 골라야 한다. 동작 없는 제한은 목록 밖 전부를 거부한다.
          </p>
        )}

        {referenceError && (
          <p className="warn-inline">
            평가가 동작 목록을 싣지 못했다 ({referenceError}). 목록 대신 이름을 직접 적으면 된다 —
            서버와 인라인 작성기가 어차피 검사한다.
          </p>
        )}

        {omitted.length > 0 && (
          <p className="warn-inline">
            {omitted.join(", ")}의 동작 목록은 크기 제한을 넘어 평가에 실리지 않았다. 이름을 직접
            적으면 된다.
          </p>
        )}

        {picking && (
          <ActionPicker
            policy={restriction.policy}
            intent={restriction.intent}
            chosen={restriction.actions}
            named={offerable}
            covered={covered}
            uncovered={uncovered}
            referenceError={referenceError}
            protectedActions={protectedActions}
            onCommit={(actions) => {
              onChange({ ...restriction, actions });
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        )}
      </fieldset>

      {restriction.intent === "tag_condition" ? (
        <fieldset>
          <legend>태그</legend>
          <input
            type="text"
            placeholder="env"
            disabled={disabled}
            value={restriction.tag_key ?? ""}
            onChange={(e) => onChange({ ...restriction, tag_key: e.target.value })}
          />
          <input
            type="text"
            placeholder="prod (쉼표로 여러 개)"
            disabled={disabled}
            value={(restriction.tag_values ?? []).join(",")}
            onChange={(e) =>
              onChange({
                ...restriction,
                tag_values: e.target.value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
        </fieldset>
      ) : (
        <fieldset>
          <legend>
            {restriction.intent === "allow_only" ? "허용할 자원 (나머지 거부)" : "거부할 자원"}
          </legend>
          {restriction.intent === "allow_only" && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...restriction, resources: everyArn })}
            >
              전부 선택
            </button>
          )}
          {groups.flatMap((group) =>
            group.resources.map((resource) => (
              <label key={resource.arn} className={resource.sensitive ? "inline sensitive" : "inline"}>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={(restriction.resources ?? []).includes(resource.arn)}
                  onChange={() => toggleResource(resource.arn)}
                />{" "}
                <code>{resource.arn}</code>
              </label>
            )),
          )}
          {(restriction.resources ?? []).length === 0 && (
            <p className="warn-inline">자원을 하나 이상 골라야 한다.</p>
          )}
        </fieldset>
      )}
    </div>
  );
}

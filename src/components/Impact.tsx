import { useMemo, useState } from "react";
import type {
  Impact as Assessment, ImpactActionReference, ImpactGroup, ImpactPolicy, Restriction,
} from "../types";
import { consoleListUrl } from "../../server/consoleLinks.js";
import { parseArn } from "../../server/arn.js";
import { ResourceName, uniform } from "./ResourceName";
import { ServiceIcon } from "./ServiceIcon";
import { ActionPicker } from "./ActionPicker";
import type { Choice, Offer } from "./ActionPicker";

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

/** Vendor prefix and access suffix AWS puts around the service name in a managed policy name. */
const VENDOR = /^(aws|amazon)/;
const SUFFIX = /(fullaccess|readonlyaccess|readonly|poweruser|administrator|access)$/;

/**
 * Which service an AWS managed policy is ABOUT, or null when nothing says.
 *
 * AWSLambda_FullAccess is about lambda. It also reaches every CloudFormation stack and KMS key in the
 * account, because a Lambda function refers to those - but an approver who opened that policy came to
 * decide about functions, and 15 stacks above the 3 functions buries the thing they came for.
 *
 * Read off the name rather than from a table. The name is the only statement of what a policy is for,
 * and AWS writes it consistently: a vendor prefix, the service, an access suffix. Stripping those three
 * leaves the service, and it is only believed when it resolves to a service this policy actually names -
 * so a policy whose name does not decompose (AWSLambdaBasicExecutionRole) hides nothing.
 *
 * Customer managed policies are named by whoever wrote them. mirror-cmp-Reporting says nothing about a
 * service, so nothing is folded away and the panel behaves as it did.
 */
function primaryService(identifier: string, candidates: string[]): string | null {
  if (!identifier.startsWith("arn:aws:iam::aws:policy/")) return null;
  const bare = identifier.slice(identifier.lastIndexOf("/") + 1).toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const stem = bare.replace(VENDOR, "").replace(SUFFIX, "");
  if (!stem) return null;

  // Longest first, so s3-object-lambda wins over s3 for a policy about the former.
  const ordered = [...new Set(candidates)].sort((a, b) => b.length - a.length);
  return (
    ordered.find((service) => stem === service)
    ?? ordered.find((service) => stem.startsWith(service))
    // Loose containment only for a name long enough not to collide by accident. Two- and
    // three-letter prefixes - es, s3, kms, sts - turn up inside unrelated words: "access" alone
    // contains "es", which would make every policy in existence look like an Elasticsearch policy.
    ?? ordered.find((service) => service.length >= 4 && bare.includes(service))
    ?? null
  );
}

/**
 * The permission set inline policy quota. NOT the 32,768 the API accepts.
 *
 * A permission set provisions as an IAM role in the target account, so it is bound by the role's inline
 * policy limit, and that one is not increasable. A document between the two is stored successfully and
 * then fails at ProvisionPermissionSet - after somebody approved it. So the size is estimated here,
 * before the approval, and generator/restriction.py measures it exactly before it writes.
 */
const INLINE_LIMIT = 10240;

/** Roughly what these choices will serialise to. The same statement shape restriction.py builds. */
function estimateBytes(intent: Restriction["intent"], choices: Choice[], tag: string): number {
  const statements = choices.map((choice, n) => (intent === "tag_condition"
    ? {
      Sid: `AdminDeny${n + 1}`, Effect: "Deny", Action: choice.action, Resource: "*",
      Condition: { StringEquals: { [`aws:ResourceTag/${tag}`]: [] } },
    }
    : {
      Sid: `AdminDeny${n + 1}`,
      Effect: "Deny",
      Action: choice.action,
      ...(intent === "allow_only"
        ? { NotResource: choice.resources }
        : { Resource: choice.resources.length > 0 ? choice.resources : "*" }),
    }));
  return JSON.stringify({ Version: "2012-10-17", Statement: statements }).length;
}

/**
 * The policy as a person names it, with where it came from beside it.
 *
 * The two sources write identifier differently - the assessment carries the full ARN for an AWS
 * managed policy and the BARE NAME for a customer managed one (the container builds the member ARN
 * itself) - so the ARN is parsed down to its name and a non-ARN passes through untouched. The full
 * identifier stays on the hover title: it is what a restriction is keyed by.
 */
function policyName(identifier: string): string {
  return parseArn(identifier)?.name ?? identifier;
}

/**
 * The inventory timestamp as a person reads it, in the VIEWER's own timezone.
 *
 * The document carries 2026-08-15T08:51:11.495443Z - microseconds and a Z suffix that make an
 * approver do UTC arithmetic in their head. The date and the time are split and labelled, and the
 * conversion uses the browser's timezone because the person deciding is the reference point, not
 * the container that wrote the document. A value that does not parse is shown raw: a wrong-looking
 * timestamp is a prompt to ask, a hidden one is not.
 */
function assessedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return `평가 시각: ${iso}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  return `평가 날짜: ${date}, 평가 시간: ${time}`;
}

const SOURCE_LABEL: Record<ImpactPolicy["source"], string> = {
  aws_managed: "AWS Managed",
  customer_managed: "Customer Managed",
};

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
        <div className="assessed muted">
          <span>{assessedAt(assessment.inventory_as_of)}</span>
          <span>
            연관 자원: {assessment.allowed_resources.length}개
            {sensitiveTotal > 0 && ` · 민감 ${sensitiveTotal}개`}
            {source === "stored" && " · 버킷에서 읽음"}
          </span>
        </div>
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
              <li>
                읽을 수 없는 정책:{" "}
                {assessment.coverage.policies_unreadable.map(policyName).join(", ")}
              </li>
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
          accountId={assessment.account_id}
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
                <code title={p.identifier}>{policyName(p.identifier)}</code>
                <span className="policy-source">({SOURCE_LABEL[p.source]})</span>
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
                <code title={p.identifier}>{policyName(p.identifier)}</code>
                <span className="policy-source">({SOURCE_LABEL[p.source]})</span>
                {" "}— {p.unreadable}
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
  accountId,
  protectedActions,
  restrictions,
  onChange,
  disabled,
  reference,
  referenceError,
  omitted,
}: {
  policy: ImpactPolicy;
  /** The governed account, for the console list links. The host of those URLs carries it. */
  accountId: string;
  protectedActions: string[];
  restrictions: Restriction[];
  onChange: (restrictions: Restriction[]) => void;
  disabled: boolean;
  reference: ImpactActionReference | null;
  referenceError: string | null;
  omitted: string[];
}) {
  // Every restriction on this policy - one per action, because generator/restriction.py writes one
  // statement per action and each of those statements now carries its own resources. A single
  // restriction holding several actions and one shared resource list is what made the ARN shapes
  // collide, so the page no longer builds one.
  const ours = restrictions.filter((r) => r.policy === policy.identifier);

  // Wildcards cannot be restricted - with NotResource a wildcard action denies everything outside the
  // list, including the baseline. What the policy literally names is offered as its own group; the
  // concrete actions BEHIND a wildcard now arrive in actions_offerable, expanded by the container from
  // the AWS Service Reference, which is what this page could never do for itself.
  const offerable = policy.actions_granted.filter(
    (a) => !a.includes("*") && !protectedActions.includes(a),
  );
  const blocked = policy.actions_granted.filter((a) => protectedActions.includes(a));

  // Primary first, everything else behind one click. Derived from every service this policy mentions -
  // its actions, not only its enumerated groups - so the primary service still resolves when the
  // account happens to hold none of its resources.
  const { primary, shown, related } = useMemo(() => {
    const mentioned = [
      ...policy.actions_granted,
      ...(policy.actions_offerable ?? []),
    ].map((a) => a.split(":", 1)[0]).filter(Boolean);
    const found = primaryService(
      policy.identifier,
      [...mentioned, ...policy.affected.map((g) => g.service)],
    );
    if (!found) return { primary: null, shown: policy.affected, related: [] as ImpactGroup[] };
    return {
      primary: found,
      shown: policy.affected.filter((g) => g.service === found),
      related: policy.affected.filter((g) => g.service !== found),
    };
  }, [policy]);

  const relatedServices = [...new Set(related.map((g) => g.service))].sort();
  const relatedSensitive = related.some((g) => g.sensitive_hits > 0);

  const set = (next: Restriction[]) => {
    const others = restrictions.filter((r) => r.policy !== policy.identifier);
    onChange([...others, ...next]);
  };

  return (
    <details className="policy" open={policy.affected.some((g) => g.sensitive_hits > 0)}>
      <summary>
        {primary && <ServiceIcon service={primary} />}
        <code title={policy.identifier}>{policyName(policy.identifier)}</code>
        <span className="policy-source">({SOURCE_LABEL[policy.source]})</span>
        <span className="muted">
          {" "}
          {primary
            ? `${primary} ${shown.reduce((n, g) => n + g.total, 0)}개`
            : `${policy.affected.reduce((n, g) => n + g.total, 0)}개 자원`}
          {related.length > 0 && ` · 연관 ${related.reduce((n, g) => n + g.total, 0)}개`}
          {policy.affected.some((g) => g.sensitive_hits > 0) && " · 민감 포함"}
          {policy.default_version_id && ` · ${policy.default_version_id}`}
        </span>
      </summary>

      {policy.affected.length === 0 && (
        <p className="muted">이 정책이 닿는 자원이 인벤토리에 없다.</p>
      )}

      {shown.map((group) => (
        <GroupBlock key={`${group.service}:${group.resource_type}`} group={group} accountId={accountId} />
      ))}

      {primary && shown.length === 0 && policy.affected.length > 0 && (
        <p className="muted">
          {primary} 자원이 인벤토리에 없다. 이 정책이 닿는 것은 아래 연관 자원뿐이다.
        </p>
      )}

      {related.length > 0 && (
        // Open when there is nothing above it, and open when it holds a sensitive resource. Folding a
        // resource somebody has to see behind a click is the one thing this must not do.
        <details className="related" open={shown.length === 0 || relatedSensitive}>
          <summary>
            연관 자원 {related.reduce((n, g) => n + g.total, 0)}개 — {relatedServices.join(", ")}
            {relatedSensitive && " · 민감 포함"}
          </summary>
          <p className="muted">
            {primary} 작업을 위해 함께 부여된 권한이 닿는 자원이다. 제한 대상으로 고를 수는 있다 —
            여기 있는 것은 승인자가 이 정책을 열어 본 이유가 아니라는 뜻일 뿐이다.
          </p>
          {related.map((group) => (
            <GroupBlock key={`${group.service}:${group.resource_type}`} group={group} accountId={accountId} />
          ))}
        </details>
      )}

      {blocked.length > 0 && (
        <p className="muted">
          제한할 수 없는 동작: {blocked.map((a) => <code key={a}>{a} </code>)} — 선언 경로다.
        </p>
      )}

      {/* No checkbox in front of this. There used to be one - "이 정책에 제한을 건다" - and it was a
          second door in front of a door: the policy block is already collapsed, so opening it is the
          statement of intent, and a tick inside it only asked the same question again. What a
          restriction IS is the actions chosen; nothing is sent for a policy with none, so the state the
          checkbox held is a state the data already has. */}
      <div className="restrict">
        <span className="restrict-head">제한</span>
        <RestrictionEditor
          policy={policy.identifier}
          primary={primary}
          existing={ours}
          affected={policy.affected}
          offerable={offerable}
          granted={policy.actions_offerable ?? []}
          protectedActions={protectedActions}
          disabled={disabled}
          onChange={set}
          reference={reference}
          referenceError={referenceError}
          omitted={omitted}
        />
      </div>
    </details>
  );
}

function GroupBlock({ group, accountId }: { group: ImpactGroup; accountId: string }) {
  // The console LIST page for this resource type - the list, deliberately not any one resource's
  // detail page: the approver is deciding about the set, and a deep link would pick one for them.
  //
  // One link per region the enumerated resources actually sit in, because a console list page shows
  // a single region. Deduplicated by URL, which folds the global consoles (IAM ignores region, so
  // every region builds the same address) down to one link. consoleListUrl answers null for an
  // unmapped type or a malformed account/region, and null renders as nothing - no link is better
  // than a wrong one.
  const consoles = useMemo(() => {
    const regions = [...new Set(group.resources.map((r) => r.region || "global"))].sort();
    const seen = new Set<string>();
    const links: { region: string; url: string }[] = [];
    for (const region of regions) {
      const url = consoleListUrl(accountId, region, group.resource_type);
      if (url && !seen.has(url)) {
        seen.add(url);
        links.push({ region, url });
      }
    }
    return links;
  }, [group, accountId]);

  // The constant parts of the rows, said ONCE here so the rows can stop repeating them. null
  // means the group is mixed for that dimension, and every row then says its own - a cross-region
  // resource hiding in a uniform-looking list is what an approver must not miss.
  const groupRegion = uniform(group.resources.map((r) => r.region || parseArn(r.arn)?.region));
  const groupAccount = uniform(group.resources.map((r) => parseArn(r.arn)?.account || undefined));

  return (
    <div className="group">
      <div className="group-head">
        <ServiceIcon service={group.service} />
        <code>{group.resource_type}</code>
        <span className="muted">
          {" "}
          {group.total}개{group.truncated && " 이상 (잘림)"} · 범위 {group.scope}
          {groupRegion && ` · ${groupRegion}`}
          {groupAccount && ` · 계정 ${groupAccount}`}
        </span>
        {consoles.map(({ region, url }) => (
          <a
            key={url}
            className="console-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="관리콘솔의 자원 목록 페이지. 로그인된 Identity Center 세션이 있으면 그 세션으로 열린다."
          >
            관리콘솔{consoles.length > 1 ? ` ${region}` : ""} ↗
          </a>
        ))}
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

      {/* Folded, for every resource type. lambda:function carries 60 granted actions and printing them
          inline pushed the resource list - the thing an approver actually picks from - off the screen.
          The count is the part that is read at a glance; the names are what you open when you are
          deciding. */}
      {group.actions.length > 0 && (
        <details className="group-actions">
          <summary>동작 {group.actions.length}개</summary>
          <p>
            {group.actions.map((action) => (
              <code key={action}>{action} </code>
            ))}
          </p>
        </details>
      )}

      <ul className="resources">
        {group.resources.slice(0, 50).map((resource) => (
          <li key={resource.arn} className={resource.sensitive ? "sensitive" : undefined}>
            <ResourceName
              arn={resource.arn}
              groupRegion={groupRegion}
              groupAccount={groupAccount}
            />
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
  policy,
  primary,
  existing,
  affected,
  offerable,
  granted,
  protectedActions,
  disabled,
  onChange,
  reference,
  referenceError,
  omitted,
}: {
  policy: string;
  /** The service this policy is named for, or null. Its actions go first; the rest fold away. */
  primary: string | null;
  existing: Restriction[];
  affected: ImpactGroup[];
  offerable: string[];
  /** Every concrete action this policy grants, wildcards already expanded by the container. */
  granted: string[];
  protectedActions: string[];
  disabled: boolean;
  onChange: (next: Restriction[]) => void;
  reference: ImpactActionReference | null;
  referenceError: string | null;
  omitted: string[];
}) {
  const [picking, setPicking] = useState(false);

  // The draft, seeded once. Every change emits the whole set upward, so the parent's array stays the
  // single source of truth for what gets submitted while this holds the parts a restriction needs
  // before it is one - an intent with no actions yet, or a tag key half typed.
  const [intent, setIntent] = useState<Restriction["intent"]>(
    () => existing[0]?.intent ?? "allow_only",
  );
  const [choices, setChoices] = useState<Choice[]>(
    () => existing.flatMap((r) => r.actions.map((action) => ({
      action, resources: r.resources ?? [],
    }))),
  );
  const [tagKey, setTagKey] = useState(() => existing[0]?.tag_key ?? "");
  const [tagValues, setTagValues] = useState(() => (existing[0]?.tag_values ?? []).join(","));

  /** One restriction per action, which is one statement per action once the container builds it. */
  const emit = (
    nextIntent: Restriction["intent"],
    nextChoices: Choice[],
    key = tagKey,
    values = tagValues,
  ) => {
    setIntent(nextIntent);
    setChoices(nextChoices);
    setTagKey(key);
    setTagValues(values);
    onChange(nextChoices.map((choice) => ({
      policy,
      intent: nextIntent,
      actions: [choice.action],
      ...(nextIntent === "tag_condition"
        ? {
          tag_key: key.trim(),
          tag_values: values.split(",").map((v) => v.trim()).filter(Boolean),
        }
        : { resources: choice.resources }),
    })));
  };

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
    // The policy's own service first, for the same reason its resources go first on the page: an
    // approver who opened AWSLambda_FullAccess is looking for a lambda action, and 3 cloudformation
    // actions ahead of 90 lambda ones is 3 things to scroll past every time.
    listed.sort((a, b) => {
      if (a.service === primary) return -1;
      if (b.service === primary) return 1;
      return a.service.localeCompare(b.service);
    });
    return { covered: listed, uncovered: missing };
  }, [granted, reference, primary]);


  return (
    <div className="editor">
      <label>
        의도
        <select
          disabled={disabled}
          value={intent}
          onChange={(e) => {
            // The three forms take different inputs. A tag condition names no resources, so the
            // per-action lists are dropped rather than sent and refused - and the actions are kept,
            // because those are still what the condition applies to.
            const next = e.target.value as Restriction["intent"];
            emit(next, next === "tag_condition"
              ? choices.map((c) => ({ ...c, resources: [] }))
              : choices);
          }}
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
            동작과 자원 고르기
            {choices.length > 0 && ` (${choices.length}개)`}
          </button>
          <span className="muted">
            {covered.length > 0
              && `${covered.map((c) => `${c.service} ${c.offers.length}개`).join(", ")} 중에서 고른다`}
            {covered.length > 0 && uncovered.length > 0 && " · "}
            {uncovered.length > 0 && `${uncovered.join(", ")}는 이름을 직접 적는다`}
          </span>
        </div>

        {choices.length > 0 ? (
          <ul className="chosen-list">
            {choices.map((choice) => (
              <li key={choice.action}>
                <code>{choice.action}</code>
                <span className="muted">
                  {intent === "tag_condition"
                    ? "태그 조건"
                    : (choice.resources.length > 0
                      ? `자원 ${choice.resources.length}개`
                      : "자원 미지정")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted none-chosen">
            고른 동작이 없다 — 이 정책에는 제한이 걸리지 않는다.
          </p>
        )}

        {(() => {
          // Estimated, and said so. The exact number depends on statements this write preserves, which
          // only the container can see - but a restriction that is going to be refused for size should
          // not get as far as an approval marker to find that out.
          const bytes = estimateBytes(intent, choices, tagKey);
          if (choices.length === 0 || bytes <= INLINE_LIMIT * 0.8) return null;
          return (
            <p className={bytes > INLINE_LIMIT ? "error" : "warn-inline"}>
              인라인 정책 예상 크기 약 {bytes.toLocaleString()}바이트
              {bytes > INLINE_LIMIT
                ? ` — 권한 세트 한도 ${INLINE_LIMIT.toLocaleString()}바이트를 넘는다. 이대로면 인라인
                   작성기가 거부한다. 동작을 줄이거나 태그 조건을 쓰면 된다 — 태그 조건은 몇 개를 덮든
                   문장 하나다.`
                : ` (한도 ${INLINE_LIMIT.toLocaleString()}바이트)`}
            </p>
          );
        })()}

        {/* Not refused here. For an action that reaches nothing - a List action, or one whose resource
            type is absent from the account - having no resources is the only correct state, and it is
            the container that knows which of those is a legitimate flat deny. */}
        {intent !== "tag_condition" && choices.some((c) => c.resources.length === 0) && (
          <p className="warn-inline">
            자원을 지정하지 않은 동작이 있다. 자원을 지목하지 않는 계정 단위 동작이면 그대로 두면 되고
            (동작 자체가 거부된다), 그렇지 않으면 서버가 이유를 말하며 거부한다.
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
            policy={policy}
            intent={intent}
            chosen={choices}
            named={offerable}
            covered={covered}
            uncovered={uncovered}
            referenceError={referenceError}
            protectedActions={protectedActions}
            affected={affected}
            primary={primary}
            onCommit={(next) => {
              emit(intent, next);
              setPicking(false);
            }}
            onCancel={() => setPicking(false)}
          />
        )}
      </fieldset>

      {intent === "tag_condition" && (
        <fieldset>
          <legend>태그</legend>
          <input
            type="text"
            placeholder="env"
            disabled={disabled}
            value={tagKey}
            onChange={(e) => emit(intent, choices, e.target.value, tagValues)}
          />
          <input
            type="text"
            placeholder="prod (쉼표로 여러 개)"
            disabled={disabled}
            value={tagValues}
            onChange={(e) => emit(intent, choices, tagKey, e.target.value)}
          />
        </fieldset>
      )}

      {/* There is no resource fieldset. Resources belong to an action, so they are chosen from the
          action's own row - see ResourcePicker. A shared list on this page could not express
          "kms:DescribeKey on the Lambda key only", and it silently paired every chosen action with
          every chosen resource. */}
    </div>
  );
}

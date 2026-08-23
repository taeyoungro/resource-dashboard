import { useMemo, useRef, useState } from "react";
import type {
  Impact as Assessment, ImpactActionReference, ImpactGroup, ImpactPassRoleGrant, ImpactPolicy,
  ImpactResource, Restriction,
} from "../types";
import { consoleListUrl } from "../../server/consoleLinks.js";
import { parseArn } from "../../server/arn.js";
import { localDate, localTime } from "../time";
import { ServiceIcon } from "./ServiceIcon";
import { ActionPicker } from "./ActionPicker";
import type { Choice, Offer } from "./ActionPicker";
import {
  INLINE_LIMIT, composeInline, inlineBytes, policyContribution, readable, readableStatements,
} from "../../server/inlinePreview.js";
import { serviceFold } from "../../server/serviceFold.js";

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
 *   it does not hide an incomplete run  a truncated enumeration is marked on its own group
 *                                      ("이상 (잘림)") and an unreadable policy is listed with its
 *                                      reason at the bottom, because a number that reads as
 *                                      complete when it is not is worse than an obvious gap
 *
 * Two banners this panel USED to show were removed on the operator's direction: the coverage
 * summary ("이 평가는 완전하지 않다") and the existing-admin-deny replacement warning. The second
 * described the current inline writer, which replaces AdminDeny* statements wholesale; the planned
 * terraform-managed inline structure preserves what is already written, and the warning would then
 * assert a behavior the pipeline no longer has. Until that lands, the replacement behavior still
 * exists - it is just no longer announced here. The per-group truncation mark and the bottom
 * unreadable-policy block carry what the coverage banner carried - and failed service lookups get
 * one conditional line below the header, because a service whose enumeration THREW renders
 * identically to a service with nothing reachable, and that is a difference an approver has to
 * see. It is not the removed banner returning: it renders only when a lookup actually failed.
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
 * Brand stems whose IAM action prefix shares no spelling with them.
 *
 * The stem of AmazonEventBridgeReadOnlyAccess is "eventbridge", and EventBridge's actions are
 * events:* - no prefix test, startsWith or containment connects the two, so the policy rendered
 * with no primary service at all ("2개 자원", no icon, no related fold). Same for Step Functions
 * (states:*), KMS (spelled out in policy names), ACM and Systems Manager. The alias is only
 * BELIEVED when the aliased prefix is among the services this policy actually names - the same
 * rule every other resolution path here follows.
 */
const BRAND_STEM: Record<string, string> = {
  eventbridge: "events",
  stepfunctions: "states",
  keymanagementservice: "kms",
  certificatemanager: "acm",
  systemsmanager: "ssm",
};

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
    ?? (BRAND_STEM[stem] && ordered.includes(BRAND_STEM[stem]) ? BRAND_STEM[stem] : null)
  );
}


/**
 * Whether an action operates BELOW the resource an index can hold - so the ARN picked for it is a
 * container and the statement needs what is inside it too.
 *
 * The writer asks generator/actions.Table.under_another_type. This asks the same question of the
 * same data: the reference names each action's resource types, and nested_types names the types
 * that sit under another one. No reference, or an assessment written before it carried the map,
 * means no expansion - which is what those assessments were written under.
 */
function nestedActions(reference: ImpactActionReference | null): (action: string) => boolean {
  const nested = reference?.nested_types ?? {};
  return (action: string) => {
    const [service, name] = [action.slice(0, action.indexOf(":")), action.slice(action.indexOf(":") + 1)];
    const types = nested[service];
    if (!types?.length) return false;
    const entry = reference?.services?.[service]?.[name];
    return Boolean(entry?.[1]?.some((t) => types.includes(t)));
  };
}

/** Which services the PassRole fence will name. Its statements are in the same document. */
function fenceServicesOf(grants: Assessment["passrole_grants"]): string[] {
  return [...new Set((grants ?? []).flatMap((g) => g.services))].filter(Boolean).sort();
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
  return `평가 날짜: ${localDate(at)}, 평가 시간: ${localTime(at)}`;
}

const SOURCE_LABEL: Record<ImpactPolicy["source"], string> = {
  aws_managed: "AWS Managed",
  customer_managed: "Customer Managed",
};

/**
 * The whole inline policy these choices become, behind a button.
 *
 * A preview, and it says so. The container recomposes from the decisions and refuses what it will
 * not write - which is why decisions cross the wire and not documents - so this cannot be the
 * authority. What it answers is the question the page could not: an administrator who ticked eleven
 * actions across four policies was approving a description of a document rather than the document.
 *
 * server/inlinePreview.js composes it, and a fixture test pins that module byte-for-byte against
 * generator/restriction.py. A preview that differs from what gets written would be worse than none.
 */
function InlinePreview({ restrictions, accountId, fenceServices, nested }: {
  restrictions: Restriction[];
  accountId: string;
  fenceServices: string[];
  nested: (action: string) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = restrictions.filter((r) => r.actions.length > 0);
  const { document: composed, bytes } = useMemo(() => {
    const doc = composeInline(active, { accountId, fenceServices, nested });
    return { document: doc, bytes: inlineBytes(doc) };
  }, [active, accountId, fenceServices, nested]);

  if (active.length === 0 && fenceServices.length === 0) return null;
  const over = bytes > INLINE_LIMIT;

  return (
    <div className="inline-preview">
      <button type="button" onClick={() => dialog.current?.showModal()}>
        인라인 정책 보기
      </button>
      <span className="muted small">
        문장 {composed.Statement.length}개 · {bytes.toLocaleString()}바이트
        {over ? " — 한도 초과" : ` / ${INLINE_LIMIT.toLocaleString()}`}
        {active.length > 0 && ` · 정책 ${new Set(active.map((r) => r.policy)).size}개에서`}
      </span>

      <dialog ref={dialog} className="policy-dialog"
              onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
        <div className="policy-dialog-body">
          <h4>권한 세트 인라인 정책</h4>
          <p className="muted small">
            지금 고른 것으로 작성될 문서다. 승인하면 인라인 작성기가 결정을 다시 조립해 쓰므로 이것은
            <strong> 미리보기</strong>이고, 작성기가 거부하면 그 이유를 말한다.
            {fenceServices.length > 0 && (
              <> {" "}<code>PassRoleAllowlistFence*</code> 문장은 파이프라인이 붙이는 것으로,
              승인된 mirror 역할이 늘면 더 커진다.</>
            )}
          </p>
          <p className={over ? "error" : "muted small"}>
            {bytes.toLocaleString()}바이트 / 한도 {INLINE_LIMIT.toLocaleString()}바이트
            {over && " — 이대로면 인라인 작성기가 거부한다. 동작을 줄이거나 태그 조건을 쓰면 된다."}
          </p>
          <pre className="policy-json">{readable(composed)}</pre>
          <div className="row">
            <button type="button" onClick={() => dialog.current?.close()}>닫기</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/**
 * What ONE attached policy puts into the shared document, behind a button of its own.
 *
 * The preview above answers "what am I about to write". This answers the question an approver asks
 * next, once four policies are open and eleven actions are ticked across them: "which of those
 * statements is THIS policy's, and how much of the quota is it spending?" Reading that off the
 * combined document meant matching action names by eye across a hundred lines.
 *
 * What it must not become is a per-policy DOCUMENT. The permission set has one inline policy and a
 * Deny in it applies whatever policy prompted it, so four documents shown side by side would be four
 * things that do not exist standing in front of the one that does. So server/inlinePreview.js
 * composes the whole document and reads this policy's part back OUT of it, and three things follow
 * that the page has to show rather than smooth over:
 *
 *   the Sid numbers have gaps        2 and 3 belong to another policy. Renumbering to 1, 2 would be
 *                                    a document nobody will write
 *   a statement can be shared        the fold groups by resource clause, not by policy, so one
 *                                    statement can carry two policies' actions. It is shown whole,
 *                                    with the other policy's actions marked
 *   the byte figure is marginal      what the document GROWS by because of this policy, not the sum
 *                                    of the statements - those share bytes with statements this
 *                                    policy did not pay for
 *
 * Rendered as a bare JSON array rather than a Version/Statement object, for the same reason: an
 * excerpt that is a valid standalone policy is a wrong answer somebody can screenshot.
 */
function PolicyInlinePreview({
  policy, name, restrictions, accountId, fenceServices, policyFenceServices, nested,
}: {
  policy: string;
  /** The policy as a person names it. The identifier is an ARN for an AWS managed policy. */
  name: string;
  /** EVERY restriction, not this policy's. The whole document is what this is read out of. */
  restrictions: Restriction[];
  accountId: string;
  fenceServices: string[];
  /** The services this policy's own PassRole grant names. Its fence statements, if it earns any. */
  policyFenceServices: string[];
  nested: (action: string) => boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const view = useMemo(
    () => policyContribution(restrictions, policy,
                             { accountId, fenceServices, policyFenceServices, nested }),
    [restrictions, policy, accountId, fenceServices, policyFenceServices, nested],
  );

  // Statements this policy does not have to itself, for either reason: another policy put a
  // DIFFERENT action in the same statement, or another policy made the SAME decision.
  const withOthers = view.statements.filter((s) => s.alsoBy.length > 0);
  // The ones where unticking here would not remove the Deny. Separate, because it is the only
  // thing on this screen that contradicts what the reader is about to assume.
  const coOwned = view.statements.filter((s) => s.shared.length > 0);
  const actions = view.statements.reduce((n, s) => n + s.ours.length, 0);
  const overLimit = view.total > INLINE_LIMIT;
  /** How many statements the WHOLE document has, so the empty state can tell its two cases apart. */
  const totalStatements = restrictions.filter((r) => (r.actions ?? []).length > 0).length
    + fenceServices.length;
  // Whether removing this policy entirely would bring the document back under. `without` is the
  // document without it, so this is answerable rather than a guess - and the two answers are
  // different jobs for the approver reading them.
  const wouldFix = overLimit && view.without <= INLINE_LIMIT;

  return (
    <div className="inline-preview policy-preview">
      {/* The policy in the accessible name, not only in the surrounding <details>. Four policy
          blocks rendered four buttons whose entire name was the same five words, so a screen reader
          navigating by button list - or a voice control user saying the label - got four
          indistinguishable targets. The visible text stays short; aria-label carries the rest. */}
      <button type="button" aria-label={`${name}이 문서에 넣는 문장 보기`}
              onClick={() => dialog.current?.showModal()}>
        이 정책의 문장 보기
      </button>
      <span className="muted small">
        {view.statements.length === 0
          ? "이 정책이 문서에 넣는 문장이 없다"
          : `문장 ${view.statements.length}개 · 동작 ${actions}개 · `
            + (view.share === 0
              // Not "adds nothing". Every statement below exists, and another policy is already
              // paying for all of them - which is a different sentence and the true one.
              ? "다른 정책이 같은 것을 이미 거부하고 있다"
              : `문서를 ${view.share.toLocaleString()}바이트 늘린다`)}
        {view.fence.length > 0 && ` · 울타리 ${view.fence.length}개`}
      </span>

      <dialog ref={dialog} className="policy-dialog"
              onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
        <div className="policy-dialog-body">
          <h4>
            이 정책이 넣는 문장 <span className="muted">— <code>{name}</code></span>
          </h4>
          <p className="muted small">
            권한 세트의 인라인 문서는 <strong>하나</strong>이고, 이것은 그 문서에서 이 정책이 넣는
            부분만 떼어 본 것이다 — 따로 만들어지는 문서가 아니다. 그래서{" "}
            <code>Sid</code> 번호가 중간에 비어 있을 수 있다. 비어 있는 번호는 다른 정책의 문장이다.
          </p>

          {view.statements.length === 0 ? (
            /* Careful about two things it used to get wrong. A policy with a PassRole grant DOES put
               something in the document even with nothing ticked - the fence renders below this
               paragraph - so this cannot say the document holds nothing of this policy's. And when
               nothing is chosen anywhere, InlinePreview renders nothing at all, so pointing at it
               by name points at a control that is not on the page. */
            <p className="muted">
              이 정책에서 고른 동작이 없다
              {view.fence.length > 0
                ? " — 아래 울타리 문장은 제한이 아니라 이 정책의 iam:PassRole 부여 때문에 붙는 것이다."
                : totalStatements === 0
                  ? ". 지금은 문서에 문장이 하나도 없다."
                  : ", 그래서 지금 문서에 있는 문장은 전부 다른 정책에서 온 것이다."}
            </p>
          ) : (
            <>
              {/* The size figure is this policy's; the limit is the document's. Colouring the
                  first by the second turned every policy's dialog red the moment ANY of them was
                  over, with the number beside it - 80 bytes out of a 535-byte overrun - reading as
                  the thing to cut. So the limit line is its own line, and it says which of the two
                  jobs the reader has. */}
              <p className="muted small">
                이 정책이 늘리는 크기 <strong>{view.share.toLocaleString()}바이트</strong>
                {view.share === 0
                  && " — 다른 정책이 같은 것을 이미 거부하고 있어, 이 정책을 빼도 문서는 그대로다"}
              </p>
              {/* Marginal, and it has to say so. Folding pushes the sum of the per-policy figures
                  DOWN - two policies sharing one resource clause pay for it once, and two making
                  the same decision give 0 and 0 for a statement that costs real bytes - so the
                  figures do not add up to the document and adding them understates it. */}
              <p className="muted small">
                늘리는 크기는 <strong>이 정책을 뺐을 때와의 차이</strong>다. 문장이 다른 정책과 접히면
                자원 절은 한 번만 계산되므로, 정책별 크기를 더해도 문서 크기가 되지 않는다 — 대개
                모자란다.
              </p>
              <p className={overLimit ? "error" : "muted small"}>
                문서 전체 {view.total.toLocaleString()}바이트 / 한도{" "}
                {INLINE_LIMIT.toLocaleString()}바이트
                {overLimit && (wouldFix
                  ? " — 한도를 넘는다. 이 정책의 제한을 전부 빼면 "
                    + `${view.without.toLocaleString()}바이트로 한도 안에 들어온다.`
                  : " — 한도를 넘는다. 이 정책을 통째로 빼도 "
                    + `${view.without.toLocaleString()}바이트로 여전히 넘으므로, 다른 정책에서도 `
                    + "줄여야 한다. 태그 조건은 몇 개를 덮든 문장 하나다.")}
              </p>

              {coOwned.length > 0 && (
                <p className="warn-inline">
                  {coOwned.length}개 문장은 <strong>다른 정책도 똑같이 결정한 것</strong>이다. 여기서
                  선택을 지워도 그 문장은 남는다 — 같은 결정을 한 정책에서도 지워야 없어진다.
                </p>
              )}

              {withOthers.length > coOwned.length && (
                <p className="warn-inline">
                  {withOthers.length}개 문장은 다른 정책과 <strong>같은 문장</strong>이다. 자원 절이
                  같은 동작은 한 문장으로 접히기 때문이고, 아래에는 그 문장이 통째로 나온다 — 다른
                  정책에서 온 동작까지 함께다.
                </p>
              )}

              <ul className="statement-list">
                {view.statements.map(({ statement, ours, others, alsoBy, shared }) => (
                  <li key={statement.Sid}>
                    <code className="sid">{statement.Sid}</code>
                    <span className="muted small">
                      {ours.length}개
                      {/* alsoBy counts POLICIES. others counts ACTIONS, and one policy can
                          contribute four of them - printing that with the noun 정책 told an
                          approver with two attached policies that a statement was shared with
                          four. */}
                      {alsoBy.length > 0 && ` · 다른 정책 ${alsoBy.length}개와 같은 문장`}
                      {shared.length > 0 && ` · ${shared.length}개는 다른 정책도 같이 결정`}
                    </span>
                    <div className="statement-actions">
                      {ours.map((a) => (
                        <code key={a} className={shared.includes(a) ? "co-owned" : undefined}>{a}</code>
                      ))}
                      {others.map((a) => <code key={a} className="from-elsewhere">{a}</code>)}
                    </div>
                  </li>
                ))}
              </ul>

              <pre className="policy-json">{readableStatements(
                view.statements.map((s) => s.statement),
              )}</pre>
            </>
          )}

          {view.fence.length > 0 && (
            <>
              {/* Which figure it is in, precisely. It is in `total` - the document has it and the
                  quota counts it - and out of `share`, because it is composed from the assessment's
                  grants rather than from the restrictions, so it stands in both sides of the
                  subtraction and cancels. Saying "not in the size above" was true of one number and
                  false of the other, and the false one is the one compared against the limit. */}
              <p className="muted small">
                이 정책이 <code>iam:PassRole</code>을 주기 때문에 파이프라인이 붙이는 울타리다.
                제한을 고르든 말든 같은 문장이 붙으므로 <strong>늘리는 크기에는 들어 있지 않고</strong>,
                문서에는 실제로 붙으므로 <strong>문서 전체 크기와 한도에는 들어 있다.</strong>
              </p>
              <pre className="policy-json">{readableStatements(view.fence)}</pre>
            </>
          )}

          <div className="row">
            <button type="button" onClick={() => dialog.current?.close()}>닫기</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

/**
 * The four sections, in the order they are read.
 *
 * They used to be four values of one dropdown, so a policy could carry exactly one of them and
 * choosing a second meant giving up the first. That was never a property of the statements: the
 * permission set holds ONE inline document and each decision composes its own statement into it, so
 * "keep only these buckets, and also deny DeleteBucket outright" is two statements and always was.
 * The dropdown was the only thing making it one choice.
 *
 * 동작 자체 거부 is the section that could not exist under the dropdown at all. Its statement -
 * Deny on Resource "*" - was reachable only as a side effect: an action a list of ARNs cannot scope
 * got one written for it whatever the dropdown said, in a fold at the bottom of the picker with a
 * paragraph explaining that this one is different. It is not a side effect, it is a decision, and
 * lambda:CreateFunction is what an administrator most often wants to make it about.
 *
 * Ordering: the two that narrow, then the one that removes, then the one that follows a tag.
 */
const SECTIONS: Restriction["intent"][] = [
  "allow_only", "deny_only", "deny_action", "tag_condition",
];

const INTENT_LABEL: Record<Restriction["intent"], string> = {
  allow_only: "이 자원만 허용",
  deny_only: "이 자원만 거부",
  deny_action: "동작 자체 거부",
  tag_condition: "태그로 거부",
};

const INTENT_NOTE: Record<Restriction["intent"], string> = {
  allow_only: "고른 자원만 남기고 나머지를 거부한다. 이후에 생기는 자원도 거부된다.",
  deny_only: "고른 자원만 거부한다. 이후에 생기는 자원은 이 제한에 걸리지 않는다.",
  deny_action: "자원과 무관하게 동작 자체를 거부한다. 자원 목록으로 좁힐 수 없는 동작도 여기서 고른다.",
  tag_condition: "태그가 붙은 자원을 거부한다. 나중에 태그가 붙는 자원까지 덮는다.",
};

/** Whether this section's statements carry a resource list. Mirrors ActionPicker.isScoped. */
const isScoped = (intent: Restriction["intent"]) =>
  intent === "allow_only" || intent === "deny_only";

/** One draft per section. Every section is present, most of them usually empty. */
type Draft = Record<Restriction["intent"], Choice[]>;

export function Impact({
  assessment, source, restrictions, onChange, disabled,
}: Props) {
  const restrictable = assessment.policies.filter((p) => p.restrictable && !p.unreadable);
  const baseline = assessment.policies.filter((p) => p.is_baseline);
  const unreadable = assessment.policies.filter((p) => p.unreadable);

  // Memoised because it is an ARRAY, and it is a dependency of the per-policy view's own memo. Called
  // inline inside restrictable.map it was a new identity on every render, so every policy block
  // recomposed the whole document twice per keystroke in a tag field - 2N document compositions and
  // a serialise of every statement, for a value that changes only when the assessment does.
  const fenceServices = useMemo(
    () => fenceServicesOf(assessment.passrole_grants), [assessment.passrole_grants],
  );

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

      {(assessment.coverage.services_failed?.length ?? 0) > 0 && (
        <p className="warn-inline">
          자원 조회 실패: {assessment.coverage.services_failed.join(", ")} — 이 서비스들의 자원은
          평가에 없다. 계정이 비어 있다는 뜻이 아니라 조회가 실패했다는 뜻이다.
        </p>
      )}

      {restrictable.length === 0 && (
        <p className="muted">제한할 수 있는 정책이 없다. 기반 정책만 붙어 있다.</p>
      )}

      {/* 전체 AMP 기준 하나의 문서. 편집기는 정책별이지만 권한 세트의 인라인 문서는 하나이고,
          거기 담긴 Deny는 어느 정책이 계기였든 권한 세트 전체에 적용된다 — 정책마다 따로 보여주면
          존재하지 않는 문서 넷을 보여주고 실제로 존재하는 하나를 숨기게 된다. */}
      {restrictable.length > 0 && (
        <InlinePreview
          restrictions={restrictions}
          accountId={assessment.account_id}
          fenceServices={fenceServices}
          nested={nestedActions(assessment.action_reference ?? null)}
        />
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
          passroleGrant={(assessment.passrole_grants ?? [])
            .find((g) => g.identifier === policy.identifier) ?? null}
          fenceServices={fenceServices}
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
  passroleGrant,
  fenceServices,
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
  /** This policy's own PassRole grant, when it has one - what earns it a fence. */
  passroleGrant: ImpactPassRoleGrant | null;
  /** Bytes the fence will spend in the inline document, counted against the restriction budget. */
  /** Services the PassRole fence names. Its statements share the document and the quota. */
  fenceServices: string[];
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

  // The same question the writer asks the action table, for the per-policy view below. The editor
  // asks it too and holds its own memo - two callers, one derivation, and neither can be the other's
  // because the excerpt is composed from EVERY policy's restrictions and the editor only holds this
  // policy's draft.
  const nested = useMemo(() => nestedActions(reference), [reference]);
  // Stable across renders, so the excerpt's memo is not rebuilt by a fresh empty array every time.
  const policyFenceServices = useMemo(
    () => passroleGrant?.services ?? [], [passroleGrant],
  );

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
          {policy.default_version_id && ` · 정책 버전 ${policy.default_version_id}`}
        </span>
      </summary>

      {passroleGrant && (
        <p className="warn-inline">
          이 정책은 iam:PassRole을
          {passroleGrant.unconditioned
            ? " 서비스 조건 없이 모든 리소스에 부여한다 — 인라인 작성기가 이름을 들어 거부하는"
            : ` ${passroleGrant.services.join(", ")} 대상 모든 리소스에 부여한다 — 승인 목록 밖
               역할의 전달을 막는 PassRole 울타리가 함께 기록되는`}{" "}
          형태다.
        </p>
      )}

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

        {/* BELOW the editor, because it is the editor's result. The document-wide preview sits above
            the policy list for the opposite reason - it summarises all of them and nothing on the
            page is its cause. Here the cause is the four sections directly above, and a result
            printed before its cause reads as a heading. */}
        <PolicyInlinePreview
          policy={policy.identifier}
          name={policyName(policy.identifier)}
          restrictions={restrictions}
          accountId={accountId}
          fenceServices={fenceServices}
          policyFenceServices={policyFenceServices}
          nested={nested}
        />

        {/* At the BOTTOM of the restriction area, on the operator's direction: it says what the
            picker above will not offer, so it reads as a footnote to the choosing, not a headline
            above it. The declaration path stays unrestrictable either way. */}
        {blocked.length > 0 && (
          <p className="muted">
            제한할 수 없는 동작: {blocked.map((a) => <code key={a}>{a} </code>)} — 선언 경로다.
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * The row's tags, behind a button.
 *
 * They were printed inline and a single CloudFormation-managed resource carried two hundred
 * characters of them - a logical id, a stack name, and a stack ARN with a uuid on the end - which
 * pushed 리소스명 off the left of what a reader takes in and made every row look different lengths
 * for reasons that were not about the resource.
 *
 * A native <dialog>, not a hand-built overlay. It comes with Escape, the backdrop, focus trapping
 * and returning focus to the button - four behaviours that get written badly otherwise, and the
 * last of which is the one nobody notices missing until they are using a keyboard.
 *
 * The button says how MANY, so a reader can see there are tags without opening anything, and rows
 * with none show no button rather than an empty one.
 */
function TagButton({ tags, arn }: { tags: Record<string, string>; arn: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const entries = Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;
  return (
    <>
      <button
        type="button"
        className="tag-button"
        title="이 자원의 태그를 봅니다"
        onClick={() => dialog.current?.showModal()}
      >
        태그 {entries.length}
      </button>
      <dialog
        ref={dialog}
        className="tag-dialog"
        /* The backdrop IS the dialog element as far as a click is concerned, so a click whose
           target is the dialog itself landed outside the panel below. */
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        <div className="tag-panel">
          <div className="tag-head">
            <code>{arn}</code>
            <button type="button" onClick={() => dialog.current?.close()}>닫기</button>
          </div>
          <table className="tag-table">
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key}>
                  <th>{key}</th>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </dialog>
    </>
  );
}

/**
 * One resource as a labelled sentence: 리소스명, 계정, 리전. The console link is NOT here - it
 * lives on the group heading, once per region, because the list page it opens is the same for
 * every row of the group and a repeated link is furniture. The full ARN stays on the hover title;
 * an ARN that does not parse shows whole in the name slot rather than hiding.
 */
function LabeledResource({ resource, accountId }: {
  resource: ImpactResource;
  /** The governed account, used only when the ARN itself carries none (S3). */
  accountId: string;
}) {
  const parsed = parseArn(resource.arn);
  const account = parsed?.account || accountId;
  const region = resource.region || parsed?.region || "global";
  // A KMS key's own name is a UUID, so a list of them says which service and which region and
  // nothing about which key. Where an alias came back it IS the name, and the id moves to the
  // quiet slot beside it - still on the row, because that is what the console and every policy
  // document call the key, and a page that showed only the alias would leave the reader unable to
  // match a row to a Deny they are about to write.
  const name = resource.alias ?? parsed?.name ?? resource.arn;
  const aside = resource.alias ? (parsed?.name ?? null) : (parsed?.qualifier ?? null);
  return (
    <span className="res labeled" title={resource.arn}>
      <span className="res-label">리소스명: </span>
      <code className="res-name">{name}</code>
      {aside && <span className="res-qualifier">/{aside}</span>}
      <span className="res-label">, 계정: </span>
      <span className="res-value">{account}</span>
      <span className="res-label">, 리전: </span>
      <span className="res-value">{region}</span>
    </span>
  );
}

function GroupBlock({ group, accountId }: { group: ImpactGroup; accountId: string }) {
  // The console LIST page for this type, on the heading - one link per region the rows actually
  // sit in, deduplicated by URL so the region-blind consoles (IAM) fold to one. Not on the rows:
  // the list page is the same for every row of the group, and a repeated link is furniture.
  const consoles = useMemo(() => {
    const regions = [...new Set(group.resources.map(
      (r) => r.region || parseArn(r.arn)?.region || "global",
    ))].sort();
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

  return (
    <div className="group">
      <div className="group-head">
        <ServiceIcon service={group.service} resourceType={group.resource_type} />
        <code>{group.resource_type}</code>
        <span className="muted">
          {" "}
          {group.total}개{group.truncated && " 이상 (잘림)"} · 범위 {group.scope}
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

      {/* The list FIRST, the actions fold under it - the operator's ordering, and the right one:
          the rows are what an approver picks from, the fold is reference material. Each row is a
          labelled sentence carrying its own account, region and console link, because the heading
          above no longer speaks for the rows. */}
      <ul className="resources">
        {group.resources.slice(0, 50).map((resource) => (
          <li key={resource.arn} className={resource.sensitive ? "sensitive" : undefined}>
            <LabeledResource resource={resource} accountId={accountId} />
            <TagButton tags={resource.tags} arn={resource.arn} />
          </li>
        ))}
        {group.resources.length > 50 && (
          <li className="muted">…그리고 {group.resources.length - 50}개 더</li>
        )}
      </ul>

      {/* Folded: lambda:function carries 60 granted actions and printing them inline pushed the
          resource list off the screen. */}
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
  /** Which section's picker is open, or null. One at a time - they are all modal dialogs. */
  const [picking, setPicking] = useState<Restriction["intent"] | null>(null);

  /**
   * Which actions a list of ARNs cannot scope, for either of the two reasons.
   *
   * The test that decides which SECTION an action can be in, which is why it is here rather than in
   * the picker: the editor is the thing that has all four.
   *
   *   names no resource type      ec2:DescribeVpcs. Its resource is "*", which is in no list
   *   makes the one it names      lambda:CreateFunction. The list enumerates what EXISTS, and this
   *                               action's target is named at call time - "you may create a
   *                               function called testLambda" is not a control
   *
   * An action absent from the reference is neither: unknown is not empty, and the container refuses
   * what it cannot resolve rather than guessing.
   */
  const flatOnly = (action: string) => {
    const [service, ...rest] = action.split(":");
    const entry = reference?.services[service]?.[rest.join(":")];
    return entry ? entry[1].length === 0 || entry[2] === true : false;
  };

  // The draft, seeded once. Every change emits the whole set upward, so the parent's array stays the
  // single source of truth for what gets submitted while this holds the parts a restriction needs
  // before it is one - a section with no actions yet, or a tag key half typed.
  //
  // Seeded PER SECTION, and an action a list of ARNs cannot scope lands in 동작 자체 거부 whatever
  // intent it arrived under. That is not a guess: the only statement one of those ever had was the
  // flat Deny, and before this section existed the editor emitted it as deny_only with an empty
  // list. Reading it back into the section that now owns it is reading it back as what it is.
  const [draft, setDraft] = useState<Draft>(() => {
    // Fresh arrays, not EMPTY_DRAFT's - it is module-level and shared by every policy block.
    const seeded: Draft = { allow_only: [], deny_only: [], deny_action: [], tag_condition: [] };
    for (const restriction of existing) {
      for (const action of restriction.actions) {
        const into = flatOnly(action) ? "deny_action" : restriction.intent;
        if (seeded[into].some((c) => c.action === action)) continue;
        seeded[into].push({
          action,
          resources: into === "deny_action" ? [] : (restriction.resources ?? []),
        });
      }
    }
    return seeded;
  });
  const tagSeed = existing.find((r) => r.intent === "tag_condition");
  const [tagKey, setTagKey] = useState(() => tagSeed?.tag_key ?? "");
  const [tagValues, setTagValues] = useState(() => (tagSeed?.tag_values ?? []).join(","));

  /**
   * The sections, as the restrictions they will be sent as. One restriction per ACTION.
   *
   * Four sections compose into one document, and nothing here reconciles them - a Deny is a Deny
   * whatever prompted it, and the four statements coexist in the inline policy exactly as they read
   * here. What DOES need holding is that one action never appears in two sections: 이 자원만 허용
   * on s3:GetObject and 동작 자체 거부 on s3:GetObject compose a NotResource statement the flat Deny
   * beside it makes moot, which is bytes spent to say nothing and a document an approver cannot
   * read. The pickers refuse it rather than this reconciling it after the fact.
   */
  const compose = (next: Draft, key: string, values: string): Restriction[] => {
    const tag = {
      tag_key: key.trim(),
      tag_values: values.split(",").map((v) => v.trim()).filter(Boolean),
    };
    return SECTIONS.flatMap((intent) => next[intent].map((choice): Restriction => ({
      policy,
      intent,
      actions: [choice.action],
      ...(isScoped(intent)
        ? { resources: choice.resources }
        : intent === "tag_condition" ? tag : {}),
    })));
  };

  const emit = (next: Draft, key = tagKey, values = tagValues) => {
    setDraft(next);
    setTagKey(key);
    setTagValues(values);
    onChange(compose(next, key, values));
  };

  /** What one section holds, replaced. The others are carried through untouched. */
  const setSection = (intent: Restriction["intent"], choices: Choice[]) =>
    emit({ ...draft, [intent]: choices });

  /** Which OTHER section holds this action, or null. The rule the pickers enforce. */
  const heldElsewhere = (intent: Restriction["intent"]) => (action: string) => {
    const other = SECTIONS.find(
      (other) => other !== intent && draft[other].some((c) => c.action === action),
    );
    if (other) return `이미 "${INTENT_LABEL[other]}"에 있다`;
    // A hand-typed name the reference knows a list of ARNs cannot scope. The checkbox rows for
    // these are not in a scoped section's offering at all, so this is the one way in.
    if (isScoped(intent) && flatOnly(action)) {
      return `${action}은 자원 목록으로 좁힐 수 없다 — "동작 자체 거부"에서 고른다`;
    }
    if (intent === "tag_condition" && flatOnly(action)) {
      return `${action}은 태그를 읽을 자원이 없다 — "동작 자체 거부"에서 고른다`;
    }
    return null;
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
            // one of these, so a scoped section does not offer it.
            account_level: entry[1].length === 0,
            // It MAKES the resource it names, so an enumeration of what exists is no scope for it.
            // Same remedy, different sentence - see 동작 자체 거부.
            creates_target: entry[2] === true,
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

  /**
   * What one section may offer, and how much it kept out.
   *
   * 동작 자체 거부 offers everything: its statement is Deny on Resource "*", which every action can
   * be the subject of. The other three offer only what a list of ARNs can scope - a scoped section
   * because that list IS the statement, tag_condition because aws:ResourceTag reads the tags of a
   * resource and these actions have none to read. The count comes back so the dialog can say how
   * many went and where instead of leaving them missing.
   */
  const offeringFor = (intent: Restriction["intent"]) => {
    if (intent === "deny_action") return { offering: covered, hidden: 0 };
    let hidden = 0;
    const offering = covered
      .map(({ service, offers }) => {
        const keep = offers.filter((o) => !o.account_level && !o.creates_target);
        hidden += offers.length - keep.length;
        return { service, offers: keep };
      })
      .filter((g) => g.offers.length > 0);
    return { offering, hidden };
  };

  /**
   * The one action a section's list could be written as, when it can.
   *
   * Per section, because the fold is a property of one statement and the sections are separate
   * statements. serviceFold answers a different question for each intent - see its comments - and
   * declines outright for tag_condition.
   */
  const foldOffer = (intent: Restriction["intent"], choices: Choice[]) => {
    // Offered rather than applied: the wildcard becomes the administrator's decision and travels as
    // the action, because a page that quietly widened [8 names] into athena:* would be restricting
    // actions this approval does not grant - which is the one thing generator/restriction.py
    // refuses by name, and which after B-1 it can now actually see.
    if (intent === "tag_condition" || choices.length === 0) return null;
    const one = new Set(choices.map((c) => JSON.stringify([...c.resources].sort())));
    // One resource clause, because the statement it would become is one statement. A mixed set is
    // several statements and folding them together is not this offer.
    if (one.size !== 1) return null;
    const folded = serviceFold({
      actions: choices.map((c) => c.action),
      resources: choices[0].resources,
      intent,
      groups: affected,
      granted,
    });
    if (!folded) return null;
    return (
      <p className="fold-offer">
        <button type="button" disabled={disabled}
                onClick={() => setSection(intent, [{
                  action: folded.wildcard, resources: choices[0].resources,
                }])}>
          <code>{folded.wildcard}</code> 하나로 접기
        </button>
        {" "}
        <span className="muted small">
          {intent === "deny_only"
            ? `이 자원에 닿는 ${folded.covers}개를 전부 골랐다. 나머지 ${folded.adds.length}개는
               이 자원 유형에 닿지 않으므로 문장에 걸리지 않는다 —`
            : `이 정책이 주는 ${folded.covers}개를 전부 골랐다 —`}
          {" "}같은 것을 거부하면서 문장이 하나가 된다.
          {folded.adds.length > 0 && intent !== "deny_only"
            && ` 다만 ${folded.adds.join(", ")}까지 함께 거부된다.`}
        </span>
      </p>
    );
  };

  const totalChosen = SECTIONS.reduce((n, intent) => n + draft[intent].length, 0);

  return (
    <div className="editor">
      {/* Four sections, and they compose. It was one dropdown - pick an intent, pick actions - and
          picking a second intent meant giving up the first, which was never a property of the
          statements: the permission set holds one inline document and each decision composes its
          own statement into it. "이 버킷만 남기고, 그리고 DeleteBucket은 아예 막는다" is two
          statements and the dropdown was the only thing making it one choice.

          Each section is a button and what it holds. The offering is in a dialog with its own search
          and scroll, because this page is where a plan is read and approved and one service with
          several hundred actions would push the plan off the screen. */}
      {totalChosen > 0 && (
        <p className="muted small restrict-total">
          이 정책에서 고른 동작 {totalChosen}개 —{" "}
          {SECTIONS.filter((intent) => draft[intent].length > 0)
            .map((intent) => `${INTENT_LABEL[intent]} ${draft[intent].length}개`)
            .join(", ")}
        </p>
      )}

      {SECTIONS.map((intent) => {
        const choices = draft[intent];
        const { offering, hidden } = offeringFor(intent);
        return (
          <section key={intent}
                   className={choices.length > 0 ? "restrict-section on" : "restrict-section"}>
            <div className="control-row">
              <span className="section-name">{INTENT_LABEL[intent]}</span>
              <button type="button" disabled={disabled} onClick={() => setPicking(intent)}>
                {isScoped(intent) ? "동작과 자원 고르기" : "동작 고르기"}
                {choices.length > 0 && ` (${choices.length}개)`}
              </button>
              {choices.length > 0 && (
                <button type="button" className="section-clear" disabled={disabled}
                        onClick={() => setSection(intent, [])}>
                  비우기
                </button>
              )}
            </div>
            <p className="muted small">{INTENT_NOTE[intent]}</p>

            {choices.length > 0 && (
              <ul className="chosen-list">
                {choices.map((choice) => (
                  <li key={choice.action}>
                    <code>{choice.action}</code>
                    <span className="muted">
                      {intent === "tag_condition" && "태그 조건"}
                      {intent === "deny_action" && "자원 없이 거부"}
                      {isScoped(intent) && (choice.resources.length > 0
                        ? `자원 ${choice.resources.length}개`
                        : "자원 미지정")}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {foldOffer(intent, choices)}

            {/* Not refused here. For an action the reference does not carry - one typed by hand -
                nothing on this page can say whether it names a resource, and the container has a
                floor list of its own. The ones this page KNOWS cannot be scoped are not in this
                section's offering at all; they are in 동작 자체 거부. */}
            {isScoped(intent) && choices.some((c) => c.resources.length === 0) && (
              <p className="warn-inline">
                자원을 지정하지 않은 동작이 있다. 직접 적은 이름이면 서버가 판단하고, 자원으로 좁힐
                수 없는 동작이면 이유를 말하며 거부한다 — 그 경우 <strong>동작 자체 거부</strong>로
                옮기면 된다.
              </p>
            )}

            {intent === "tag_condition" && choices.length > 0 && (
              <fieldset>
                <legend>태그</legend>
                <input
                  type="text"
                  placeholder="env"
                  disabled={disabled}
                  value={tagKey}
                  onChange={(e) => emit(draft, e.target.value, tagValues)}
                />
                <input
                  type="text"
                  placeholder="prod (쉼표로 여러 개)"
                  disabled={disabled}
                  value={tagValues}
                  onChange={(e) => emit(draft, tagKey, e.target.value)}
                />
              </fieldset>
            )}

            {picking === intent && (
              <ActionPicker
                policy={policy}
                intent={intent}
                chosen={choices}
                /* An action the policy names literally and the reference does not carry. flatOnly is
                   false for anything unknown, so this filter removes only the ones this page can
                   positively say a list of ARNs cannot scope. */
                named={intent === "deny_action" ? offerable : offerable.filter((a) => !flatOnly(a))}
                covered={offering}
                uncovered={uncovered}
                referenceError={referenceError}
                protectedActions={protectedActions}
                affected={affected}
                primary={primary}
                cannotHold={heldElsewhere(intent)}
                elsewhere={hidden > 0
                  ? { count: hidden, section: INTENT_LABEL.deny_action }
                  : null}
                onCommit={(next) => {
                  setSection(intent, next);
                  setPicking(null);
                }}
                onCancel={() => setPicking(null)}
              />
            )}
          </section>
        );
      })}

      {/* There is no size estimate here any more, and removing it was the fix rather than a
          simplification. It composed a document from THIS POLICY's sections alone and labelled the
          result "인라인 정책 예상 크기" against the 10,240 quota - a quota the whole permission set
          shares. With 60 actions on this policy and 60 on another it read 5,889 bytes twenty pixels
          above a figure of 11,770 for the same document, and below the 80% gate it printed nothing
          at all, which reads as "it fits". The number that answers the question is in the per-policy
          view directly below and in the document-wide preview at the top of the panel, and both of
          them compose every policy. */}

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

      {/* There is no resource fieldset. Resources belong to an action, so they are chosen from the
          action's own row - see ResourcePicker. A shared list on this page could not express
          "kms:DescribeKey on the Lambda key only", and it silently paired every chosen action with
          every chosen resource. */}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AssessmentState, Finding, Impact as Assessment, PassroleWithdrawal, PassroleWriter,
  PlanDetail as Detail, PlanRefusal, Restriction, RestrictionTemplate, RiskAnalysisCitation,
} from "../types";
import { mergeTemplate, seedFromTemplate } from "../../server/templates.js";
import { Impact } from "./Impact";
import { RiskAnalysis } from "./RiskAnalysis";
import { clock } from "../time";

interface Props {
  detail: Detail;
  decided: boolean;
  busy: boolean;
  /** From the sweep, so the page can tell "still assessing" from "no assessment". */
  assessmentState: AssessmentState | null;
  /**
   * Which question this panel answers about the plan. Chosen on the row in the list, and kept here
   * rather than inside this component so that selecting a different plan can reset it - a view that
   * survived the selection would open one resource on another's question.
   */
  view: "assessment" | "passrole";
  onView: (view: "assessment" | "passrole") => void;
  /** IAM actions per service, so the restriction picker offers a list instead of asking for typing. */
  onDecide: (
    decision: "approve" | "deny",
    reviewer: string,
    comment: string,
    /**
     * What this decision says about the restrictions in force, and null is not [].
     *
     * null   it says nothing. The writer carries the family forward - a denial, or an approval
     *        made on a screen whose restriction editor was closed
     * []     it says there are none. The writer CLEARS the family
     * [...]  it says exactly these. The writer replaces the family with them
     */
    restrictions: Restriction[] | null,
    passroleGrantTo: string[],
    passroleRevokeFrom: string[],
    analysis: RiskAnalysisCitation | null,
  ) => void;
  /**
   * Send the work orders again, for the people the inline writer did not reach. Not a decision:
   * nothing about the grant is chosen here, and the only thing this sends is a list of names the
   * server has already established the writer failed on.
   */
  onRetryPassrole: (users: string[], reviewer: string) => void;
  /**
   * Take a grant back, with no decision on this plan behind it. Stays available after the plan has
   * an outcome — which is exactly when it is needed, because that is when granting's own path shuts.
   */
  onRevokePassrole: (users: string[], reviewer: string) => void;
}

const actionClass = (actions: string[]) => {
  if (actions.includes("delete")) return "badge badge-danger";
  if (actions.includes("update")) return "badge badge-warn";
  return "badge badge-ok";
};

/**
 * The PassRole requests on this plan, and the one place they can be confirmed.
 *
 * Deliberately its own section, below what the plan changes and above the plan text. A request is
 * not part of the plan's diff - tagging a role changes no resource, only the outputs that carry the
 * ask - so folding it into 바뀌는 것 would file an escalation under "nothing changed".
 *
 * What this screen may and may not do
 * -----------------------------------
 * It sends NAMES. Which role and which services the grant is conditioned on are read by the applier
 * from the plan's own outputs, exactly as a restriction travels as decisions rather than as a
 * policy document. This tier does not author IAM content, so the worst a defect here can do is
 * confirm the wrong person - and the applier checks each name against the requests the inspector
 * read off the source role, so even that is bounded.
 */
function PassroleRequests({ detail, confirmed, onConfirmed, withdrawn, onWithdrawn, disabled }: {
  detail: Detail;
  confirmed: string[];
  onConfirmed: (names: string[]) => void;
  withdrawn: string[];
  onWithdrawn: (names: string[]) => void;
  disabled: boolean;
}) {
  const requests = detail.passrole?.requested_by ?? [];
  // The LIVE holders, not the plan's own output. See passroleLive.js on the server: the inspector's
  // list is what was true when the plan was generated, and granting happens afterwards, so this
  // column said 미부여 about a grant that was already in force and stayed wrong until an unrelated
  // event caused a new inspection.
  const granted = new Set(detail.passrole?.granted_to ?? []);
  const live = detail.passrole_live;
  const confirmedLive = new Set(live?.confirmed ?? []);
  const unknownLive = new Set(live?.unknown ?? []);
  // Tag removed, grant still standing. Not requests - there is nothing to grant - so they get
  // their own group below and only one thing can be done with them.
  const withdrawnTags = detail.passrole?.untagged ?? [];
  // Asked for and not grantable. Nothing can be DECIDED about these, which is why they are not
  // requests - and why the panel used to return null on a role carrying only these, showing the
  // person who tagged it an empty screen or no PassRole tab at all.
  const unavailable = detail.passrole?.unavailable ?? [];
  if (requests.length === 0 && withdrawnTags.length === 0 && unavailable.length === 0) return null;

  const services = detail.passrole?.services ?? [];
  // No service means no grant can be written: the condition would have to be invented, and an
  // unconditioned PassRole allows passing the role to anything. The applier refuses it and so does
  // the decision route, so the boxes are disabled rather than offered and then rejected.
  const grantable = services.length > 0;

  // Three answers, not two, and the third is not the absence of the first. Leaving somebody
  // unticked removes nothing - the writer keeps every grant a decision does not name - so taking
  // one back has to be said out loud. Withdrawing stays available when granting is not: a role
  // whose trust policy lost its services is exactly one whose grants should come off.
  const setChoice = (name: string, choice: "grant" | "none" | "revoke") => {
    onConfirmed(choice === "grant"
      ? [...confirmed.filter((n) => n !== name), name].sort()
      : confirmed.filter((n) => n !== name));
    onWithdrawn(choice === "revoke"
      ? [...withdrawn.filter((n) => n !== name), name].sort()
      : withdrawn.filter((n) => n !== name));
  };
  const choiceOf = (name: string): "grant" | "none" | "revoke" => {
    if (confirmed.includes(name)) return "grant";
    if (withdrawn.includes(name)) return "revoke";
    return "none";
  };

  return (
    <>
      <h3>
        PassRole <span className="muted small">
          요청 {requests.length}건{withdrawnTags.length > 0 ? ` · 회수 대기 ${withdrawnTags.length}건` : ""}
          {unavailable.length > 0 ? ` · 부여 불가 ${unavailable.length}건` : ""}
        </span>
      </h3>
      <p className="muted small">
        이 역할을 서비스에 넘길 수 있게 해 달라는 요청입니다. 원본 역할에{" "}
        <code>&lt;사용자 이름&gt; = passrole</code> 태그를 붙여 요청합니다.{" "}
        <strong>요청은 아무것도 부여하지 않습니다</strong> — 계획을 승인하는 것과 부여하는 것은
        별개의 결정이고, 아래에서 이름을 고른 사람에게만 부여됩니다.
      </p>

      {!grantable && requests.length > 0 && (
        <div className="warn-inline">
          이 역할의 신뢰 정책이 어떤 서비스도 맡기지 않습니다. 조건 없는 PassRole 은 역할을
          아무 서비스에나 넘길 수 있게 하므로, 부여할 수 없습니다. 원본 역할의 신뢰 정책을 먼저
          고치십시오.
        </div>
      )}

      <p className="muted small">
        <strong>고르지 않은 것은 회수가 아닙니다.</strong> 이미 부여된 권한은 그대로 남습니다 —
        지난번에 부여받은 사람을 이번에 고르지 않았다고 해서 그 사람의 권한이 사라지지는 않습니다.
        되돌리려면 <strong>회수</strong>를 골라야 합니다. 지금 누가 가지고 있는지는 아래
        <strong>지금 상태</strong> 열에 있습니다.
      </p>

      {requests.length > 0 && (
        <table className="policy-table">
          <thead>
            <tr>
              <th>결정</th>
              <th>요청한 사람</th>
              <th>지금 상태</th>
              <th>넘길 수 있게 되는 서비스</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((name) => (
              <tr key={name}>
                <td>
                  <select
                    value={choiceOf(name)}
                    disabled={disabled}
                    onChange={(e) =>
                      setChoice(name, e.target.value as "grant" | "none" | "revoke")}
                  >
                    <option value="none">그대로 두기</option>
                    <option value="grant" disabled={!grantable}>부여</option>
                    <option value="revoke">회수</option>
                  </select>
                </td>
                <td><code>{name}</code></td>
                <td>
                  {granted.has(name)
                    ? <span className="badge badge-warn">부여됨</span>
                    : <span className="badge">미부여</span>}
                  {/* Where the answer came from. An approver choosing between 재시도 and 회수 is
                      choosing on this, and without it a grant the writer confirmed and one the
                      inspector saw look identical - as does one nobody can currently vouch for. */}
                  {confirmedLive.has(name) && (
                    <span className="muted small"> 작성기 확인</span>
                  )}
                  {unknownLive.has(name) && (
                    <span className="muted small"> 작성기 미확인</span>
                  )}
                </td>
                <td className="finding-actions">
                  {services.length === 0
                    ? <span className="muted">없음</span>
                    : services.map((s) => <code key={s}>{s}</code>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {unavailable.length > 0 && (
        <>
          <h4>부여할 수 없는 요청 <span className="muted small">{unavailable.length}건</span></h4>
          <p className="muted small">
            태그는 붙었고 <strong>부여 문장을 쓸 대상이 없습니다.</strong> 여기 있는 이름은 위
            목록에 나오지 않습니다 — 승인자가 고를 수 있는 것이 아니기 때문입니다. 그래도 화면에
            내는 이유는, 태그를 붙인 사람이 아무것도 보지 못하면 <strong>거절된 것인지 아직 처리가
            안 된 것인지 구분할 방법이 없기</strong> 때문입니다.
          </p>
          <table className="policy-table">
            <thead>
              <tr>
                <th>사람</th>
                <th>부여될 권한 세트</th>
                <th>왜 안 되는가</th>
              </tr>
            </thead>
            <tbody>
              {unavailable.map((entry) => (
                <tr key={entry.user_name} className="marker-lock">
                  <td><code>{entry.user_name}</code></td>
                  <td>
                    {entry.permission_set
                      ? <code>{entry.permission_set}</code>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="small">{entry.why || <span className="muted">사유 없음</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            고치는 자리는 둘 중 하나입니다. <strong>Identity Center 사용자가 없다</strong>면 태그의
            키가 사용자 이름과 정확히 같은지 봅니다. <strong>권한 세트가 없다</strong>면 그 사용자의
            권한 세트를 먼저 만들어야 합니다 — 부여 문장은 그 권한 세트의 인라인 정책에 들어가므로,
            없으면 쓸 곳이 없습니다. 어느 쪽이든 고친 뒤 원본 역할의 태그를 다시 붙이면 새 검사가
            돕니다.
          </p>
        </>
      )}

      {withdrawnTags.length > 0 && (
        <>
          <h4>태그가 제거된 사람 <span className="muted small">{withdrawnTags.length}명</span></h4>
          <p className="muted small">
            원본 역할에서 태그가 <strong>제거되었는데 권한은 그대로 남아 있는</strong> 사람입니다.
            태그를 떼는 것이 요청을 거두는 방법이므로, 이것은 회수 요청으로 읽어야 합니다. 여기서
            회수하지 않으면 권한은 계속 유지됩니다 — 이 화면 말고는 그 짝을 다시 말해 주는 곳이
            없습니다.
          </p>
          <table className="policy-table">
            <thead>
              <tr>
                <th>결정</th>
                <th>사람</th>
                <th>지금 상태</th>
              </tr>
            </thead>
            <tbody>
              {withdrawnTags.map((name) => (
                <tr key={name} className="marker-lock">
                  <td>
                    <select
                      value={withdrawn.includes(name) ? "revoke" : "none"}
                      disabled={disabled}
                      onChange={(e) =>
                        setChoice(name, e.target.value === "revoke" ? "revoke" : "none")}
                    >
                      <option value="none">그대로 두기</option>
                      <option value="revoke">회수</option>
                    </select>
                  </td>
                  <td><code>{name}</code></td>
                  <td><span className="badge badge-danger">태그 없이 부여됨</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="muted small">
        부여 대상:{" "}
        {detail.passrole?.target_arn
          ? <code>{detail.passrole.target_arn}</code>
          : <span>이 계획이 만드는 역할입니다 — 적용 전에는 ARN 이 정해지지 않습니다.</span>}
        {" "}문장은 요청한 사람의 권한 세트 인라인 정책에 들어가며,{" "}
        <code>iam:PassedToService</code> 조건으로 위 서비스에 묶입니다.
      </p>
    </>
  );
}

/**
 * Did the inline writer do what this decision dispatched? One row per person it named.
 *
 * The gap this closes has a shape: an approver confirms PassRole for three people, the applier
 * writes three work orders and records `dispatched`, and one writer fails. Every screen said the
 * decision was applied. The person who asked never got the grant, and nothing anywhere said so -
 * the reason was in CloudWatch and the lock, which nobody reads, was the only trace.
 *
 * So the count is the point. `발송 n건 · 적용 n건` is the sentence, and it is worth reading even
 * when it matches: a decision that dispatched three and applied three is the only finished shape.
 *
 * Retry is offered on exactly the rows the applier would act on. A retry overwrites the writer's
 * LOCK, and taking a lock from a run that is still going would put a second work order under a task
 * mid-apply - so it is offered only where the writer RECORDED that its run stopped without writing.
 * A row with no record at all is not retryable and says why: nothing distinguishes a run still going
 * from a task that died before it could speak.
 */
function PassroleWriters({ writers, disabled, onRetry }: {
  writers: PassroleWriter[];
  disabled: boolean;
  onRetry: (users: string[], reviewer: string) => void;
}) {
  // Its own, not the decision form's. A retry is a separate act recorded separately - it lands in
  // outcome.json's `retries` with this name on it - and the decision form below is for a plan this
  // one has already been decided, so borrowing its field would ask for a name in the wrong place.
  const [reviewer, setReviewer] = useState("");
  if (writers.length === 0) return null;

  const applied = writers.filter((w) => w.ok);
  const retryable = writers.filter((w) => w.retryable);
  const waiting = writers.filter((w) => !w.ok && !w.retryable);

  const label = (w: PassroleWriter) => {
    if (w.ok) return <span className="badge badge-ok">적용됨</span>;
    if (w.state === "failed") return <span className="badge badge-danger">실패</span>;
    if (w.state === "refused") return <span className="badge badge-danger">거부됨</span>;
    if (w.locked) return <span className="badge badge-warn">진행 중</span>;
    return <span className="badge">기록 없음</span>;
  };

  // Why, in the row, and not only in a summary. A person looking at one name wants that name's
  // answer - and the three unrecorded shapes are different problems with different next steps.
  const why = (w: PassroleWriter) => {
    if (w.reason) return w.reason;
    if (w.ok) return "";
    if (w.locked) {
      return "작성기가 아직 결과를 남기지 않았습니다. 돌고 있는지 죽었는지 구분할 수 없어 재시도를 "
        + "걸지 않습니다 — 잠금을 뺏으면 적용 중인 작업 위에 지시를 덮어쓰게 됩니다.";
    }
    return "작성기의 기록도 잠금도 없습니다. 이 기능이 들어오기 전에 끝난 발송이거나, 객체가 "
      + "지워진 것입니다.";
  };

  const retry = (users: string[]) => {
    const who = reviewer.trim();
    if (!who) {
      window.alert("다시 보낸 사람의 이름을 입력하세요. 기록에 그대로 남습니다.");
      return;
    }
    if (!window.confirm(
      `${users.join(", ")} 의 작업 지시를 다시 보냅니다.\n\n계획을 다시 적용하지는 않습니다. `
      + "적용기가 그때 기록해 둔 출력값으로 작업 지시만 새로 쓰고, 인라인 작성기가 다시 돕니다.",
    )) return;
    onRetry(users, who);
  };

  return (
    <>
      <h4>
        인라인 작성기 <span className="muted small">
          발송 {writers.length}건 · 적용 {applied.length}건
          {retryable.length > 0 ? ` · 실패 ${retryable.length}건` : ""}
          {waiting.length > 0 ? ` · 미확인 ${waiting.length}건` : ""}
        </span>
      </h4>
      <p className="muted small">
        위에서 고른 결정은 사람마다 작업 지시 하나로 나가고, 그것을 받아 권한 세트의 인라인 정책에
        문장을 쓰는 것은 <strong>다른 컨테이너</strong>입니다.{" "}
        <strong>발송은 적용이 아닙니다</strong> — 적용 완료라고 적힌 결정이라도 여기서 적용 건수가
        발송 건수보다 적으면, 그만큼은 승인만 되고 권한은 들어가지 않은 것입니다.
      </p>

      {retryable.length > 0 && (
        <div className="warn-inline">
          {retryable.map((w) => w.user_name).join(", ")} 의 문장이 쓰이지 않았습니다. 승인은
          기록되어 있고 권한은 들어가지 않은 상태입니다.
        </div>
      )}

      <table className="policy-table">
        <thead>
          <tr>
            <th>사람</th>
            <th>동작</th>
            <th>작성기</th>
            <th>원인</th>
            <th>다시 보내기</th>
          </tr>
        </thead>
        <tbody>
          {writers.map((w) => (
            <tr key={w.key || w.user_name} className={w.ok ? undefined : "marker-lock"}>
              <td><code>{w.user_name}</code></td>
              <td>{w.action === "revoke" ? "회수" : "부여"}{w.retried ? " (재시도)" : ""}</td>
              <td>
                {label(w)}
                {w.finished_at
                  ? <div className="muted small">{clock(w.finished_at)}</div>
                  : null}
              </td>
              <td className="small">{why(w) || <span className="muted">—</span>}</td>
              <td>
                {w.retryable
                  ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => retry([w.user_name])}
                    >
                      다시 보내기
                    </button>
                  )
                  : <span className="muted small">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {retryable.length > 0 && (
        <div className="decision">
          <div className="row">
            <input
              placeholder="다시 보낸 사람 (기록에 그대로 남습니다)"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
            />
            {retryable.length > 1 && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => retry(retryable.map((w) => w.user_name))}
              >
                실패한 {retryable.length}건 모두 다시 보내기
              </button>
            )}
          </div>
        </div>
      )}

      <p className="muted small">
        다시 보내면 <strong>계획을 다시 적용하지 않습니다.</strong> 적용은 이미 끝났고 저장된 계획
        파일은 두 번 돌지 않습니다 — 적용기는 그때 기록해 둔 출력값으로 작업 지시만 새로
        씁니다. 잠금을 넘겨받는 것은 작성기가 <strong>그 실행은 끝났고 쓰지 못했다</strong>고 남긴
        경우뿐입니다.
      </p>
    </>
  );
}

/**
 * Who holds the grant right now, and the one place it can be taken back.
 *
 * Its own panel because it is not a decision about the plan. Granting rides on approving one, and
 * once that plan is applied there is no second decision to make - the decision route refuses one on
 * a plan that has an outcome, and a plan whose twin already matches carries no changes to approve.
 * So the only field that removes a grant could not be sent at all, and a grant held by somebody
 * whose tag was removed in an earlier inspection stood until the permission set was edited by hand.
 *
 * Shown whenever anybody holds the grant - applied, decided, or awaiting a decision. That is the
 * point: this panel answers "who can pass this role today", which is a live question about the
 * resource, not a question about the plan sitting in front of it.
 *
 * 지금 상태 in the requests table above says the same thing for people who are still tagged. This
 * lists EVERYONE, which is what the other table cannot do: a holder whose tag is long gone appears
 * in neither the requests nor the withdrawn-tag group.
 */
function PassroleHolders({ detail, disabled, onRevoke }: {
  detail: Detail;
  disabled: boolean;
  onRevoke: (users: string[], reviewer: string) => void;
}) {
  // Its own, like the retry panel's. Taking a grant back is recorded with this name in
  // passrole.json, and the decision form below is about a plan this action is not part of.
  const [reviewer, setReviewer] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  const holders = detail.passrole?.granted_to ?? [];
  const live = detail.passrole_live;
  const history = detail.passrole_withdrawals ?? [];
  if (holders.length === 0 && history.length === 0) return null;

  // A grant comes off a role, so there has to be a role. A plan that only creates one has produced
  // no ARN yet and the server refuses the withdrawal - said here rather than after the button.
  const exists = Boolean(detail.passrole?.target_arn);
  const toggle = (name: string) =>
    setPicked(picked.includes(name)
      ? picked.filter((n) => n !== name)
      : [...picked, name].sort());

  const revoke = () => {
    const who = reviewer.trim();
    if (!who) {
      window.alert("회수한 사람의 이름을 입력하세요. 기록에 그대로 남습니다.");
      return;
    }
    if (picked.length === 0) {
      window.alert("회수할 사람을 고르세요.");
      return;
    }
    if (!window.confirm(
      `${picked.join(", ")} 에게서 이 역할의 PassRole 을 회수합니다.\n\n계획을 다시 적용하지는 `
      + "않습니다. 해당 권한 세트의 인라인 정책에서 문장을 지우고, 미러 역할의 부여 기록 태그를 "
      + "떼어냅니다.",
    )) return;
    onRevoke(picked, who);
    setPicked([]);
  };

  return (
    <>
      <h4>지금 부여된 사람 <span className="muted small">{holders.length}명</span></h4>
      <p className="muted small">
        미러 역할의 태그가 기록하는 <strong>현재 보유자</strong>입니다. 요청 목록과 별개입니다 —
        태그를 오래전에 뗀 사람은 위 어느 표에도 나오지 않고 권한만 남아 있습니다.{" "}
        <strong>여기서는 계획 승인 없이 바로 회수합니다.</strong>
      </p>
      {/* 이 목록이 검사 시점의 스냅샷만 읽던 동안, 승인 직후에 부여된 사람은 여기 나오지 않았고
          - 이 표가 회수의 유일한 입구이므로 - 실제로 서 있는 부여를 회수할 방법이 없었다. */}
      {(live?.confirmed ?? []).length > 0 && (
        <p className="muted small">
          이 중 <code>{live.confirmed.join(", ")}</code> 은(는) 이 계획을 검사한 뒤에 부여되었고,
          인라인 작성기가 <strong>문서에 서 있는 것을 확인</strong>한 것입니다. 다음 검사가 돌기
          전이므로 계획 자체의 출력값에는 아직 없습니다.
        </p>
      )}
      {(live?.released ?? []).length > 0 && (
        <p className="muted small">
          <code>{live.released.join(", ")}</code> 은(는) 검사 시점에는 보유자였고 지금은 아닙니다 —
          회수가 반영되었습니다. 회수 대상 목록에서 빠져 있는 이유입니다.
        </p>
      )}
      {(live?.unknown ?? []).length > 0 && (
        <div className="warn-inline">
          <code>{live.unknown.join(", ")}</code> 에 대해서는 작성기가 대답하지 못했습니다 — 실행이
          아직 끝나지 않았거나 실패했습니다. 여기 보이는 상태는 <strong>검사 시점의 것</strong>이며
          지금 무엇이 서 있는지는 확인되지 않았습니다. 회수보다 먼저 아래 「작성기」 구역에서
          재시도를 보십시오.
        </div>
      )}

      {holders.length > 0 && !exists && (
        <div className="warn-inline">
          이 계획의 미러 역할이 아직 만들어지지 않았습니다. 지울 문장이 있으려면 역할이 먼저
          있어야 하므로 회수할 수 없습니다.
        </div>
      )}

      {holders.length > 0 && (
        <table className="policy-table">
          <thead>
            <tr>
              <th>회수</th>
              <th>사람</th>
              <th>부여된 권한 세트</th>
            </tr>
          </thead>
          <tbody>
            {holders.map((name) => (
              <tr key={name}>
                <td>
                  <input
                    type="checkbox"
                    checked={picked.includes(name)}
                    disabled={disabled || !exists}
                    onChange={() => toggle(name)}
                  />
                </td>
                <td><code>{name}</code></td>
                <td>
                  <code>{detail.account_id ? `${detail.account_id}-${name}` : name}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {holders.length > 0 && exists && (
        <div className="decision">
          <div className="row">
            <input
              placeholder="회수한 사람 (기록에 그대로 남습니다)"
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
            />
            <button
              type="button"
              className="btn-deny"
              disabled={disabled || picked.length === 0}
              onClick={revoke}
            >
              {picked.length > 0 ? `${picked.length}명 회수` : "회수"}
            </button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <>
          <h4>회수 이력 <span className="muted small">{history.length}건</span></h4>
          <p className="muted small">
            계획 결정 없이 이 자원에 가한 회수입니다. 계획이 다시 검사되어도 사라지지 않습니다 —
            자원의 이력이지 계획의 기록이 아니기 때문입니다.
          </p>
          <table className="policy-table">
            <thead>
              <tr>
                <th>누구에게서</th>
                <th>누가</th>
                <th>언제</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry: PassroleWithdrawal, index: number) => (
                <tr key={entry.request_id ?? index}>
                  <td>{entry.users.map((u) => <code key={u}>{u}</code>)}</td>
                  <td>
                    {entry.reviewer ?? <span className="muted">미상</span>}
                    {entry.comment ? <div className="muted small">{entry.comment}</div> : null}
                  </td>
                  <td className="small">
                    {entry.finished_at ? clock(entry.finished_at) : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="muted small">
        회수는 <strong>계획을 다시 적용하지 않습니다.</strong> 적용기는 계정과 자원 이름에서 미러
        역할을 유도해 그 하나로 두 가지를 합니다 — 권한 세트 인라인 정책의 문장을 지우고, 미러
        역할의 부여 기록 태그를 뗍니다. 둘이 다른 역할을 가리키면 권한은 살아 있는데 기록만
        사라지므로, 출처를 하나로 둡니다.
      </p>
    </>
  );
}

export function PlanDetail({
  detail, decided, busy, assessmentState, view, onView, onDecide, onRetryPassrole,
  onRevokePassrole,
}: Props) {
  const [reviewer, setReviewer] = useState("");
  const [comment, setComment] = useState("");
  // Opened with what is ALREADY standing, not empty.
  //
  // Empty was the defect. A second event on the same permission set showed a blank form, so an
  // approver could not see the restrictions they had put in force - and approving from that blank
  // form replaced the whole AdminDeny family with whatever was ticked this time, silently dropping
  // every earlier one while the run reported success.
  //
  // Keyed on the plan id so switching plans re-seeds rather than carrying one permission set's
  // restrictions onto another's form.
  const [restrictions, setRestrictions] = useState<Restriction[]>(
    () => detail.restrictions_in_force ?? [],
  );
  const seededFor = useRef<string | null>(detail.plan_id);
  if (seededFor.current !== detail.plan_id) {
    seededFor.current = detail.plan_id;
    setRestrictions(detail.restrictions_in_force ?? []);
  }
  // Null is not []. Nobody has said what is standing - no writer has run for this permission set,
  // or the last run could not say - and a decision composed against that would drop what it cannot
  // see. The form is shown read-only and the button refuses; see the notice below.
  const inForceUnknown = detail.restrictions_in_force === null;
  const [analysis, setAnalysis] = useState<RiskAnalysisCitation | null>(null);
  /**
   * The findings themselves, by the scope that produced them, so the resource diagram in the
   * assessment panel can answer "what was found about THIS resource" without running anything of
   * its own. Held here because the two panels are siblings: the analysis runs below, the diagram
   * is drawn above, and this is the nearest place both can see.
   *
   * Cleared with the plan, exactly as the citation is: findings about the plan an approver just
   * left, drawn on the plan they are looking at now, would be a lie with no way to see it.
   */
  const [findings, setFindings] = useState<Record<string, Finding[]>>({});
  // Whose PassRole request this approver has ticked. Nobody, until somebody is.
  const [grantTo, setGrantTo] = useState<string[]>([]);
  // And whose this approver has taken back. Separate state, because it is not the complement of the
  // one above - most people are in neither, and leaving somebody out of both changes nothing.
  const [revokeFrom, setRevokeFrom] = useState<string[]>([]);

  // Dropped when the plan changes, and that is the whole reason it is state here rather than inside
  // the analysis panel. The citation names an assessment digest; carrying one from the previous plan
  // into this decision would be citing an analysis of something else, which the server would refuse
  // - correctly, but after the reviewer had already pressed the button.
  useEffect(() => { setAnalysis(null); setFindings({}); }, [detail.plan_id, detail.request_id]);
  // Dropped with the plan, for a harder reason than the citation above: a name carried over from a
  // previous inspection would confirm a request that inspection recorded and this one may not. The
  // server and the applier both refuse that, but only after the button was pressed.
  useEffect(() => { setGrantTo([]); setRevokeFrom([]); }, [detail.plan_id, detail.request_id]);

  const submit = (decision: "approve" | "deny") => {
    if (!reviewer.trim()) {
      window.alert("검토자 이름을 입력하세요.");
      return;
    }
    if (decision === "deny" && !comment.trim()) {
      window.alert("거부에는 사유가 필요합니다. 변경을 요청한 사람이 읽을 것은 이것뿐입니다.");
      return;
    }
    // Three-valued, and null is not []. null says this decision decides nothing about restrictions
    // and the family in force is carried forward; [] says there are none and clears it.
    //
    // The editor has to have been LIVE for an empty form to mean "none". It is closed when there is
    // no assessment and when what stands cannot be read (inForceUnknown), and in both cases the
    // form is empty because nobody could fill it - reading that as a clear would delete
    // restrictions off a screen that never showed them. A denial writes nothing at all.
    const decidable = decision === "approve" && !!detail.assessment && !inForceUnknown;
    const chosen = restrictions.filter((r) => r.actions.length > 0);
    if (decidable && restrictions.length > chosen.length) {
      window.alert("동작을 고르지 않은 제한이 있습니다. 지우거나 동작을 고르세요.");
      return;
    }
    // An empty answer is sent only when there is something to clear.
    //
    // With nothing standing the two answers have the same outcome - no restrictions either way -
    // and the difference is what they do with a document that disagrees with the record. "Clear"
    // deletes whatever is in it; "says nothing" carries it forward. The approver read the record,
    // and a statement it does not know about is one they were never shown, so the safe answer is
    // the one that keeps it. It also spares the writer a run that would change nothing.
    const standing = detail.restrictions_in_force ?? [];
    const active = decidable && (chosen.length > 0 || standing.length > 0) ? chosen : null;
    const granting = decision === "approve" ? grantTo : [];
    // A withdrawal rides on the apply that follows an approval. A denied plan applies nothing, so
    // there is no run to carry it - the server refuses that pairing and so does this.
    const withdrawing = decision === "approve" ? revokeFrom : [];
    const what = detail.resource ?? detail.plan_id;
    const suffix = active && active.length > 0 ? ` 제한 ${active.length}건과 함께` : "";
    // A clear is named on its own line, because it is the one restriction answer that DELETES.
    // "제한 없이 승인합니다" reads as "I restricted nothing"; what actually happens is that every
    // restriction standing on this permission set comes off, and an approver who did not mean to
    // empty the form has to be able to see that before the button does it.
    const cleared = active && active.length === 0 && standing.length > 0
      ? `\n\n그리고 지금 걸려 있는 제한 ${standing.length}건을 모두 해제합니다.`
      : "";
    // Named separately in the confirmation, because it is a separate act. Approving the plan and
    // granting somebody the ability to pass the role are different decisions, and a reviewer who
    // reads only this line has to see both.
    const grants = granting.length > 0
      ? `\n\n그리고 ${granting.join(", ")} 에게 이 역할의 PassRole 을 부여합니다.`
      : "";
    const revokes = withdrawing.length > 0
      ? `\n\n그리고 ${withdrawing.join(", ")} 에게서 이 역할의 PassRole 을 회수합니다.`
      : "";
    if (
      !window.confirm(
        `${what} 를${suffix} ${decision === "approve" ? "승인" : "거부"}합니다.`
        + `${cleared}${grants}${revokes}`)
    ) {
      return;
    }
    onDecide(decision, reviewer.trim(), comment.trim(), active, granting, withdrawing, analysis);
  };

  return (
    <div className="detail">
      <h2>{detail.resource ?? detail.plan_id}</h2>
      <div className="meta">
        <span>계정: {detail.account_id ?? "—"}</span>
        {/* Which inspection produced the plan currently stored. Not part of the key - the key is
            the governed resource - but it is what the approval marker gets named by. */}
        <span>요청: {detail.request_id ?? "—"}</span>
        <span>
          계획 시각: {detail.planned_at ? clock(detail.planned_at) : "—"}
        </span>
      </div>

      {/* Two questions about one resource, and the answer to one is not the answer to the other.
          Only offered where there is a PassRole request - a tab that opens an empty panel is a tab
          people learn to ignore. */}
      {((detail.passrole?.requested_by ?? []).length > 0
        || (detail.passrole?.untagged ?? []).length > 0
        // An ungrantable ask opens the tab too. Without this the panel below existed and there was
        // no way to reach it: the tab was gated on requested_by, which an ungrantable ask is
        // deliberately kept out of, so a role tagged for a user with no permission set showed the
        // assessment view and nothing else.
        || (detail.passrole?.unavailable ?? []).length > 0
        // And whoever holds it now. This is the case the tab was closed on: a grant held by
        // somebody whose tag went in an earlier inspection is in no request list at all, so the
        // only screen that can take it back had no way in.
        || (detail.passrole?.granted_to ?? []).length > 0
        || (detail.passrole_withdrawals ?? []).length > 0) && (
        <div className="tabs detail-tabs">
          <button
            type="button"
            className={view === "assessment" ? "tab active" : "tab"}
            onClick={() => onView("assessment")}
          >
            영향도 · 위험 분석
          </button>
          <button
            type="button"
            className={view === "passrole" ? "tab active" : "tab"}
            onClick={() => onView("passrole")}
          >
            PassRole {detail.passrole.requested_by.length > 0
              ? `요청 ${detail.passrole.requested_by.length}`
              : ''}
            {(detail.passrole?.unavailable ?? []).length > 0
              ? ` 부여 불가 ${detail.passrole.unavailable.length}`
              : ''}
            {(detail.passrole?.granted_to ?? []).length > 0
              ? ` 부여됨 ${detail.passrole.granted_to.length}`
              : ''}
          </button>
        </div>
      )}

      {/* First on the page and above everything, because it outranks everything: it says the last
          thing that happened to this resource was a refusal, and until it existed that sentence
          lived only in the container's log. */}
      {detail.refusal && <RefusalNotice refusal={detail.refusal} planStored={detail.plan_stored} />}

      {/* Nothing below this line applies to a resource that has never been planned. The assessment
          notice, the empty change table, the plan pane and the decision form would each describe an
          absent plan as if it were an unremarkable one - and the decision form would offer buttons
          the server refuses. The reason above is the whole page. */}
      {!detail.plan_stored && detail.refusal ? null : (
      <>

      {/* The assessment, or what is happening instead of one.
          Approval is never blocked on this: a plan can be approved with no assessment at all, and
          making the decision path depend on the querier would turn an assessment outage into a
          pipeline outage. What is unavailable without one is the RESTRICTION - it names resources,
          and the enumerated set is the only fence those names can be checked against. */}
      {view === "passrole" ? null : detail.assessment ? (
        <>
          {/* Editing is closed when nothing can say what is already standing.
              Approving replaces the whole restriction family with what is ticked here, so ticking
              anything without seeing what stands drops the rest - and the approver would have no
              way to know. Approving with NOTHING ticked stays available and is still safe here,
              because a closed editor sends no restrictions key at all: the writer reads that as
              "this decision says nothing about them" and carries the existing ones forward. An
              empty form on a LIVE editor is the opposite answer - it sends [], which clears - and
              that is the difference this notice exists to keep true. */}
          {inForceUnknown && (
            <div className="notice">
              <strong>지금 걸려 있는 제한을 확인할 수 없어 제한 편집을 닫았습니다.</strong> 이
              권한 세트에 대해 인라인 작성기가 아직 돌지 않았거나, 마지막 실행이 무엇이 걸렸는지
              기록하지 못했습니다. 이 상태에서 제한을 고르면 <strong>화면에 보이지 않는 기존
              제한이 함께 지워집니다</strong> — 승인은 그 가족 전체를 고른 것으로 교체하기
              때문입니다. 제한 없이 승인하는 것은 안전합니다. 기존 제한은 그대로 이월됩니다.
            </div>
          )}
          <RestrictionTemplates
            assessment={detail.assessment}
            disabled={busy || decided || inForceUnknown}
            onApply={(seeded) => setRestrictions((current) => mergeTemplate(current, seeded))}
          />
          <Impact
            assessment={detail.assessment}
            source={detail.assessment_source}
            restrictions={restrictions}
            onChange={setRestrictions}
            disabled={busy || decided || inForceUnknown}
            findings={findings}
          />
        </>
      ) : assessmentState === "in_progress" ? (
        <div className="notice">
          <strong>영향도 평가가 진행 중입니다.</strong> 이 계획은 지금도 승인할 수 있습니다 — 다만
          제한을 걸려면 평가가 끝나야 합니다. 평가가 끝나면 이 화면에 나타납니다.
        </div>
      ) : (
        <div className="notice">
          이 계획에는 영향도 평가가 없습니다. 승인은 가능하지만 <strong>제한은 걸 수 없습니다</strong> —
          제한은 자원을 지목하고, 그 이름을 대조할 근거가 평가뿐입니다.
        </div>
      )}

      {/* The findings. Below the assessment because it reads the assessment, and above the plan
          because a grade an approver has not seen yet is worth more than terraform's own output,
          which they will read next either way. */}
      {view === "passrole" ? null : (
      <RiskAnalysis
        planId={detail.plan_id}
        ready={!!detail.assessment}
        onAnalysis={setAnalysis}
        onFindings={(scope, found) => setFindings((prev) => ({ ...prev, [scope]: found }))}
        assessment={detail.assessment ?? null}
        restrictions={restrictions}
        onRestrictions={setRestrictions}
        restrictDisabled={busy || decided || inForceUnknown}
      />
      )}

      {/* What the plan does, and terraform's own words for it. On the PassRole view neither is the
          question - the plan that carries a request moves no resource, so the change table would
          read "변경 없음" over a screen that is entirely about a change of permission. */}
      {view === "passrole" ? null : (
      <>
      <h3>바뀌는 것</h3>
      {detail.changes.length === 0 ? (
        <div className="empty">
          변경 없음. 트윈이 이미 spec과 일치하므로 결정할 것이 없습니다. 이 계획이 저장된 이유는
          앞의 계획을 덮기 위해서입니다 — 건너뛰었다면 이미 되돌린 수정을 승인할 수 있는 계획이
          그대로 남았을 것입니다.
        </div>
      ) : (
        <table className="policy-table">
          <thead>
            <tr>
              <th>동작</th>
              <th>주소</th>
              <th>유형</th>
            </tr>
          </thead>
          <tbody>
            {detail.changes.map((c) => (
              <tr key={c.address}>
                <td>
                  <span className={actionClass(c.actions)}>{c.actions.join("+")}</span>
                </td>
                <td>{c.address}</td>
                <td className="muted">{c.type}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>terraform plan</h3>
      <pre className="plan">{detail.plan_text || "plan.txt 가 없습니다."}</pre>

      <details>
        <summary>생성된 구성 (main.tf.json)</summary>
        <pre className="plan">{detail.config_json || "main.tf.json 이 없습니다."}</pre>
      </details>
      </>
      )}

      {/* The other question. Always rendered on its own view; never on the assessment one, where a
          confirmation sitting under a restriction picker reads as part of the same decision. */}
      {view === "passrole" && (
        <>
          <PassroleRequests
            detail={detail}
            confirmed={grantTo}
            onConfirmed={setGrantTo}
            withdrawn={revokeFrom}
            onWithdrawn={setRevokeFrom}
            disabled={busy || decided}
          />
          {/* What became of the LAST decision's work orders. Below the requests, because a request
              is about what to do next and this is about whether what was decided actually
              happened - and the second is the one that goes unread if it is not put in front of
              somebody who came here for the first. */}
          <PassroleWriters
            writers={detail.passrole_writers ?? []}
            disabled={busy}
            onRetry={onRetryPassrole}
          />
          {/* Who holds it today, and the only path that takes it back once the plan is applied. */}
          <PassroleHolders
            detail={detail}
            disabled={busy}
            onRevoke={onRevokePassrole}
          />
        </>
      )}

      {/* Both values go into the marker and both are checked before anything is applied. Worth
          being able to read them here: if a decision is ever disputed, these are what the applier
          compared against. The first is the file itself, the second is what it will do. */}
      <div className="meta small">
        tfplan sha256: <code>{detail.plan_file_sha256 ?? "계산할 수 없음"}</code>
        {detail.plan_bytes !== null ? ` · ${detail.plan_bytes} bytes` : ""}
      </div>
      <div className="meta small">
        변경 다이제스트: <code>{detail.changes_sha256 ?? "없음"}</code>
      </div>

      {detail.changes_sha256 ? null : (
        <div className="row-warn">
          이 계획에는 <code>changes.sha256</code>이 없어 <strong>승인할 수 없습니다.</strong> 그
          값을 쓰지 않던 검사기가 만든 계획입니다. 계획 접두사는 객체 다섯 개이고, 일부만 덮어써지면
          한 계획의 <code>tfplan</code> 옆에 다른 계획의 <code>plan.txt</code>가 남을 수 있습니다.
          그 다이제스트가 있어야 적용기가 <code>terraform show</code>로 위에 보이는 설명이 실제
          적용할 파일을 설명하는지 확인합니다. 자원을 다시 변경해 새 계획을 받으면 됩니다.
        </div>
      )}

      {detail.outcome ? (
        <div className="row-warn">
          {/* Terminal. The applier has finished with this plan and outcome.json records what it
              did - which is also the surviving copy of the decision, since the approval marker is
              deleted once this is written. */}
          <strong>
            {detail.outcome.applied ? "적용 완료" : "적용하지 않고 종료"}
          </strong>
          {" — "}
          {detail.outcome.reviewer ?? "검토자 미상"}
          {detail.outcome.decision === "deny" ? " 이(가) 거부했습니다." : " 의 승인."}
          {detail.outcome.finished_at
            ? ` (${clock(detail.outcome.finished_at)})`
            : ""}
          {detail.outcome.detail ? <pre className="plan">{detail.outcome.detail}</pre> : null}
          다시 결정하려면 자원을 변경해 새 계획을 받으십시오.
        </div>
      ) : null}

      {decided && !detail.outcome ? (
        <div className="row-warn">
          이 요청에는 이미 결정이 기록되어 있고 적용기가 아직 끝내지 않았습니다. 다시 결정하면
          기록을 덮어씁니다.
        </div>
      ) : null}

      <div className="decision">
        <div className="row">
          <input
            placeholder="검토자 (기록에 그대로 남습니다)"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          />
        </div>
        <textarea
          placeholder="사유 — 거부할 때는 필수"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="actions">
          {/* Approving is disabled when the server would refuse it - no digest to bind the
              decision to, or nothing for the applier to do. Offering a button that always fails is
              worse than not offering one. Denying stays available: a plan nobody can approve is
              exactly one somebody may want to refuse. */}
          <button
            className="btn-approve"
            disabled={busy || !detail.changes_sha256 || !detail.has_changes || !!detail.outcome}
            onClick={() => submit("approve")}
          >
            승인
          </button>
          <button
            className="btn-deny"
            disabled={busy || !!detail.outcome}
            onClick={() => submit("deny")}
          >
            거부
          </button>
        </div>
        <div className="meta small muted">
          승인은 <code>applier/{detail.request_id}.json</code> 객체 하나를 쓰는 것이 전부입니다.
          적용기를 직접 실행하지 않습니다 — 이 화면은 <code>ecs:RunTask</code> 권한을 갖지
          않습니다.
        </div>
      </div>

      </>
      )}
    </div>
  );
}

/**
 * Why the last inspection produced no plan.
 *
 * The observed silence this ends: a spec role carrying twelve managed policies was refused because
 * a permission set may hold ten. The run had genuinely completed, so its marker was deleted, so the
 * request left no row, no failure and no plan - the reason existed in the container's log and
 * nowhere the administrator who made the edit would ever look. Their side of it was that they
 * changed something and nothing happened.
 *
 * The reason is printed verbatim and never summarised into a category. "12 managed policies
 * including the baseline, and the limit is 10" tells somebody to remove two; a category would tell
 * them to go and read the log, which is where this started.
 *
 * Two shapes, because they ask for different things:
 *
 *   no plan stored     the first inspection of this resource refused. There is nothing to decide
 *                      and nothing else on the page
 *   plan stored        a plan is here and this refusal is NEWER than it. The plan is real and
 *                      approvable and describes an EARLIER version of the resource, which is the
 *                      part nothing said before
 */
/**
 * Why the last inspection produced no plan — and what the person reading it should do next.
 *
 * Two kinds behind one artifact, and the difference is the ACTION, not the severity. A refusal is a
 * verdict: reading the same resource refuses the same way forever, so the sentence names something
 * to change. A stopped attempt — a plan lock held by another run, a throttled call, an upload that
 * did not land — could go differently on another run.
 *
 * They were rendered identically, which was worse than the silence the artifact was written to end:
 * an administrator reading "위 사유가 가리키는 것을 고치고 자원을 다시 변경하십시오" after a state
 * lock timeout goes and edits a resource that was never broken.
 *
 * What this must NOT say is that a retry is coming. Nothing re-runs a stopped inspection: the rule's
 * RetryPolicy covers EventBridge failing to START the task, and once it starts the rule is finished
 * with the event (opt-stack-ecs-runtime.yaml). Telling somebody to wait is the same failure as
 * telling them to fix the wrong thing — it ends with nobody acting, which is where this began.
 */
function RefusalNotice({ refusal, planStored }: { refusal: PlanRefusal; planStored: boolean }) {
  const stopped = refusal.retryable;
  return (
    <div className={stopped ? "refusal refusal-stopped" : "refusal"}>
      <strong>
        {stopped
          ? (planStored
            ? "마지막 검사가 끝나지 못해 이 계획은 최신이 아닙니다."
            : "이 자원의 검사가 끝나지 못해 계획이 만들어지지 않았습니다.")
          : (planStored
            ? "마지막 검사가 거부되어 이 계획은 최신이 아닙니다."
            : "이 자원의 검사가 거부되어 계획이 만들어지지 않았습니다.")}
      </strong>
      {/* The sentence the container wrote, unchanged. */}
      <pre className="plan">{refusal.reason}</pre>
      <div className="meta small">
        <span>
          {stopped ? "멈춘 시각" : "거부 시각"}:{" "}
          {refusal.refused_at ? clock(refusal.refused_at) : "—"}
        </span>
        <span>요청: {refusal.request_id ?? "—"}</span>
        {refusal.kind && <span>유형: {refusal.kind}</span>}
      </div>
      {stopped ? (
        <p>
          <strong>자원은 고칠 것이 없을 수 있습니다</strong> — 거부가 아니라 검사가 도중에 멈춘
          것이고, 한 번 더 돌면 계획이 나올 수 있습니다. 위 사유가 무엇을 기다리다 멈췄는지
          말합니다.{" "}
          <strong>다만 자동으로 다시 돌지는 않습니다</strong> — 규칙의 재시도는 작업을 시작하지
          못한 경우를 덮고, 시작한 뒤 실패한 작업은 그 규칙이 손을 뗍니다. 자원을 다시 변경하면
          새 검사가 시작됩니다.{" "}
          {planStored
            ? "그때 만들어지는 계획이 아래 계획을 덮습니다."
            : "그때 계획이 이 자리에 나타납니다."}{" "}
          마커 버킷 <code>inspector/</code> 에 이 요청의 마커가 남아 있습니다.
        </p>
      ) : planStored ? (
        <p>
          아래 계획은 그 이전 검사가 만든 것이고 지금의 자원을 설명하지 않습니다. 그대로 승인할 수는
          있으나, 승인하면 거부된 검사 이전의 spec이 적용됩니다. 위 사유가 가리키는 것을 고치고 자원을
          다시 변경하면 검사가 다시 돌아가고, 그때 만들어지는 계획이 이 계획을 덮습니다.
        </p>
      ) : (
        <p>
          결정할 것이 없습니다 — 승인하거나 거부할 계획 자체가 없습니다. 위 사유가 가리키는 것을
          고치고 자원을 다시 변경하십시오. 다음 검사가 계획을 만들면 이 자리에 나타납니다.
        </p>
      )}
    </div>
  );
}

/**
 * The decisions an organisation made once, offered as a pre-filled form.
 *
 * Deliberately not a policy installed anywhere. A template seeds the restriction array the approver
 * is already looking at - they see it, edit it, and approve it for THIS plan - so every gate the
 * route and the inline writer hold still runs, unchanged, on an ordinary decision with a reviewer
 * and a comment and an assessment digest behind it. server/templates.js records why the other shape
 * was refused.
 *
 * Above the editor because it fills the editor in, and what it drops is said before the button is
 * pressed: an action no attached policy grants cannot be restricted, and a template that quietly
 * shrank would read as a control that was fully applied.
 */
function RestrictionTemplates({ assessment, disabled, onApply }: {
  assessment: Assessment;
  disabled: boolean;
  onApply: (seeded: Restriction[]) => void;
}) {
  const [templates, setTemplates] = useState<RestrictionTemplate[]>([]);
  const [applied, setApplied] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((body) => { if (live) setTemplates(body.templates ?? []); })
      .catch(() => { if (live) setTemplates([]); });
    return () => { live = false; };
  }, []);

  // Recomputed per template because what survives depends on THIS assessment's grants.
  const seeded = useMemo(
    () => templates.map((template) => ({ template, ...seedFromTemplate(template, assessment) })),
    [templates, assessment],
  );
  if (seeded.length === 0) return null;

  return (
    <details className="templates">
      <summary>표준 제한 적용 ({seeded.length}개)</summary>
      <p className="muted small">
        조직이 한 번 정해 둔 결정이다. 누르면 아래 편집기가 채워질 뿐이고, 승인은 여전히 이 계획에
        대한 결정으로 나간다 — 고치고 빼는 것도 그대로 된다.
      </p>
      {seeded.map(({ template, restrictions, dropped }) => (
        <div key={template.id} className="template-row">
          <div className="control-row">
            <span className="section-name">{template.title}</span>
            <button
              type="button"
              disabled={disabled || restrictions.length === 0}
              onClick={() => { onApply(restrictions); setApplied((a) => [...a, template.id]); }}
            >
              {restrictions.length > 0 ? `제한 ${restrictions.length}건 채우기` : "적용할 것이 없다"}
            </button>
            {applied.includes(template.id) && <span className="rtype">채웠다</span>}
          </div>
          <p className="muted small">{template.why}</p>
          {dropped.length > 0 && (
            <p className="warn-inline">
              {dropped.length}개는 이 계획에 걸 수 없어 빠진다 —{" "}
              {dropped.slice(0, 4).map((d) => `${d.action}(${
                d.why === "protected" ? "선언 경로"
                  : d.why === "no_resource_tag" ? "태그를 읽지 않는 동작" : "부여되지 않음"})`)
                .join(", ")}
              {dropped.length > 4 && ` 외 ${dropped.length - 4}개`}
            </p>
          )}
        </div>
      ))}
    </details>
  );
}

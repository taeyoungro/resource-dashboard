// Who holds PassRole on this role RIGHT NOW, as against who held it when the plan was generated.
//
// The value that separates a request from a grant is `passrole_granted_to`:
//
//   무엇인가   지금 이 미러 역할을 넘길 수 있는 사람. 요청이 아니라 부여다. 원본 역할의 태그가
//              요청이고, 미러 역할의 태그가 부여다 - SCP-8.16 이 미러 역할 태그 쓰기를 적용기
//              하나로 묶어 두기 때문에 그 태그가 기록이 된다
//   어디 있나  미러 역할 계획의 terraform 출력값. 상태 버킷 <계정>/<자원>/plan/main.tf.json 에
//              리터럴로, plan.json 에는 output_changes 로
//   누가 쓰나  검사기 하나. generator/mirror_role.py 가 `granted is True` 인 요청만 낸다
//   누가 읽나  이 파일, sweep.js 의 holdersFromConfig 와 passroleFromPlan, 그리고 그 둘을 통해
//              PlanDetail.tsx 의 「지금 상태」열·PassRole 탭 라벨·「지금 부여된 사람」 표
//
// And it is a SNAPSHOT. The inspector reads the mirror role's tags while generating the plan, and
// everything that grants happens afterwards: the approver decides, the applier tags the mirror role
// and dispatches, the inline writer puts the statement in force. None of them touches the plan
// artifacts, and none of them may - the saved plan file's digest is what an approval binds to.
//
// So the screen kept showing the pre-grant snapshot until some later event caused a new inspection.
// A grant that was live in the account read as 미부여, the PassRole panel called it a 요청, and
// - because the holders table is the only screen that can take a grant back, and it renders from
// the same list - a grant that was visible in the inline policy and on the mirror role's tag could
// not be revoked at all. Attaching another tag "fixed" it, which is the same as saying the fix was
// an accident.
//
// This closes it with the one thing that is newer than the snapshot and knows more than it: the
// inline writer's own record of what its run left standing. See
// event_pipeline/code/inline_writer/inline_writer/result.py - `passrole_in_force` is every mirror
// role ARN that permission set may pass after the run, read out of the document that was applied.
//
// The rule is three-valued and the third value is the whole design:
//
//   writer says yes  -> holder. It applied the document and read the ARN out of it
//   writer says no   -> not a holder. Same authority, same read
//   writer is silent -> whatever the snapshot said. A run that failed, a person the decision never
//                       named, a grant older than this feature - none of them are evidence of
//                       anything, and inventing an answer here is how a live grant leaves the
//                       screen and becomes unrevokable again
//
// null and [] are therefore different on the way in, and the writer records the difference: null is
// "this run cannot say" and [] is "this permission set passes nothing", which a revocation that
// emptied the document legitimately produces.

/** The mirror role this plan is about, by name.
 *
 * From the GENERATED document rather than from plan.json, because the name is literal there - the
 * inspector composed it - while the plan's `passrole_target_arn` is "(known after apply)" on a role
 * the plan is creating. The sweep already reads main.tf.json for every row, so this costs nothing.
 */
export function mirrorRoleFromConfig(document) {
  const name = document?.resource?.aws_iam_role?.mirror?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Whether a set of role ARNs contains this mirror role.
 *
 * By ARN suffix, so the caller may hold either the name (the sweep, from main.tf.json) or the whole
 * ARN (the detail page, from plan.json) and both ask the same question. A mirror role is created by
 * the document with a bare `name` and no path, so `:role/<name>` is exact rather than a prefix
 * match that a path could defeat.
 */
export function namesMirrorRole(arns, mirrorRoleName) {
  if (!Array.isArray(arns) || !mirrorRoleName) return false;
  const suffix = `:role/${mirrorRoleName}`;
  return arns.some((arn) => typeof arn === 'string' && arn.endsWith(suffix));
}

/** What one inline_result document says about this mirror role, or null if it says nothing.
 *
 * Only a run that applied a document has an answer. `state` is checked as well as the field,
 * because a failed run records the state and leaves the field null, and reading a missing field as
 * "no roles" would let a failure revoke every holder on the screen.
 */
export function writerVerdict(result, mirrorRoleName) {
  if (!result || result.state !== 'written') return null;
  const arns = result.passrole_in_force;
  if (!Array.isArray(arns)) return null;
  return namesMirrorRole(arns, mirrorRoleName);
}

/** Every work order that touched THIS resource's grant, from both routes that produce one.
 *
 * Two routes and one shape. An approval's grants and withdrawals are in outcome.json under
 * `passrole_dispatch`; a standalone withdrawal has no plan decision behind it and records its own
 * work orders in passrole.json. Both name the person and the lock key, which is all the join needs.
 *
 * The outcome's entries are passed already matched to the plan's request id - an outcome about an
 * earlier inspection describes a plan that is no longer standing, and the snapshot beside the
 * current one has since been refreshed by the inspection that replaced it.
 */
export function dispatchesTouching(dispatched, withdrawals) {
  const out = [];
  const add = (entry) => {
    if (!entry || typeof entry.user_name !== 'string' || !entry.user_name.trim()) return;
    if (typeof entry.key !== 'string' || !entry.key) return;
    out.push({ user_name: entry.user_name.trim(), key: entry.key });
  };
  for (const entry of Array.isArray(dispatched) ? dispatched : []) add(entry);
  for (const action of Array.isArray(withdrawals) ? withdrawals : []) {
    for (const entry of Array.isArray(action?.dispatched) ? action.dispatched : []) add(entry);
  }
  return out;
}

/** The live holder set, and where each name came from.
 *
 * `snapshot` is passrole_granted_to. `results` maps a lock key to the inline writer's record for it.
 * `mirrorRoleName` is the role the question is about; without it nothing can be joined and the
 * snapshot stands unchanged, which is the honest answer rather than a guess.
 *
 * A person named by more than one work order - granted, then revoked, then granted again - is
 * decided by the LATEST evidence, and the object under the lock key is exactly that: the writer
 * overwrites it on every run, so it describes the permission set as it is now and not as any one
 * decision left it.
 */
export function liveGrants({ snapshot, dispatched, withdrawals, results, mirrorRoleName }) {
  const held = new Set((Array.isArray(snapshot) ? snapshot : [])
    .filter((name) => typeof name === 'string' && name.trim()));
  const before = new Set(held);
  const confirmed = new Set();
  const released = new Set();
  const unknown = new Set();

  if (mirrorRoleName) {
    for (const { user_name: user, key } of dispatchesTouching(dispatched, withdrawals)) {
      const verdict = writerVerdict(results?.get?.(key) ?? null, mirrorRoleName);
      if (verdict === null) {
        // The writer touched this person and cannot say. Nothing changes - and it is said out loud
        // rather than folded into the snapshot, because "we asked and got no answer" is what an
        // approver needs in order to reach for the retry instead of the revoke.
        unknown.add(user);
        continue;
      }
      if (verdict) {
        held.add(user);
        if (!before.has(user)) confirmed.add(user);
      } else {
        held.delete(user);
        if (before.has(user)) released.add(user);
      }
      unknown.delete(user);
    }
  }

  const sorted = (set) => [...set].sort();
  return {
    holders: sorted(held),
    snapshot: sorted(before),
    // In force since the plan was generated. The names the screen was missing.
    confirmed: sorted(confirmed),
    // In the snapshot and no longer in force. A withdrawal the inspector has not seen yet.
    released: sorted(released),
    // Touched, and the writer's run has no answer. Still counted as the snapshot counted them.
    unknown: sorted([...unknown].filter((name) => !confirmed.has(name) && !released.has(name))),
  };
}

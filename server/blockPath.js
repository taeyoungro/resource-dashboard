// From a risk finding to the restriction that cuts it - the part that is data, not screen.
//
// A finding card names the actions that make a path real (발화 동작) and, for a model finding, the
// actions the model judged sufficient to cut it (거부할 동작). The block-path dialog turns those
// into restrictions in the SAME array the per-policy editor composes, so the one inline document
// and the one 인라인 정책 보기 keep being the whole story. Nothing here composes a statement -
// composition stays in inlinePreview.js and, authoritatively, in generator/restriction.py.
//
// Plain JS with a .d.ts beside it, same arrangement as inlinePreview.js and for the same reason:
// node --test is the one test runner here and it cannot load TypeScript - and what this file holds
// is exactly the part worth pinning with tests: which actions a card offers, and what applying the
// dialog does to the restriction set.

/**
 * The actions a finding's block dialog offers, in the order the card showed them.
 *
 * Which list seeds it is the one judgement in this file:
 *
 *   model finding    containment.denyActions when the model provided them - that list is already
 *                    the model's answer to "what do I deny to cut this path", and offering the
 *                    wider cited set would put actions on the table the verdict did not ask for
 *   rule finding     triggerActions. A rule has no containment verdict; what made the card appear
 *                    is what there is to deny
 *
 * Protected actions are OFFERED and marked, never silently dropped - the same rule Containment
 * renders by: a list that quietly shrank reads as a shorter answer, and the administrator cannot
 * tell which they are looking at. They are unselectable; the mark says why.
 */
export function blockOffer(finding, protectedActions = []) {
  const forbidden = new Set([
    ...(protectedActions ?? []),
    ...(finding?.containment?.notRestrictable ?? []),
  ]);
  const source = finding?.source === 'model' && (finding?.containment?.denyActions ?? []).length > 0
    ? finding.containment.denyActions
    : finding?.triggerActions ?? [];
  const seen = new Set();
  const offered = [];
  for (const action of source) {
    if (typeof action !== 'string' || !action.trim() || seen.has(action)) continue;
    seen.add(action);
    offered.push({ action, protected: forbidden.has(action) });
  }
  return offered;
}

/**
 * The restriction set after the dialog's 적용 - additions merged, prior decisions on the same
 * (policy, action) replaced.
 *
 * Replacement is the deliberate part. The editor refuses one action in two sections, because two
 * statements about one action are a contradiction the wider one wins; a dialog that APPENDED would
 * manufacture exactly that. So an action being written here sheds whatever decision it carried
 * before, under any intent, for this policy - the administrator just made a newer decision about
 * it, and the dialog says so on the rows it will happen to. Other policies' restrictions and this
 * policy's untouched actions pass through byte-identical.
 */
export function mergeBlock(existing, policy, additions) {
  const replacing = new Set(
    (additions ?? []).flatMap((r) => r.actions ?? []).filter(Boolean),
  );
  const kept = (existing ?? []).filter(
    (r) => r.policy !== policy || !(r.actions ?? []).some((a) => replacing.has(a)),
  );
  return [...kept, ...(additions ?? [])];
}

/**
 * Which of a finding's offered actions already carry a restriction under its policy.
 *
 * For two screens: the dialog marks the rows 적용 will overwrite, and the card shows 반영됨 after -
 * the confirmation that the path's actions now sit in the document the 인라인 정책 보기 shows,
 * without the reader having to scroll up and diff a policy by eye.
 */
export function alreadyRestricted(finding, restrictions) {
  const held = new Set(
    (restrictions ?? [])
      .filter((r) => r.policy === finding?.policyName)
      .flatMap((r) => r.actions ?? []),
  );
  return blockOffer(finding).filter((o) => held.has(o.action)).map((o) => o.action);
}

/**
 * How much of this path the decision being composed actually cuts.
 *
 * Three answers, and the distinction that matters is the first one:
 *
 *   full     every action the card offers is denied OUTRIGHT - intent deny_action, which composes a
 *            Deny with Resource "*" and no Condition. Nothing about the account can walk past it
 *   partial  something was written for this path and it is not that. Every other intent is
 *            conditional on something the statement names: allow_only and deny_only on a list of
 *            ARNs, which is a list of what exists TODAY, and the condition intents on a tag or a
 *            request key whose value somebody may be able to choose. Those are real controls and
 *            they are not the same claim
 *   none     nothing has been written for this path yet
 *
 * A protected action can never be denied, so a card holding one is never full however much is
 * written: the declaration path stays open by design and calling that "완전 차단됨" would promise an
 * administrator something the restriction cannot deliver. This is the same rule Containment renders
 * by, applied to the summary badge.
 */
export function containmentState(finding, restrictions, protectedActions = [],
                                 passroleGrants = null) {
  const offered = blockOffer(finding, protectedActions);
  if (offered.length === 0) return 'none';

  const mine = (restrictions ?? []).filter((r) => r.policy === finding?.policyName);
  const denied = new Set(
    mine.filter((r) => r.intent === 'deny_action').flatMap((r) => r.actions ?? []),
  );
  const touched = new Set(mine.flatMap((r) => r.actions ?? []));
  const fenced = fencedActions(passroleGrants);

  // A path whose load-bearing action is gone cannot hold, however much of the rest is still
  // granted. Answering this by counting names - all eight denied or it is not closed - was wrong in
  // both directions for a rule with an allOf at its root: E-1 needs iam:PassRole and four of its
  // other seven actions are interchangeable, so denying seven of eight closed nothing and denying
  // the one closed everything.
  //
  // `some`, and the asymmetry is the point: every member of requiredActions is INDIVIDUALLY
  // necessary - it earned its place by making the predicate unsatisfiable when removed - so cutting
  // any ONE of them is the whole cut. Asking for all of them would be asking to close the same door
  // several times, and on a grant holding only the three actions E-1 names, all three are required
  // and denying any one of them ends it.
  const required = (finding?.requiredActions ?? []).filter(
    (a) => !protectedActions?.includes?.(a),
  );
  if (required.some((a) => denied.has(a) || fenced.has(a))) {
    // Which control did it decides which of the two answers this is. The administrator's own
    // outright deny is 완전 차단됨; the fence is something else entirely and must not borrow that
    // badge - nobody drafted it, it is there before the screen opens, and what it leaves standing
    // is a list this artifact does not read.
    return required.some((a) => fenced.has(a) && !denied.has(a)) ? 'fenced' : 'full';
  }

  if (offered.every((o) => !o.protected && denied.has(o.action))) return 'full';
  if (offered.some((o) => touched.has(o.action))) return 'partial';
  return offered.some((o) => fenced.has(o.action)) ? 'partial' : 'none';
}

/**
 * The actions the inline document already denies without anybody drafting anything.
 *
 * There is exactly one today and it is iam:PassRole. composeInline appends a fence statement per
 * service any attached policy's PassRole grant names, whether or not a restriction was written -
 * Deny iam:PassRole, NotResource [the placeholder], Condition iam:PassedToService = that service.
 * The generator's own note is what makes this a cut rather than a narrowing: the placeholder role
 * is doubly unreachable, since the pipeline only ever creates mirror-<service>-<name> and the
 * organisation's SCP bars anyone else from the namespace, so the NotResource entry names no role
 * that can exist. Approved mirror ARNs are appended beside it by the grant flow, and THAT list -
 * not the account's roles - is the ceiling on what this path can still reach.
 *
 * A grant carrying no iam:PassedToService fences nothing, and the refusal is not this file's: the
 * writer raises on `unconditioned` rather than guessing a condition, so no fence is written for any
 * service and the whole document is refused. One such grant therefore disarms the lot, which is why
 * this is `every` and not `some`.
 */
export function fencedActions(passroleGrants) {
  const grants = passroleGrants ?? [];
  const fenceable = grants.length > 0
    && grants.every((g) => g?.unconditioned !== true && (g?.services ?? []).length > 0);
  return new Set(fenceable ? ['iam:PassRole'] : []);
}

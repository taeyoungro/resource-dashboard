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

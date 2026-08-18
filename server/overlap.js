// Which candidates a rule has already found.
//
// The two halves of the analysis run over the same digest and reach the same places by different
// routes, so they collide. Measured on one assessment: 21 candidates and 18 rule findings, of which
// twelve pairs were the same path said twice - E-3 and C5 on lambda:UpdateFunctionCode, D-3 and C12
// on ec2:TerminateInstances, X-2 and five separate network candidates. An approver read each of
// those twice, under two labels, and in two cases at two different grades: D-3 said LOW where C12
// said MEDIUM for the identical action on the identical instances.
//
// Two grades for one fact is worse than either grade alone, because the reader has to decide which
// half of their own tool to believe.
//
// So the overlap is computed here, deterministically, from what both halves already produced, and
// the candidate carries it into the prompt. The model is then told what the rules found and asked
// to judge whether it has anything to add - which is a question it can answer, unlike "avoid
// duplicating rules you were shown a list of titles for".
//
// Deliberately NOT a filter. A candidate a rule already covers can still be worth a verdict: the
// rule states the path and the model states whether it is reachable HERE, and dropping the
// candidate would take the second half of that away. What changes is that the model knows, and the
// page can group them.

/** Same policy, same resource type, and at least one action in common. */
function sameGround(candidate, finding) {
  if (finding.policyId !== candidate.policy_id) return false;

  const theirs = new Set(finding.triggerActions ?? []);
  const mine = new Set([
    ...(candidate.steps ?? []).flatMap((s) => s.actions),
    ...(candidate.also_granted ?? []).flatMap((s) => s.actions),
  ]);
  const shared = [...mine].filter((action) => theirs.has(action));
  if (shared.length === 0) return false;

  // A targetless candidate is about the grant rather than about what exists, so a rule finding on a
  // named resource type is not the same statement even when the actions match.
  const target = candidate.target?.type ?? null;
  const types = new Set((finding.targets ?? []).map((t) => t.type));
  if (target === null) return types.size === 0;
  return types.has(target);
}

/**
 * Each candidate, with the rule findings that already cover it.
 *
 * The entry carries the rule's id, its grade and the actions the two agree on - enough for the
 * model to say "the rule has this and I have nothing to add" without being handed the rule's
 * narrative to paraphrase.
 */
export function withOverlap(candidates, findings) {
  return candidates.map((candidate) => {
    const covered = findings
      .filter((finding) => sameGround(candidate, finding))
      .map((finding) => ({
        rule: finding.id,
        grade: finding.escalationGrade,
        shared_actions: (finding.triggerActions ?? []).filter((action) =>
          [...(candidate.steps ?? []), ...(candidate.also_granted ?? [])]
            .some((step) => step.actions.includes(action))),
      }));
    return covered.length ? { ...candidate, already_found_by: covered } : candidate;
  });
}

/** How many candidates a rule already covers. For the log line and the page's summary. */
export function overlapCount(candidates) {
  return candidates.filter((c) => (c.already_found_by ?? []).length > 0).length;
}

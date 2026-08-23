// The digest and the candidates as they go ON THE WIRE, which is not how they are held here.
//
// Everything in this file is a change of NOTATION, not of content. The server keeps the digest and
// the candidates in the shape every other consumer already reads - forbiddenNames() walks
// unit.sample for full ARNs, findingOf() puts candidate.target.sample on the card, the page renders
// budget.dropped verbatim - and this converts a copy for the model at the moment the request is
// built. Nothing downstream of the answer reads these shapes, so nothing downstream had to change.
//
// It exists because of where the tokens were. On a grant of ten *FullAccess policies the digest is
// 28.7 kB and the candidate block 27 kB, and:
//
//   - 13.3 kB of the digest is sample ARNs, and 13.9 kB of the candidate block is THE SAME ARNs
//     again, one per candidate target. Over seven batches that is 107 kB - about 36 percent of
//     every token the analysis sends - of strings the frame forbids the model to repeat back.
//   - 1.8 kB of the candidate block is the edge's why sentence, repeated once per candidate over
//     seven distinct edges.
//   - 1.1 kB is the policy ARN, beside a policy_id that names the same grant.
//   - 3.1 kB of the digest is budget.dropped, which is one sentence written eleven times with a
//     different service name in it.
//
// What is NOT done here, and why: the sample is not shortened and not dropped. The frame calls it
// "evidence that resources exist and to be counted", and how many ARNs are enough evidence is a
// question about the analysis rather than about notation. Folding the shared prefix out of them
// costs nothing and answers no such question.

/** Memo, so seven batches of one assessment fold the same digest once. */
const folded = new WeakMap();

/**
 * ARNs with the part they all share stated once.
 *
 *   ["arn:aws:ec2:ap-northeast-2:1234:instance/i-0a", "...instance/i-0b"]
 *     -> prefix "arn:aws:ec2:ap-northeast-2:1234:instance/", sample ["i-0a", "i-0b"]
 *
 * Only when every ARN in the unit shares it. A unit whose ARNs do not agree keeps them whole:
 * a partial fold would be a second notation to explain for no saving worth having.
 */
function foldSample(sample) {
  if (!Array.isArray(sample) || sample.length < 2) return null;
  const first = String(sample[0]);
  const cut = Math.max(first.lastIndexOf('/'), first.lastIndexOf(':'));
  if (cut < 0) return null;
  const prefix = first.slice(0, cut + 1);
  if (!sample.every((arn) => String(arn).startsWith(prefix))) return null;
  return { prefix, tails: sample.map((arn) => String(arn).slice(prefix.length)) };
}

/** budget.dropped, with the reason as a code and the grant as its digest id. */
function foldBudget(budget, grants) {
  const dropped = budget?.dropped ?? [];
  if (dropped.length === 0) return budget;
  const byName = new Map((grants ?? []).map((grant) => [grant.name, grant.p]));
  const reasons = new Map();
  const out = dropped.map((item) => {
    if (!reasons.has(item.why)) reasons.set(item.why, `why${reasons.size + 1}`);
    // "arn:aws:iam::aws:policy/AmazonEC2FullAccess ec2 action names" -> "P1 ec2 action names".
    const what = String(item.what ?? '').replace(/^(\S+)/, (name) => byName.get(name) ?? name);
    return { ...item, what, why: reasons.get(item.why) };
  });
  return {
    ...budget,
    dropped: out,
    why: Object.fromEntries([...reasons].map(([text, code]) => [code, text])),
  };
}

/**
 * The digest as the model receives it.
 *
 * Same object graph, two notations changed. A unit that folds gains arn_prefix and its sample
 * becomes the tails; budget.dropped gains a why table beside it.
 */
export function wireDigest(digest) {
  if (!digest) return digest;
  const hit = folded.get(digest);
  if (hit) return hit;

  const grants = (digest.grants ?? []).map((grant) => ({
    ...grant,
    units: (grant.units ?? []).map((unit) => {
      const fold = foldSample(unit.sample);
      if (!fold) return unit;
      return { ...unit, arn_prefix: fold.prefix, sample: fold.tails };
    }),
  }));

  const out = { ...digest, grants, budget: foldBudget(digest.budget, digest.grants) };
  folded.set(digest, out);
  return out;
}

/**
 * The candidates as the model receives them.
 *
 * Three fields go, and each one is somewhere else in the same request:
 *   why      - the same sentence for every candidate of the edge, now a legend in the frame
 *   policy   - the policy ARN, beside a policy_id that names the same grant in the digest
 *   target.sample, target.sample_complete
 *            - the unit's ARNs, already in the digest under grants[].units[] keyed by the same
 *              resource type this target names. Repeating them made the candidate block a second
 *              copy of the half of the digest that is already the largest.
 */
export function wireCandidates(batch) {
  return (batch ?? []).map((candidate) => {
    const { why, policy, target, ...rest } = candidate;
    // Null rather than absent. The frame reads a null target as "reaches nothing that exists yet",
    // which is a statement about the grant; a missing key is only a missing key.
    if (!target) return { ...rest, target: null };
    const { sample, sample_complete: complete, ...keep } = target;
    return { ...rest, target: keep };
  });
}

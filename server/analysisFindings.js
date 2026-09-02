// What an analysis found, on its way from the panel that ran it to the diagram that draws it.
//
// The findings travel a long way for a small amount of data: RiskAnalysis runs one analysis per
// SCOPE (the plan as a whole, or one attached policy), PlanDetail holds every scope's answer,
// Impact flattens them, and Topology's panel filters them down to the one resource a reader
// clicked. Four components, and the shape passed between them carries a distinction that a count
// destroys - which is why it is stated once here rather than four times in JSX.
//
//   null   THIS SCOPE HAS NOT ANSWERED. Nobody pressed either button, or the plan changed under it.
//   []     It answered and fired nothing.
//
// The diagram prints opposite sentences over the two - 「아직 분석을 돌리지 않았다」 and 「이 자원을
// 지목한 발견이 없다」 - and the first one exists precisely because an approver reading an empty
// section as a clean bill is the most expensive misreading this panel can produce. Inferring it
// from `findings.length > 0` collapses them, and that is what the panel used to do.
//
//     node --test server/analysisFindings.test.js

/**
 * Both halves of one scope's answer, in one list - or null when it has not answered.
 *
 * The model's findings are already marked source: 'model', which is what lets the diagram's panel
 * draw them under their own heading. A DISCARDED model run contributes none: that run cited an
 * action granted nowhere, every verdict in it was thrown away, and the reviewer is looking at the
 * rule findings alone.
 */
export function findingsOfAnswer(answer) {
  if (!answer) return null;
  const model = answer.analysis && !answer.analysis.discarded ? answer.analysis.findings : null;
  return [...(answer.rule_findings ?? []), ...(model ?? [])];
}

/**
 * Every finding the page holds, deduplicated by id.
 *
 * Deduplicated because the plan scope and a policy scope report the SAME finding - a scoped run is
 * a filter over the same engine, not a different analysis - and the panel would otherwise draw it
 * twice. Scopes that have not answered contribute nothing, exactly as scopes that found nothing do:
 * here the two are the same, and the function below is where they differ.
 */
export function everyFinding(byScope) {
  const byId = new Map();
  for (const list of Object.values(byScope ?? {})) {
    for (const finding of list ?? []) {
      if (finding?.id && !byId.has(finding.id)) byId.set(finding.id, finding);
    }
  }
  return [...byId.values()];
}

/**
 * Whether ANY scope has answered - "물어보기는 했나", which the list above cannot answer.
 *
 * One scope is enough. The panel's sentence is about whether the reader has been told anything at
 * all, not about which scope told them: a reader who ran 정책 기반 분석 on the whole plan has run
 * an analysis, and saying otherwise over a resource is the lie this whole module exists to stop.
 */
export function anyAnswered(byScope) {
  return Object.values(byScope ?? {}).some((list) => list !== null && list !== undefined);
}

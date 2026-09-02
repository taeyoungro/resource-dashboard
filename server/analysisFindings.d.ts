// Types for analysisFindings.js - one scope's answer on its way to the diagram.

import type { Finding, RiskAnalysisAnswer } from "../src/types";

/**
 * What one scope reported, by the scope name: "__plan__" for the plan as a whole, an attached
 * policy's identifier for a scoped run.
 *
 * NULL IS NOT []. Null is a scope that has not answered; [] is one that answered and fired nothing.
 */
export type FindingsByScope = Record<string, Finding[] | null>;

export function findingsOfAnswer(answer: RiskAnalysisAnswer | null): Finding[] | null;
export function everyFinding(byScope: FindingsByScope | undefined): Finding[];
export function anyAnswered(byScope: FindingsByScope | undefined): boolean;

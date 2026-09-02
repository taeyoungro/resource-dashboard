// Types for resourceFacts.js - what the relationship picture shows when a resource is clicked.

import type {
  Finding, FindingCategory, FindingStatus, Grade, ImpactAccessLevel, ImpactActionReference,
  ImpactPolicy,
} from "../src/types";

export const GRADE_ORDER: Record<string, number>;
export const LEVEL_ORDER: Record<string, number>;
export const LEVEL_LABEL: Record<string, string>;
export const REACH_LABEL: Record<string, string>;

/** How a finding reaches one resource. `elsewhere` means it demonstrably does NOT. */
export type Reach = "named" | "typed" | "elsewhere";

export interface ActionRow {
  name: string;
  /** null when the assessment's action reference does not carry this action. Never guessed. */
  level: ImpactAccessLevel | null;
  /** The action brings this type into being rather than acting on one that exists. */
  makes: boolean;
}

export interface FindingCard {
  id: string;
  title: string;
  category: FindingCategory;
  grade: Grade;
  status: FindingStatus;
  source: "rule" | "model";
  policyName: string;
  policyId: string;
  restrictable: boolean;
  reach: Exclude<Reach, "elsewhere">;
  reachLabel: string;
  actions: string[];
  requiredActions: string[];
}

export interface ResourceFacts {
  arn: string;
  id: string;
  resourceType: string;
  service: string;
  name: string;
  region: string;
  tags: Record<string, string>;
  sensitive: boolean;
  scope: "*" | "listed" | null;
  attribution: "resource_type" | "service" | null;
  truncated: boolean;
  groupTotal: number;
  actions: ActionRow[];
  levels: { level: string; label: string; count: number }[];
  findings: { named: FindingCard[]; typed: FindingCard[]; elsewhere: number };
  worstGrade: Grade | null;
}

export function reachOf(
  finding: Finding, arn: string, resourceType: string,
): { reach: Reach; target: Finding["targets"][number] } | null;

export function resourceFacts(
  policy: ImpactPolicy,
  reference: ImpactActionReference | null | undefined,
  findings: Finding[],
  arn: string,
): ResourceFacts | null;

export function gradesByResource(policy: ImpactPolicy, findings: Finding[]): Map<string, Grade>;

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
  /** A route table's routes: (destination, target, state). Empty for every other type. */
  routes: { destination: string; target: string; state: string }[];
  /**
   * What a security group allows - one entry per rule, and on a RULE row the one rule it is.
   * Empty for every other type.
   *
   * `target_kind` is 'cidr', 'prefix_list' or 'security_group', and the last is the chain: the
   * traffic is allowed with whatever carries THAT group, wherever it sits, which is a relation
   * between two resources rather than an address.
   */
  rules: {
    direction: "ingress" | "egress";
    protocol: string;
    from_port: number | null;
    to_port: number | null;
    target_kind: string;
    target: string;
  }[];
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

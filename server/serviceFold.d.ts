// Types for serviceFold.js - shared with src the same way inlinePreview.d.ts is.

import type { ImpactGroup, Restriction } from "../src/types";

/** Every action the assessment says reaches at least one of these ARNs. */
export declare function reaching(arns: string[], groups: ImpactGroup[]): Set<string>;

export interface ServiceFold {
  /** The one action the statement would carry instead, e.g. "athena:*". */
  wildcard: string;
  service: string;
  /** How many named actions it replaces. */
  covers: number;
  /**
   * What the wildcard additionally denies, from what the policy grants. Empty for a NotResource
   * fold by construction; for a Resource fold it is the rest of the service, all of it inert
   * against these ARNs. Shown either way - an administrator agreeing to a wildcard should see it.
   */
  adds: string[];
}

/**
 * Whether these actions can be written as one `<service>:*`, and what it would change.
 *
 * Null when they cannot. The two intents have different conditions and conflating them is how this
 * gets written as a widening: a Resource statement is bounded by its ARNs and needs only every
 * action that reaches them, a NotResource statement is bounded by nothing and needs the whole
 * service as the policy grants it.
 */
export declare function serviceFold(input: {
  actions: string[];
  resources: string[];
  intent: Restriction["intent"];
  groups: ImpactGroup[];
  granted: string[];
}): ServiceFold | null;

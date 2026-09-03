// Types for actionPattern.js - shared with src the same way inlinePreview.d.ts is.

import type { ImpactActionReference } from "../src/types";

/** IAM wildcard matching, where `*` is the only metacharacter. Never a RegExp: see the module. */
export declare function wildcardMatch(
  text: string, pattern: string, options?: { foldCase?: boolean },
): boolean;

/** The service prefix and the name after the colon. Both empty when the action has no colon. */
export declare function splitAction(action: string): { service: string; name: string };

/** The names in `names` this action covers - itself when concrete, every match when a wildcard. */
export declare function coveredNames(action: string, names: string[]): string[];

/**
 * Whether the action - concrete or wildcard - operates BELOW the resource an index can hold, so
 * the ARN picked for it is a container and the statement needs the pattern for what is inside it.
 */
export declare function reachesInside(
  reference: ImpactActionReference | null | undefined, action: string,
): boolean;

/**
 * The creation-exemption patterns the action's allow_only statement needs, ${Partition} and
 * ${Account} still in them. The union over what a wildcard covers, as the writer composes it.
 */
export declare function createdFormats(
  reference: ImpactActionReference | null | undefined, action: string,
): string[];

/** Which protected actions this action pattern would deny. Wildcard-aware, needs no reference. */
export declare function coversProtected(
  action: string, protectedActions: Iterable<string>,
): string[];

/** Where a wildcard allow_only statement's own exemption would keep the type it claims to scope. */
export declare function swallowedByExemption(
  reference: ImpactActionReference | null | undefined,
  action: string,
  picked: string[],
  substitute: (pattern: string, picked: string[]) => string | null,
): { action: string; pattern: string; resource: string } | null;

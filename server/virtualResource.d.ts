// Types for virtualResource.js - shared with src the same way inlinePreview.d.ts is.

import type { InlineDocument } from "./inlinePreview";

/** The verdict vocabulary. There is no ALLOW - see the module header for why. */
export declare const DENIED: "DENIED_BY";
export declare const NOT_DENIED: "NOT_DENIED";
export declare const UNKNOWN: "UNKNOWN";

export declare class VirtualResourceError extends Error {}

/** IAM wildcard matching, * the only metacharacter. foldCase for actions, never for ARNs. */
export declare function wildcardMatch(
  text: string,
  pattern: string,
  options: { foldCase: boolean },
): boolean;

/**
 * One resource that may exist tomorrow.
 *
 * `tags` DESCRIBES the resource, so an absent tag means untagged and the evaluator answers with it.
 * `requestContext` does not, so an absent key makes the verdict UNKNOWN rather than deciding it -
 * and since StringNotEquals is this platform's default, that is the common case.
 *
 * Throws VirtualResourceError for a non-ARN or for a pattern: matching against
 * arn:aws:lambda:*:*:function:* asks whether the document covers SOME resource of that shape,
 * which is a different question.
 */
export interface VirtualResource {
  arn: string;
  tags: Record<string, string>;
  requestContext: Record<string, string>;
}

export declare function virtualResource(described: {
  arn: string;
  tags?: Record<string, string>;
  requestContext?: Record<string, string>;
}): VirtualResource;

export interface Verdict {
  action: string;
  outcome: "DENIED_BY" | "NOT_DENIED" | "UNKNOWN";
  /** The statement that decided, when one did. For UNKNOWN, the first that could not be answered. */
  sid: string | null;
  /** Condition keys the request context did not supply. Only ever non-empty on UNKNOWN. */
  missingKeys: string[];
  /**
   * Every statement whose Action and resource clause matched, whatever its condition said. What
   * makes a NOT_DENIED readable: "nothing matched" and "something matched and did not fire" are
   * different answers and an approver has to tell them apart.
   */
  considered: string[];
}

/** What the document says about one action on one resource that may not exist yet. */
export declare function evaluate(
  document: InlineDocument,
  action: string,
  resource: VirtualResource,
): Verdict;

/** Every action against one resource, in the order asked. */
export declare function evaluateAll(
  document: InlineDocument,
  actions: string[],
  resource: VirtualResource,
): Verdict[];

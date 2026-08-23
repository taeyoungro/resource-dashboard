// Types for inlinePreview.js - shared with src the same way arn.d.ts is.

import type { Restriction } from "../src/types";

/** The permission set inline policy quota - the 10,240 one, not the 32,768 the API accepts. */
export declare const INLINE_LIMIT: number;

export interface InlineStatement {
  Sid: string;
  Effect: "Deny";
  Action: string | string[];
  Resource?: string | string[];
  NotResource?: string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface InlineDocument {
  Version: string;
  Statement: InlineStatement[];
}

/** The bytes the API sees and the quota counts: keys sorted, no whitespace. */
export declare function serialise(value: unknown): string;

/** The PassRole fence as the writer will compose it, with the placeholder as the whole allowlist. */
export declare function fenceStatements(services: string[], accountId: string): InlineStatement[];

/**
 * The whole inline document these restrictions become - across EVERY policy, because the permission
 * set has one document and they all spend one quota.
 */
/** The pattern naming everything under an ARN, with the separator read off the ARN itself. */
export declare function subResource(arn: string): string;

export declare function composeInline(
  restrictions: Restriction[],
  options: {
    accountId: string;
    fenceServices?: string[];
    /**
     * Whether an action operates BELOW the resource an index can hold, so the picked ARN is a
     * container and the statement needs what is inside it. Impact.tsx builds it from the
     * assessment's action_reference; omitted means no expansion.
     */
    nested?: (action: string) => boolean;
  },
): InlineDocument;

export declare function inlineBytes(document: InlineDocument): number;

/** Indented, keys in the order an IAM document is written. For a person, not for the quota. */
export declare function readable(document: InlineDocument): string;

/** Statements alone, no Version - an excerpt, shaped so it cannot be read as a whole document. */
export declare function readableStatements(statements: InlineStatement[]): string;

/** One statement of the shared document, and how much of it came from the policy being viewed. */
export interface PolicyStatement {
  statement: InlineStatement;
  /** The actions in it this policy put there. Never empty - a statement with none is not returned. */
  ours: string[];
  /** The actions in the same statement that arrived from another policy. Usually empty. */
  others: string[];
  /**
   * Every OTHER policy with a decision in this statement, by identity. Count THIS for a number of
   * policies - `others` counts actions, and one policy can contribute four of them.
   */
  alsoBy: string[];
  /**
   * The subset of `ours` that another policy ALSO decided. Removing this policy's decision leaves
   * these statements standing, which is the one thing an excerpt must not hide.
   */
  shared: string[];
}

export interface PolicyContribution {
  /** This policy's statements, with the Sids they will be WRITTEN under - gaps and all. */
  statements: PolicyStatement[];
  /** The fence statements this policy's own PassRole grant earns. In neither byte figure. */
  fence: InlineStatement[];
  /** The whole document, every policy. The quota is spent against this, not against `share`. */
  total: number;
  /** What the document would be without this policy's restrictions. */
  without: number;
  /** total - without. Marginal, so folding is accounted for; NOT the sum of the statements. */
  share: number;
}

/**
 * What ONE attached policy puts into the shared document, read back out of the composed whole
 * rather than composed on its own - so every Sid shown is a Sid that will be written.
 */
export declare function policyContribution(
  restrictions: Restriction[],
  policy: string,
  options: {
    accountId: string;
    fenceServices?: string[];
    nested?: (action: string) => boolean;
    /** The services THIS policy's PassRole grant names, for filtering the fence. */
    policyFenceServices?: string[];
  },
): PolicyContribution;

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
export declare function composeInline(
  restrictions: Restriction[],
  options: { accountId: string; fenceServices?: string[] },
): InlineDocument;

export declare function inlineBytes(document: InlineDocument): number;

/** Indented, keys in the order an IAM document is written. For a person, not for the quota. */
export declare function readable(document: InlineDocument): string;

// Types for blockPath.js - shared with src the same way inlinePreview.d.ts is.

import type { Finding, Restriction } from "../src/types";

/** One action a finding's block dialog offers. Protected ones are shown and unselectable. */
export interface BlockOffer {
  action: string;
  protected: boolean;
}

/**
 * The actions the dialog seeds from a finding: a model finding's containment.denyActions when the
 * verdict carries them, the triggerActions otherwise. Protected actions are offered and marked,
 * never silently dropped.
 */
export declare function blockOffer(finding: Finding, protectedActions?: string[]): BlockOffer[];

/**
 * The restriction set after 적용: additions merged, prior decisions on the same (policy, action)
 * replaced under any intent, everything else byte-identical.
 */
export declare function mergeBlock(
  existing: Restriction[],
  policy: string,
  additions: Restriction[],
): Restriction[];

/** The offered actions already restricted under the finding's policy, for the dialog and the card. */
export declare function alreadyRestricted(finding: Finding, restrictions: Restriction[]): string[];

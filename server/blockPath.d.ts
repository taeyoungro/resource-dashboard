// Types for blockPath.js - shared with src the same way inlinePreview.d.ts is.

import type { Finding, ImpactPassRoleGrant, Restriction } from "../src/types";

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

/**
 * How much of a path the decision being composed cuts.
 *
 * 'full' means the path cannot hold under what was drafted - either every offered action is denied
 * outright under deny_action (a Deny on Resource "*" with no Condition), or the actions the finding
 * cannot exist without are. 'fenced' means the same thing was done by the PassRole fence, which
 * nobody drafted and which is in the document before the screen opens. 'partial' means something
 * else was written: every other intent is conditional on ARNs that exist today, or on a tag or
 * request key whose value somebody may choose. A card holding a protected action is never 'full' -
 * the declaration path stays open by design.
 */
export declare function containmentState(
  finding: Finding,
  restrictions: Restriction[],
  protectedActions?: string[],
  passroleGrants?: ImpactPassRoleGrant[] | null,
): "full" | "fenced" | "partial" | "none";

/** The actions the inline document denies with no restriction drafted - iam:PassRole, when fenced. */
export declare function fencedActions(
  passroleGrants?: ImpactPassRoleGrant[] | null,
): Set<string>;

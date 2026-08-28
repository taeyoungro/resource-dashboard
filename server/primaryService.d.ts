// Types for primaryService.js - shared with src the same way serviceIcons.d.ts is.

export declare function primaryService(
  identifier: string,
  /** The policy's action patterns AS WRITTEN, so `ecr:*` is still distinguishable from `ecr:Get*`. */
  granted: readonly string[] | null | undefined,
  /** Every service the policy touches: its patterns, their expansion, and its resource groups. */
  candidates: readonly string[] | null | undefined,
): string | null;

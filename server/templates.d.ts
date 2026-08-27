// Types for templates.js - shared with src the same way blockPath.d.ts is.

import type { Impact, Restriction, RestrictionTemplate } from "../src/types";

export declare class TemplateError extends Error {}

/** Refuse a template by name, or return it. Only the three intents that name no ARNs. */
export declare function validateTemplate(
  template: unknown,
  at?: string,
): RestrictionTemplate;

export declare function loadTemplates(document: unknown): RestrictionTemplate[];

/** Why a template row could not be applied to THIS plan. Reported, never removed in silence. */
export interface DroppedTemplateAction {
  action: string;
  why: "protected" | "not_granted" | "no_resource_tag";
}

/**
 * Turn a template into restrictions for this plan, binding each action to the policies that
 * actually grant it - and say what did not survive.
 */
export declare function seedFromTemplate(
  template: RestrictionTemplate,
  assessment: Impact,
): { restrictions: Restriction[]; dropped: DroppedTemplateAction[] };

/** Merge seeded rows in, replacing any earlier decision on the same (policy, action). */
export declare function mergeTemplate(
  existing: Restriction[],
  seeded: Restriction[],
): Restriction[];

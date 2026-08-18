// Types for provenance.js. The kind is a union rather than a string so the renderer must have a
// word for every value - a label the page has no wording for should be a type error, not a blank.

export type ProvenanceKind = "stack" | "stackset" | "manual";

export interface Provenance {
  kind: ProvenanceKind;
  /** The stack's name, or the stack SET's name. Null for 'manual'. */
  name: string | null;
}

export declare function provenance(tags: Record<string, string> | null | undefined): Provenance;
export declare const PROVENANCE_TAGS: string[];
export declare function remainingTags(
  tags: Record<string, string> | null | undefined,
): Record<string, string>;

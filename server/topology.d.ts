// Types for topology.js and its three specs, so the page can import a plain-JS module the test
// runner can load. Same arrangement as blockPath.d.ts, and for the same reason.

import type { ImpactCoverage, ImpactPolicy, ImpactResource } from "../src/types";

export const SCENE_W: number;
export const SKY: number;
export const FRAME_PAD: number;
export const FRAME_HEAD: number;
export const RAIL_GAP: number;
export const SLOT_W: number;
export const SLOT_H: number;
export const SLOT_GAP: number;
export const ICON: number;
export const BADGE: number;
export const COLUMN_W: number;
export const FOOT_LINE: number;
export const FOOT_PAD: number;
export const LABEL_BUDGET: number;
export const FOOT_BUDGET: number;
export const COVERAGE_FLOOR: number;

export type TopologyKind = "ec2" | "lambda" | "ecs";

/** Policy name -> which picture it gets. */
export const DIAGRAMMED_POLICIES: Map<string, TopologyKind>;
/** Every picture this module can draw. */
export const TOPOLOGIES: Record<TopologyKind, TopologySpec>;
export const DIMENSION_LABEL: Record<string, string>;

/**
 * One picture: what it contains, what it calls things, and what it may be narrowed by.
 *
 * The engine holds no service name and no Korean noun; a spec holds no geometry and no layout.
 * That split is what lets three pictures share one set of containment invariants.
 */
export interface TopologySpec {
  kind: TopologyKind;
  /** Room above the root frame. EC2 leaves 72 for the internet glyph; the others leave a margin. */
  sky: number;
  /** The services this picture is ABOUT. Everything else in `affected` is counted as omitted. */
  services: Set<string>;
  frames: FrameSpec[];
  frameLabel: Record<string, string>;
  rails: Record<string, {
    frame: string;
    straddle?: true;
    /** The far end of a straddling rail's arrow. Only EC2 has one. */
    link?: { glyph: string; label: string; from: number };
  }>;
  slots: Record<string, SlotSpec>;
  noSlot: Record<string, string>;
  /** The types the querier can answer placement for, mirroring inventory.py. */
  placeable: Set<string>;
  /** Whether one resource of a placeable type can name several subnets. */
  multiSubnet: boolean;
  /** The filter dimensions this picture offers, in bar order. */
  dimensions: string[];
  words: {
    /** The service, as a sentence names it: EC2, 람다, ECS. */
    subject: string;
    title: string;
    home: string;
    summaryHome: string;
    /** Drawn INSIDE the viewBox, so it travels with a cropped screenshot. */
    caption: string;
    /** One sentence saying what this picture leaves to another one. */
    omitted: string;
  };
  /** Notes on this picture's own frames. The engine supplies the account and the region band. */
  noteFor?: (
    id: string,
    ctx: { accountId: string; narrowed: boolean; enumerated: boolean; placed: number;
           regionList: string[] },
  ) => string | null;
  /** Dimensions this picture will never offer, each with the reason. */
  unavailable: { id: string; label: string; why: string }[];
}

export interface FrameSpec {
  id: string;
  parent: string | null;
  arrange: "stack" | "row";
  rail: string | null;
  /** The resource_type this frame IS, when it is one. Its count lands on the label band. */
  type: string | null;
  /** Drawn whatever the assessment holds. The cloud and the region, in every picture. */
  always?: true;
  /** A position rather than a measurement: drawn iff a child is, never carries a count, faded. */
  ghost?: true;
  /** A fixed inner width - one column of slots - inside a `row` parent. The rest share what is
   *  left. Amazon EBS is the only frame that wants it today. */
  span?: "column";
  /** The band count is what the QUERIER measured into this frame, and the frame is drawn only when
   *  that is greater than zero. An empty VPC box would say every function is VPC-attached. */
  measure?: "placed";
  /** Whether this frame's note is the region list, which elides and gets a hover title. */
  longNote?: true;
  /** An AWS group-badge fill, or null for the frames whose colour this module does not assert. */
  stroke: string | null;
  width: number;
  dashed: boolean;
  badge: string | null;
}

export interface SlotSpec {
  kind: "frame" | "node";
  frame?: string;
  rail?: string;
  label?: string[];
  /** A Res_*_48 file name, or null when the deck has no glyph for this type. Never a service icon. */
  icon?: string | null;
}

/** One resource_type, as the picture and the table beside it both render it. */
export interface SceneRow {
  resourceType: string;
  label: string[];
  total: number;
  truncated: boolean;
  scope: "*" | "listed";
  attribution: "resource_type" | "service" | null;
  sensitive: number;
  icon: string | null;
  /** null for a type with no slot - it is listed, never drawn. */
  rail: string | null;
  frame: string | null;
  countLabel: string;
}

export interface Frame {
  id: string;
  x: number; y: number; w: number; h: number;
  stroke: string | null;
  width: number;
  dashed: boolean;
  badge: string | null;
  label: string;
  count: string | null;
  note: string | null;
  /** Drawn to hold a position rather than to report a measurement. The availability zone, always.
   *  The renderer fades it, so the frame that carries no count also does not read as one that does. */
  ghost: boolean;
  /** How many of this frame's own resources the assessment marked sensitive. A COUNT and not a
   *  flag: it is rendered on the label band, because the frame BORDER cannot carry it - the 보안
   *  그룹 border is AWS's convention colour and is red whatever is inside it. */
  sensitive: number;
  title: string | null;
}

export interface Slot {
  key: string;
  resourceType: string;
  x: number; y: number; w: number; h: number;
  icon: string | null;
  label: string[];
  count: string;
  sensitive: boolean;
  /** Paint the page's own ground behind this box first: it straddles a frame border. */
  erase: boolean;
  title: string;
}

export interface Link {
  cx: number;
  glyph: string;
  label: string;
  from: number;
  to: number;
}

export interface Scene {
  kind: TopologyKind;
  width: number;
  height: number;
  frames: Frame[];
  slots: Slot[];
  link: Link | null;
  foot: { text: string; y: number }[];
  /** Every EC2 group, biggest first - the table that makes the picture falsifiable. */
  rows: SceneRow[];
  unslotted: SceneRow[];
  omitted: { service: string; total: number }[];
  regions: string[];
  truncated: boolean;
  measured: number;
  kinds: number;
  empty: boolean;
  /** Whether a filter narrowed this scene. An empty picture caused by a filter is not the same
   *  news as a policy that reaches nothing. */
  narrowed: boolean;
  /** Whether the assessment enumerated this picture's services at all. False makes an empty
   *  picture a statement about the lookup rather than about the policy. */
  enumerated: boolean;
  /** Rows the querier measured into a VPC. 0 for EC2, which records no `placement`. */
  placed: number;
  /**
   * Rows of a placeable type the lookup did NOT place, by reason. Keys are Resource.placement's
   * own values plus 'unanswered' for an absent one: 'subnet-unknown' | 'no-cluster' |
   * 'over-budget' | 'failed' | 'unanswered'. Broken out rather than summed, because "denied",
   * "budgeted out" and "AWS says no VPC" are three different things and the screen says a
   * different sentence for each. ('none' never lands here - it is an answer.)
   */
  unmeasured: Record<string, number>;
}

/** What the picture can be narrowed by. null on a policy that gets no picture. */
export interface Facets {
  accounts: { id: string; total: number }[];
  regions: { id: string; total: number }[];
  vpcs: { id: string; total: number }[];
  subnets: { id: string; total: number }[];
  /** VPC-scoped rows the querier recorded no VPC for - an optional permission it did not have, or
   *  an assessment written before the field existed. A VPC filter cannot speak for these. */
  unplaced: number;
  /** How many rows a VPC filter could speak for at all. unplaced is a share of this, not of the
   *  whole picture: a volume has no VPC by definition and is in neither number. */
  placeable: number;
  /** ECS only: the clusters the querier read off the service ARNs it described. */
  clusters: { id: string; total: number }[];
  /** Per dimension, how much of the picture it can speak for. Below COVERAGE_FLOOR the dimension
   *  is not offered at all - it moves to `unavailable` with the fraction in the reason. */
  coverage: Record<string, { known: number; applicable: number }>;
  /** Dimensions this assessment cannot serve, each with the reason: the spec's own static entries
   *  plus any dimension whose lookup answered for too little of the picture. */
  unavailable: { id: string; label: string; why: string }[];
  /** Which dimensions this picture offers at all. Carried here rather than read off the spec beside
   *  it: the bar sits over the relationship picture too, and that picture has no spec. */
  dimensions: string[];
  /** Whether one resource can name several subnets, so the chips can sum to more than the row
   *  count. True without a spec - for an arbitrary policy some type in it can. */
  multiSubnet: boolean;
}

/** null or an empty list on a dimension means 전체. */
export interface SceneFilter {
  /**
   * Resource types to HIDE, which is the opposite grammar from every dimension below it.
   *
   * The others narrow to what is listed; this removes what is listed. An account or a VPC is a
   * place and the question a reader has about one is "show me that one"; a resource type is a
   * LAYER, and forty network interfaces drawn over the instances they belong to is a picture whose
   * question is "take that away". So every type starts on and unticking removes it.
   *
   * Empty still means 전체 - nothing hidden - which is the same reading as the rest.
   */
  hiddenTypes?: string[] | null;
  accounts?: string[] | null;
  regions?: string[] | null;
  vpcs?: string[] | null;
  subnets?: string[] | null;
  clusters?: string[] | null;
}

/** Never null now: the filter bar is over the relationship picture too, and that is every policy. */
export function facets(policy: ImpactPolicy): Facets;
export function filterActive(filter: SceneFilter | null): boolean;
export function keeps(filter: SceneFilter | null, resource: ImpactResource): boolean;
export function topologyPolicy(identifier: string): TopologyKind | null;
export function specOf(policy: ImpactPolicy | null | undefined): TopologySpec | null;
export function textUnits(line: string): number;
export function captionFor(home: string): string;
export function enumeratedFor(
  policy: ImpactPolicy | null | undefined,
  coverage: ImpactCoverage | null | undefined,
): boolean;
export function scene(
  policy: ImpactPolicy,
  accountId: string,
  filter?: SceneFilter | null,
  enumerated?: boolean,
): Scene | null;
export function sceneSummary(scene: Scene | null): string;

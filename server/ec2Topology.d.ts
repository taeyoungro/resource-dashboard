// Types for ec2Topology.js, so the page can import a plain-JS module the test runner can load.
// Same arrangement as blockPath.d.ts, and for the same reason.

import type { ImpactPolicy } from "../src/types";

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
export const EBS_W: number;
export const FOOT_LINE: number;
export const FOOT_PAD: number;
export const LABEL_BUDGET: number;
export const CAPTION: string;

export const DIAGRAMMED_POLICIES: Set<string>;
export const EC2_FRAMES: FrameSpec[];
export const EC2_RAILS: Record<string, { frame: string; straddle?: true }>;
export const EC2_SLOTS: Record<string, SlotSpec>;
export const FRAME_LABEL: Record<string, string>;
export const NO_SLOT: Record<string, string>;

export interface FrameSpec {
  id: string;
  parent: string | null;
  arrange: "stack" | "row";
  rail: string | null;
  /** The resource_type this frame IS, when it is one. Its count lands on the label band. */
  type: string | null;
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
  /** Drawn to hold a position rather than to report a measurement. The availability zone, always. */
  ghost: boolean;
  sensitive: boolean;
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
  /** Dimensions this assessment cannot serve, each with the reason. Empty now that the querier
   *  records placement; kept so a future dimension has somewhere honest to go. */
  unavailable: { id: string; label: string; why: string }[];
}

/** null or an empty list on a dimension means 전체. */
export interface SceneFilter {
  accounts?: string[] | null;
  regions?: string[] | null;
  vpcs?: string[] | null;
  subnets?: string[] | null;
}

export const VPC_SCOPED: Set<string>;
export function facets(policy: ImpactPolicy): Facets | null;
export function filterActive(filter: SceneFilter | null): boolean;
export function topologyPolicy(identifier: string): "ec2" | null;
export function textUnits(line: string): number;
export function ec2Scene(
  policy: ImpactPolicy,
  accountId: string,
  filter?: SceneFilter | null,
): Scene | null;
export function sceneSummary(scene: Scene | null): string;

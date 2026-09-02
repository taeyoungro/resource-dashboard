// Types for graph.js - the relationship picture - so the page can import a plain-JS module the
// test runner can load. Same arrangement as topology.d.ts.

import type { ImpactPolicy } from "../src/types";
import type { SceneFilter } from "./topology.js";

export const GRAPH_W: number;
export const NODE_W: number;
export const NODE_H: number;
export const NODE_GAP: number;
export const PAD: number;
export const HEAD: number;
export const ROW_GAP: number;
export const G_ICON: number;
export const G_FOOT_LINE: number;
export const G_FOOT_PAD: number;
export const NODE_BUDGET: number;
export const EDGE_BUDGET: number;
export const CARDS_PER_SUBNET: number;
export const GRAPH_CAPTION: string;

export type EdgeKind = "interface" | "volume" | "security" | "association" | "route" | "image";

export const RELATIONS: Record<string, { kind: EdgeKind; label: string; reverse?: true;
                                          implicit?: true; vpcFlag?: true }>;
export const KIND_LABEL: Record<EdgeKind, string>;

/** A measured box: the cloud, the region, a VPC, a zone, a subnet. */
export interface GraphContainer {
  id: string;
  kind: "cloud" | "region" | "vpc" | "az" | "subnet";
  label: string;
  note: string | null;
  x: number; y: number; w: number; h: number;
  /** An AWS group-badge fill, inline-styled by the renderer; null takes the stylesheet's border. */
  stroke: string | null;
  /** Dashed means the container's OWN row is not in the assessment (resources say they are in it)
   *  or its zone could not be read. Everything else here was measured and is solid. */
  dashed: boolean;
  badge: string | null;
  measured: boolean;
  title?: string | null;
  /** A subnet's colour: public when the route table it is associated with - its explicit one,
   *  else the VPC's main table - has a route to an internet gateway; private when it has none;
   *  null when the assessment holds no table for it. */
  tint?: "public" | "private" | null;
  /** The route table this subnet is associated with - its explicit one, else the VPC's main
   *  table - printed on the label band so the association survives a crowded picture. */
  routeTable?: string | null;
  /** How the tint was decided.
   *  'subnet' - the subnet's own row named its table and that table's default routes. The answer
   *             the querier now records, and the only one that does not depend on the policy
   *             also reaching route tables.
   *  'routes' - read off a route table's own row, which the policy happened to reach.
   *  'links'  - the older approximation ("the table has some internet-gateway route") on an
   *             assessment made before the routes were recorded. It over-reports public. */
  tintBasis?: "subnet" | "routes" | "links" | null;
}

/** One resource. */
export interface GraphNode {
  id: string;
  resourceType: string;
  typeLabel: string;
  icon: string | null;
  /** The Name tag when there is one, else the short id. */
  label: string;
  /** The short id under a Name, else the type - or the zone, in the region band. */
  sub: string;
  x: number; y: number; w: number; h: number;
  sensitive: boolean;
  arn: string;
  title: string;
  /** Paint the ground behind this node first: it straddles a VPC border (an internet gateway). */
  erase: boolean;
  /** A box rather than a plate: an instance, drawn as a frame with its interfaces inside it. Its
   *  w and h are the frame's; the interfaces are nodes of their own, placed inside. */
  box: boolean;
  /** How many interfaces the box holds, drawn inside it or folded into it. */
  holds: number;
  /** Whether the box is open, with its interfaces drawn inside. Closed boxes fold them. */
  open: boolean;
  /** One sentence inside a closed or empty box: how many interfaces it folds and that a click
   *  opens it, or that the interfaces are not in this assessment. */
  note: string | null;
}

/** A plate standing for what the budget left out of one container. */
export interface GraphOverflow {
  container: string;
  count: number;
  x: number; y: number; w: number; h: number;
  label: string;
}

export interface GraphEdge {
  kind: EdgeKind;
  /** Node ids, or a container id (`subnet:subnet-…`) for an association. */
  from: string;
  to: string;
  relation: string;
  /** Derived rather than recorded: the main route table's association with a subnet that has no
   *  explicit one. Drawn dashed. */
  implicit: boolean;
  /** The line, first point on `from`'s border and last on `to`'s: two points for a straight
   *  line, four for one routed over the top of a row. */
  points: { x: number; y: number }[];
  /** The two ends, for convenience: points[0] and points[points.length - 1]. */
  x1: number; y1: number; x2: number; y2: number;
  /** The hover text: the kind, then both ends by their full title. */
  title: string;
}

export interface GraphRow {
  id: string;
  resourceType: string;
  typeLabel: string;
  name: string;
  /** The subnet, else the VPC, else the zone, else '' - or `<instance> 안` for a folded interface. */
  where: string;
  degree: number;
  sensitive: boolean;
  /** An interface inside a closed instance box: counted and listed, not drawn. */
  folded: boolean;
}

export interface RelationScene {
  width: number;
  height: number;
  containers: GraphContainer[];
  nodes: GraphNode[];
  overflow: GraphOverflow[];
  edges: GraphEdge[];
  foot: { text: string; y: number }[];
  rows: GraphRow[];
  omitted: { service: string; total: number }[];
  regions: string[];
  counts: {
    nodes: number;
    edges: number;
    implicitEdges: number;
    omittedNodes: number;
    droppedEdges: Record<string, number>;
    /** The sum of droppedEdges. */
    droppedEdgeTotal: number;
    /** Relation -> links whose target is in no row of this assessment. */
    dangling: Record<string, number>;
    linkedRows: number;
    placedRows: number;
    totalRows: number;
    /** Rows drawn as a border rather than a plate - the VPC and subnet rows. */
    containerRows: number;
    /** Interfaces folded into a closed instance box. */
    foldedRows: number;
  };
  kinds: number;
  measured: number;
  empty: boolean;
  narrowed: boolean;
  enumerated: boolean;
  /** Whether the assessment carries a placement or a link at all. False on a document written
   *  before the querier recorded either - the type picture says more about that one. */
  informative: boolean;
}

export function idOf(arn: string): string;
export function shortId(id: string): string;
export function shortName(name: string): string;
export function relationScene(
  policy: ImpactPolicy,
  accountId: string,
  filter?: SceneFilter | null,
  enumerated?: boolean,
  options?: { expanded?: Iterable<string> },
): RelationScene | null;
export function graphSummary(scene: RelationScene | null): string;

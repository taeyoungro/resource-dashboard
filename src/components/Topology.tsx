// "구성도 보기" - the impact assessment as a picture instead of a list. Three pictures now: EC2,
// 람다, ECS. Which one a policy gets, and what is in it, is server/topology.js and its specs.
//
// A list of thirty resource types with counts beside them is a true answer nobody reads, and that
// is the complaint this exists to answer. The difficulty of a picture is that it says more than a
// list does: putting an instance inside a security group inside a subnet inside a VPC claims four
// things, and this assessment measured none of them. So every sentence in here is arranged around
// keeping the picture honest about what it is - see the two caveat paragraphs, the legend's
// solid/dashed grammar, and the caption drawn inside the viewBox so it survives a screenshot.
//
// THIS FILE COMPUTES NOTHING, and it holds no service noun either. Every coordinate, every count,
// every label comes out of server/topology.js, which is plain JS with unit tests behind it; every
// Korean noun that names a service comes out of the spec, as `spec.words`. What is here is a few
// .maps and some conditionals. That split is deliberate: geometry that decides whether a slot
// escapes its frame - a picture that lies about containment while every sentence above it says the
// opposite - is exactly the thing a source-text test cannot catch and a unit test can.
//
// THE LEGEND IS CONDITIONAL, for the same reason. A legend line about the one arrow, or about the
// Amazon EBS border, is a sentence about a thing that is not in the ECS picture, and a legend that
// explains marks the reader cannot see teaches them to skim it.
//
// It also never renders ServiceIcon. resourceIconPath('ec2', …) never returns null: it falls
// through to the service icon, so a type with no glyph of its own would draw the Amazon-EC2 tile.
// In the panel's list that is decoration; here an EC2 tile inside the 보안 그룹 frame is a
// placement claim about key pairs.
//
// THE EC2 WINDOW HAS TWO VIEWS. The type picture above is one; the other is the relationship
// picture out of server/graph.js - one plate per resource, one line per connection the querier
// read off the resource itself (an instance's interfaces, groups, volumes and image; a route
// table's and a network ACL's subnets; a route's gateway), inside the VPC, zone and subnet the
// resource said it was in. The type picture stays because it is the honest answer for an
// assessment written before the querier recorded any of that, and because a reader who wants the
// counts by type is not served by four hundred plates. The two views share the filter bar, the
// notes and the table's grammar; what differs is the caveats and the legend, because what each
// picture measured differs.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ImpactCoverage, ImpactPolicy, SecurityGroupRule } from "../types";
import type {
  Facets, Frame, Link, Scene, SceneFilter, Slot, TopologySpec,
} from "../../server/topology.js";
import {
  enumeratedFor, facets as facetsOf, scene as sceneOf, sceneSummary, specOf,
} from "../../server/topology.js";
import type {
  EdgeKind, GraphContainer, GraphEdge, GraphNode, GraphOverflow, GraphType, RelationScene,
} from "../../server/graph.js";
import { G_ICON, KIND_LABEL, graphSummary, relationScene, ruleText }
  from "../../server/graph.js";
import type { FindingCard, ResourceFacts } from "../../server/resourceFacts.js";
import { LEVEL_LABEL, gradesByResource, resourceFacts } from "../../server/resourceFacts.js";
import { CATEGORY_LABEL, GRADE_CLASS, GRADE_LABEL, STATUS_LABEL } from "../grades";
import { actionDocUrl } from "../../server/actionDocs.js";
// The finding's own card, from the page that owns it. Imported rather than reimplemented - see the
// comment on RiskFindingCard. No cycle: RiskAnalysis.tsx reaches neither this file nor Impact.tsx.
import { RiskFindingCard } from "./RiskAnalysis";
import type { ContainmentState } from "./RiskAnalysis";
import type { Finding, ImpactActionReference, ImpactResource } from "../types";

/**
 * One frame: the box, its badge, and a label band of up to three parts.
 *
 * The class carries the frame id, so a frame added to any spec gets `.topo-frame-<id>` with no
 * edit here and no edit in the stylesheet unless it wants one.
 */
function FrameShape({ frame }: { frame: Frame }) {
  return (
    // The id class goes on the GROUP, not on the rect. A rule for one frame's label -
    // `.topo-frame-sg .topo-frame-label` - has to reach a <tspan> in a sibling <text>, and from
    // the rect it reaches nothing: the 보안 그룹 label rendered in the ordinary text colour while
    // its border was red, which is the one frame whose colour carries a meaning.
    <g className={frame.ghost ? `topo-frame-${frame.id} topo-ghost` : `topo-frame-${frame.id}`}>
      {/* The AWS group colour arrives as an inline STYLE and not as a stroke attribute. A
          presentation attribute loses to any stylesheet rule, and `.topo-frame` sets
          `stroke: var(--border)` for the frames whose colour this module does not assert - so a
          stroke attribute here rendered every frame in the same grey and the picture lost the one
          thing that tells a VPC from an availability zone at a glance. */}
      <rect
        className="topo-frame"
        x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx={4}
        style={frame.stroke ? { stroke: frame.stroke } : undefined}
        strokeWidth={frame.width}
        strokeDasharray={frame.dashed ? "6 4" : undefined}
      >
        {frame.title && <title>{frame.title}</title>}
      </rect>
      {frame.badge && (
        <image href={`/aws-icons/${frame.badge}`} x={frame.x + 8} y={frame.y + 6}
               width={20} height={20} />
      )}
      <text className="topo-frame-text" x={frame.x + (frame.badge ? 34 : 10)} y={frame.y + 20}>
        <tspan className="topo-frame-label">{frame.label}</tspan>
        {frame.count && <tspan className="topo-frame-count" dx="6">{frame.count}</tspan>}
        {/* On the label band, not on the border. The 보안 그룹 border is AWS's own colour for a
            security group and is red whether or not anything inside it is sensitive, so a border
            cannot be the channel - and before this the frames carried the sensitive thread on no
            channel at all while the legend promised one. */}
        {frame.sensitive > 0 && (
          <tspan className="topo-frame-sensitive" dx="6">민감 {frame.sensitive}개</tspan>
        )}
        {frame.note && <tspan className="topo-frame-note" dx="6">{frame.note}</tspan>}
      </text>
    </g>
  );
}

/**
 * One resource type: a plate, a glyph, the Korean name, the count.
 *
 * The plate is drawn BEFORE the icon, so an <image> whose href 404s - which renders nothing,
 * silently, with no broken-image glyph - and a slot the deck has no glyph for produce the same
 * visual state: the plate, the label, the count. The never-guess contract, rendered rather than
 * described.
 *
 * The count's baseline is fixed whether the label runs to one line or two, so counts line up
 * across a rail and the eye can compare them without reading.
 */
function SlotShape({ slot }: { slot: Slot }) {
  return (
    <g>
      {slot.erase && (
        <rect className="topo-erase" x={slot.x} y={slot.y} width={slot.w} height={slot.h} />
      )}
      <rect
        className={slot.sensitive ? "topo-slot topo-slot-sensitive" : "topo-slot"}
        x={slot.x} y={slot.y} width={slot.w} height={slot.h} rx={4}
      >
        <title>{slot.title}</title>
      </rect>
      {slot.icon && (
        <image href={`/aws-icons/${slot.icon}`} x={slot.x + 36} y={slot.y + 8}
               width={48} height={48} />
      )}
      {slot.label[0] && (
        <text className="topo-slot-label" x={slot.x + 60} y={slot.y + 70} textAnchor="middle">
          {slot.label[0]}
        </text>
      )}
      {slot.label[1] && (
        <text className="topo-slot-label" x={slot.x + 60} y={slot.y + 82} textAnchor="middle">
          {slot.label[1]}
        </text>
      )}
      <text
        className={slot.sensitive ? "topo-slot-count sensitive" : "topo-slot-count"}
        x={slot.x + 60} y={slot.y + 96} textAnchor="middle"
      >
        {slot.count}
      </text>
    </g>
  );
}

/**
 * The one arrow in the picture, and the whole arrow budget.
 *
 * Arrowheads at both ends because traffic crosses an internet gateway in both directions, and that
 * is definitional rather than measured. The reference architecture's security-group-to-instance
 * edge is dropped (a measured-looking edge this assessment cannot measure) and its
 * security-group-to-volume edge is dropped for a harder reason: security groups do not attach to
 * EBS volumes, so drawing it would be inventing an AWS fact.
 *
 * Marker ids come from useId(). Two policy blocks with a literal id="topo-arrow" would both
 * resolve to whichever marker the document happened to define first.
 */
function LinkShape({ link, uid }: { link: Link; uid: string }) {
  return (
    <g>
      {/* refX is the TIP, not the centre. Centred, half of the lower arrowhead sat past the path's
          end - which is exactly where the gateway plate's erase rect starts - so the head that
          points at the VPC border was painted over by the thing it points at, on every scene that
          draws the gateway. With the tip on the vertex the whole head stays on the visible side. */}
      <defs>
        <marker id={`${uid}-up`} viewBox="0 0 8 8" refX="8" refY="4"
                markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path className="topo-link-marker" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
        <marker id={`${uid}-down`} viewBox="0 0 8 8" refX="8" refY="4"
                markerWidth="5" markerHeight="5" orient="auto">
          <path className="topo-link-marker" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
      </defs>
      <image href={`/aws-icons/${link.glyph}`} x={link.cx - 16} y={8} width={32} height={32} />
      <text className="topo-link-label" x={link.cx} y={56} textAnchor="middle">{link.label}</text>
      <path
        className="topo-link"
        d={`M ${link.cx} ${link.from} L ${link.cx} ${link.to}`}
        markerStart={`url(#${uid}-up)`}
        markerEnd={`url(#${uid}-down)`}
      />
    </g>
  );
}

/**
 * The picture itself.
 *
 * role="img" collapses the subtree, so the <text> inside is not read out twice and the <image>
 * elements need no aria-hidden of their own; what a screen reader gets is the <title> and the
 * <desc>, and the <desc> is sceneSummary(), which has its own unit test.
 */
function Figure({ scene, name, title, uid }:
                { scene: Scene; name: string; title: string; uid: string }) {
  return (
    <svg
      className="topology-svg"
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      width={scene.width}
      height={scene.height}
      preserveAspectRatio="xMinYMin meet"
      fontFamily="inherit"
      role="img"
      aria-labelledby={`${uid}-t ${uid}-d`}
    >
      <title id={`${uid}-t`}>{`${name}이 닿는 ${title} 자원 구성도`}</title>
      <desc id={`${uid}-d`}>{sceneSummary(scene)}</desc>
      <rect className="topo-ground" x={0} y={0} width={scene.width} height={scene.height} />
      {scene.frames.map((f) => <FrameShape key={f.id} frame={f} />)}
      {scene.link && <LinkShape link={scene.link} uid={uid} />}
      {scene.slots.map((s) => <SlotShape key={s.key} slot={s} />)}
      {scene.foot.map((line) => (
        <text className="topo-foot" key={line.text} x={8} y={line.y}>{line.text}</text>
      ))}
    </svg>
  );
}

/**
 * The table under the picture, and the picture's equal rather than its footnote.
 *
 * It is what makes the diagram falsifiable: every number in the drawing has a row here, and a type
 * the drawing has no place for has a row here too. A reader who distrusts the picture can check it
 * without leaving the window, and a reader using a screen reader gets the whole answer from it.
 */
function SceneTable({ scene, spec }: { scene: Scene; spec: TopologySpec }) {
  // The frame names come from the SPEC rather than from a copy here. The copy was byte-identical
  // until somebody added a frame, at which point the 자리 column printed the raw id while the
  // drawing beside it printed the Korean name - and this file's own banner says it computes
  // nothing, which a second table of labels quietly made untrue. With three pictures it would have
  // been three copies.
  const place = (row: Scene["rows"][number]) => {
    if (!row.frame) return <td className="none">없음</td>;
    return <td>{spec.frameLabel[row.frame] ?? row.frame}</td>;
  };
  return (
    <table className="topology-table">
      <thead>
        <tr><th>유형</th><th>자리</th><th>개수</th><th>범위</th><th>민감</th></tr>
      </thead>
      <tbody>
        {scene.rows.map((row) => (
          <tr key={row.resourceType}>
            <td><code>{row.resourceType}</code></td>
            {place(row)}
            <td>{row.countLabel}</td>
            <td>{row.scope}</td>
            <td className={row.sensitive > 0 ? "sensitive" : "none"}>
              {row.sensitive > 0 ? `${row.sensitive}개` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---- the relationship picture ----------------------------------------------------------------
 * The same division of labour as above: server/graph.js decides every coordinate, every label and
 * every line, and what follows draws what it was handed. */

/**
 * One container's border: the cloud, the region, a VPC, a zone, a subnet.
 *
 * Dashed for exactly one reason, and the engine states it (GraphContainer.dashed). The AWS group
 * colour arrives as an inline style for the reason FrameShape gives: a stroke attribute loses to
 * the stylesheet. The label is a separate component because it is painted on a different layer -
 * see GraphFigure.
 */
function GraphContainerShape({ box }: { box: GraphContainer }) {
  const cls = `graph-box graph-box-${box.kind}${box.dashed ? " graph-box-dashed" : ""}`
    + (box.tint ? ` graph-box-${box.tint}` : "");
  return (
    <g className={cls}>
      <rect
        className="graph-box-rect"
        x={box.x} y={box.y} width={box.w} height={box.h} rx={4}
        style={box.stroke ? { stroke: box.stroke } : undefined}
        strokeDasharray={box.dashed ? "6 4" : undefined}
      >
        {box.title && <title>{box.title}</title>}
      </rect>
    </g>
  );
}

/**
 * One container's label band, painted OVER the lines with a halo in the ground colour, so a line
 * that crosses a label passes under the letters and the label stays readable.
 */
function GraphContainerLabel({ box }: { box: GraphContainer }) {
  const cls = `graph-box graph-box-${box.kind}${box.dashed ? " graph-box-dashed" : ""}`;
  return (
    <g className={cls}>
      {box.badge && (
        <image href={`/aws-icons/${box.badge}`} x={box.x + 8} y={box.y + 5} width={18} height={18} />
      )}
      <text className="graph-box-text" x={box.x + (box.badge ? 30 : 10)} y={box.y + 18}>
        <tspan className="graph-box-label">{box.label}</tspan>
        {box.note && <tspan className="graph-box-note" dx="6">{box.note}</tspan>}
      </text>
    </g>
  );
}

/**
 * One resource: a plate, the glyph, the Name tag or the short id, and the other one under it.
 *
 * The plate is drawn before the icon for SlotShape's reason - a glyph that fails to load and a
 * type that has none leave the same plate. A type with no glyph prints its Korean name where the
 * glyph would be, so a plate is never a bare id.
 */
function GraphNodeShape({ node, onToggle, onSelect, onRules, selected, mark }: {
  node: GraphNode;
  onToggle: (id: string) => void;
  onSelect: (arn: string) => void;
  /** Open the rules table over the picture, for a security group that has one. */
  onRules: (arn: string) => void;
  selected: boolean;
  /** The worst grade of a finding that NAMES this resource, or null. Drawn as a corner mark so an
   *  approver does not have to click thirty plates to find the one a rule fired on. */
  mark: string | null;
}) {
  // TWO ACTS, and a plate answers a different question for each.
  //
  //   one click    THIS resource. What the policy lets somebody do to it and what the two
  //                analyses found about it, in the panel beside the picture. Nothing moves.
  //   double click WHAT IT HOLDS. An instance box opens to show its interfaces; a security group
  //                opens the table of its rules. Both change the screen, and both are a second
  //                question that follows the first rather than arriving with it.
  //
  // They were one act before, and the cost was that a reader could not ask the first question
  // alone: clicking a group to see its actions put a modal over the picture, and clicking an
  // instance to see its findings pushed the plates beside it aside. A double click is the ordinary
  // way to say "and open it", and the first of its two clicks has already opened the panel - so
  // the two acts compose rather than compete.
  const type = node.resourceType.replace(":", "-");
  const holdsSomething = (node.box && node.holds > 0) || node.ruleCount > 0;
  const open = () => {
    if (node.box && node.holds > 0) onToggle(node.id);
    if (node.ruleCount > 0) onRules(node.arn);
  };
  // A double click fires onClick twice on the way, which is why selecting is the cheap half: it
  // is idempotent and moves nothing, so the two clicks that precede the open are not felt.
  const keyed = (e: { key: string; preventDefault: () => void }) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    // The keyboard has no double click. The same SEQUENCE stands in for it: the first Enter
    // selects, and an Enter on the plate that is already selected opens what it holds - which is
    // what the two clicks of a double click do, in the same order. The aria-label says so.
    if (selected && holdsSomething) open();
    else onSelect(node.arn);
  };
  const marked = mark ? ` graph-node-marked graph-node-${mark.toLowerCase()}` : "";
  const chosen = selected ? " graph-node-selected" : "";
  if (node.box) {
    const openable = node.holds > 0;
    return (
      <g
        className={`graph-node graph-node-box graph-node-${type} graph-node-toggle${marked}${chosen}`}
        role="button"
        tabIndex={0}
        aria-expanded={openable ? node.open : undefined}
        aria-pressed={selected}
        aria-label={`${node.title.split("\n")[0]} — 상세 보기${
          openable ? `, 두 번 누르면 네트워크 인터페이스 ${node.holds}개 ${node.open ? "접기" : "펼치기"}` : ""}`}
        onClick={() => onSelect(node.arn)}
        onDoubleClick={open}
        onKeyDown={keyed}
      >
        <rect
          className={node.sensitive ? "graph-plate graph-plate-box graph-plate-sensitive"
            : "graph-plate graph-plate-box"}
          x={node.x} y={node.y} width={node.w} height={node.h} rx={4}
        >
          <title>{node.title}</title>
        </rect>
        {mark && <circle className="graph-mark" cx={node.x + node.w - 8} cy={node.y + 8} r={4} />}
        {node.icon && (
          <image href={node.icon} x={node.x + 8} y={node.y + 5} width={18} height={18} />
        )}
        <text className="graph-box-text" x={node.x + (node.icon ? 30 : 10)} y={node.y + 18}>
          <tspan className="graph-node-label">{node.label}</tspan>
          <tspan className="graph-node-sub" dx="6">{node.sub}</tspan>
        </text>
        {node.note && (
          <text className="graph-node-sub" x={node.x + 10} y={node.y + 50}>{node.note}</text>
        )}
      </g>
    );
  }
  return (
    <g
      className={`graph-node graph-node-${type} graph-node-toggle${marked}${chosen}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${node.title.split("\n")[0]} — 상세 보기${
        node.ruleCount > 0 ? `, 두 번 누르면 규칙 ${node.ruleCount}개 표로 보기` : ""}`}
      onClick={() => onSelect(node.arn)}
      onDoubleClick={open}
      onKeyDown={keyed}
    >
      {node.erase && (
        <rect className="topo-erase" x={node.x} y={node.y} width={node.w} height={node.h} />
      )}
      <rect
        className={node.sensitive ? "graph-plate graph-plate-sensitive" : "graph-plate"}
        x={node.x} y={node.y} width={node.w} height={node.h} rx={4}
      >
        <title>{node.title}</title>
      </rect>
      {mark && <circle className="graph-mark" cx={node.x + node.w - 8} cy={node.y + 8} r={4} />}
      {node.icon ? (
        <image href={node.icon} x={node.x + (node.w - G_ICON) / 2} y={node.y + 6}
               width={G_ICON} height={G_ICON} />
      ) : (
        <text className="graph-node-type" x={node.x + node.w / 2} y={node.y + 24} textAnchor="middle">
          {node.typeLabel}
        </text>
      )}
      <text className="graph-node-label" x={node.x + node.w / 2} y={node.y + 50} textAnchor="middle">
        {node.label}
      </text>
      <text className="graph-node-sub" x={node.x + node.w / 2} y={node.y + 65} textAnchor="middle">
        {node.sub}
      </text>
    </g>
  );
}

/** What the budget left out of one container, as a plate that is visibly not a resource. */
function GraphOverflowShape({ plate }: { plate: GraphOverflow }) {
  return (
    <g>
      <rect
        className="graph-plate graph-plate-overflow"
        x={plate.x} y={plate.y} width={plate.w} height={plate.h} rx={4} strokeDasharray="4 3"
      >
        <title>{plate.label}</title>
      </rect>
      <text className="graph-node-label" x={plate.x + plate.w / 2} y={plate.y + plate.h / 2 + 4}
            textAnchor="middle">
        {plate.label}
      </text>
    </g>
  );
}

/**
 * One connection. The engine's polyline, coloured by kind, dashed when the engine derived it
 * rather than read it, and with an arrowhead on the two kinds that HAVE a direction: a route
 * points at its gateway, and a security group chain points the way the traffic is allowed to go.
 * Membership and attachment have no direction, and an arrowhead on them would claim one.
 *
 * The chain's direction is not decoration. `allows_from` and `allows_to` are opposite facts about
 * the same pair of groups - one admits traffic from the other, the other sends traffic to it - and
 * a line without a head would read as "these two groups are related", which is the one thing an
 * approver cannot act on.
 *
 * A ring on each end. Lines are painted under the plates, so a line can vanish under a plate it
 * does not end at and reappear on the far side; the rings are what says where it really stops.
 * A directed line's far end has the arrowhead instead.
 */
const DIRECTED_EDGES = new Set(["route", "chain"]);

function GraphEdgeShape({ edge, uid, lit }: { edge: GraphEdge; uid: string;
  /** One end of this line is the resource the reader clicked. It is drawn in the selection colour
   *  - the same blue as that plate's border - so "what is this joined to" is answered by looking
   *  rather than by tracing. */
  lit: boolean }) {
  const kind = `graph-edge graph-edge-${edge.kind}${lit ? " graph-edge-lit" : ""}`;
  const cls = `${kind}${edge.implicit ? " graph-edge-implicit" : ""}`;
  const directed = DIRECTED_EDGES.has(edge.kind);
  // A marker takes its colour from where it is DEFINED, so a lit line needs a lit head or the
  // arrow stays the kind's colour while the line it sits on is blue.
  const head = lit ? "la" : (edge.kind === "chain" ? "ca" : "ga");
  return (
    <g>
      <polyline
        className={cls}
        points={edge.points.map((p) => `${p.x},${p.y}`).join(" ")}
        markerEnd={directed ? `url(#${uid}-${head})` : undefined}
      >
        <title>{edge.title}</title>
      </polyline>
      <circle className={`${kind} graph-edge-end`} cx={edge.x1} cy={edge.y1} r={2.5} />
      {!directed && (
        <circle className={`${kind} graph-edge-end`} cx={edge.x2} cy={edge.y2} r={2.5} />
      )}
    </g>
  );
}

/**
 * The relationship picture, in layers: the container borders, then the lines, then the container
 * labels over the lines, then the overflow plates and the resource plates over everything, so a
 * line never runs across a plate or a label; the foot last. The <desc> is graphSummary(), which
 * has its own unit test.
 */
function GraphFigure({ scene, name, title, uid, onToggle, onSelect, onRules, selected, marks }:
                     { scene: RelationScene; name: string; title: string; uid: string;
                       onToggle: (id: string) => void; onSelect: (arn: string) => void;
                       onRules: (arn: string) => void;
                       selected: string | null; marks: Map<string, string> }) {
  // The lines are keyed by NODE ID and the selection is an ARN, so the chosen plate says which id
  // its lines carry. Null when nothing is chosen, and then no line is lit - and null is also what
  // a chosen resource the budget left out of the picture gives, which is the honest answer: there
  // is no plate to light lines from.
  const litId = scene.nodes.find((n) => n.arn === selected)?.id ?? null;
  const isLit = (e: GraphEdge) => litId !== null && (e.from === litId || e.to === litId);
  // Lit lines last, so they are painted over the lines they cross rather than under them.
  const edges = [...scene.edges].sort((a, b) => Number(isLit(a)) - Number(isLit(b)));
  return (
    // Fills the window's width (.graph-svg) and never shrinks below its own: the min-width is the
    // scene's width, so a narrow window scrolls the figure rather than making the labels smaller.
    // A group and not an image: the instance boxes inside are buttons, and role="img" would fold
    // them away from a screen reader.
    <svg
      className="topology-svg graph-svg"
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      width={scene.width}
      height={scene.height}
      style={{ minWidth: scene.width }}
      preserveAspectRatio="xMinYMin meet"
      fontFamily="inherit"
      role="group"
      aria-labelledby={`${uid}-gt ${uid}-gd`}
    >
      <title id={`${uid}-gt`}>{`${name}이 닿는 ${title} 자원 연결 관계도`}</title>
      <desc id={`${uid}-gd`}>{graphSummary(scene)}</desc>
      <defs>
        <marker id={`${uid}-ga`} viewBox="0 0 8 8" refX="8" refY="4"
                markerWidth="5" markerHeight="5" orient="auto">
          <path className="graph-edge-marker" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
        {/* The chain's own head, because a marker takes its colour from where it is DEFINED and
            not from the line that references it. One shared head would paint the security-group
            chain in the route colour, and the two lines mean opposite kinds of thing. */}
        <marker id={`${uid}-ca`} viewBox="0 0 8 8" refX="8" refY="4"
                markerWidth="5" markerHeight="5" orient="auto">
          <path className="graph-chain-marker" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
        {/* And the lit head, for a directed line that ends at the chosen resource. One head for
            both directed kinds: a lit line is the selection colour whatever kind it is. */}
        <marker id={`${uid}-la`} viewBox="0 0 8 8" refX="8" refY="4"
                markerWidth="5" markerHeight="5" orient="auto">
          <path className="graph-lit-marker" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
      </defs>
      <rect className="topo-ground" x={0} y={0} width={scene.width} height={scene.height} />
      {scene.containers.map((c) => <GraphContainerShape key={c.id} box={c} />)}
      {edges.map((e) => (
        <GraphEdgeShape key={`${e.kind}|${e.from}|${e.to}`} edge={e} uid={uid} lit={isLit(e)} />
      ))}
      {scene.containers.map((c) => <GraphContainerLabel key={c.id} box={c} />)}
      {scene.overflow.map((o) => <GraphOverflowShape key={o.container} plate={o} />)}
      {/* Boxes before plates, so an interface is painted over the instance frame that holds it. */}
      {scene.nodes.filter((n) => n.box).map((n) => (
        <GraphNodeShape key={n.id} node={n} onToggle={onToggle} onSelect={onSelect}
                        onRules={onRules}
                        selected={n.arn === selected} mark={marks.get(n.arn) ?? null} />
      ))}
      {scene.nodes.filter((n) => !n.box).map((n) => (
        <GraphNodeShape key={n.id} node={n} onToggle={onToggle} onSelect={onSelect}
                        onRules={onRules}
                        selected={n.arn === selected} mark={marks.get(n.arn) ?? null} />
      ))}
      {scene.foot.map((line) => (
        <text className="topo-foot" key={line.text} x={8} y={line.y}>{line.text}</text>
      ))}
    </svg>
  );
}

/* ---- what a security group allows ------------------------------------------------------------
 * A TABLE and not a set of plates, which is the whole reason it is here. A rule has four values -
 * direction, protocol, ports, target - and four values per row is what a table is for; drawing one
 * plate per rule put those four values into two lines of a tile and then needed a line back to the
 * group to say whose rule it was. Eleven tiles for two groups, and the groups lost among them.
 *
 * Over the picture rather than beside it, because the reader asked one question and the answer is
 * wide: the panel column has room for a list, not for four columns and a target long enough to
 * paste. The picture stays underneath and the panel stays open behind it. */

/** What a security group allows, one rule per row. */
function RulesTable({ rules }: { rules: SecurityGroupRule[] }) {
  return (
    <table className="panel-routes rules-table">
      <thead><tr><th>방향</th><th>프로토콜·포트</th><th>대상</th></tr></thead>
      <tbody>
        {rules.map((r, i) => {
          // The chain: a target that is another GROUP is a relation and not an address, and the
          // picture draws it as an arrow between the two groups.
          const chain = r.target_kind === "security_group";
          // Anywhere at all, v4 or v6. The row is marked because this is the value an approver
          // opened the table to find.
          const open = r.target === "0.0.0.0/0" || r.target === "::/0";
          return (
            // The index is in the key because two rules of one group CAN agree on all four values
            // - AWS keys them by rule id, not by content - and a duplicate key would drop a row
            // that is really there.
            <tr key={`${r.direction}|${r.protocol}|${r.from_port}|${r.target}|${i}`}
                className={open ? "panel-route-default" : undefined}>
              <td>{r.direction === "egress" ? "아웃바운드" : "인바운드"}</td>
              <td>{ruleText(r)}</td>
              <td>
                <code>{r.target}</code>
                {chain && <span className="muted"> 보안 그룹</span>}
                {open && <span className="sensitive"> 모든 주소</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ---- what one resource is, when a reader clicks it -------------------------------------------
 * The picture answers "what is connected to what". This panel answers the other two questions an
 * approver has about a resource they can now see: what does this policy let somebody DO to it,
 * and did either analysis find anything about it. Both answers are computed in
 * server/resourceFacts.js - which one of a finding's targets reaches THIS resource is a join with
 * three outcomes and a test file, not a filter written inline in a component. */

/** One action, linked to AWS's page for it when there is one. */
function PanelAction({ action, level, makes }:
                     { action: string; level: string | null; makes: boolean }) {
  const href = actionDocUrl(action);
  const name = <code>{action}</code>;
  return (
    <li className="panel-action">
      <span className={`panel-level panel-level-${(level ?? "unknown").replace(/\s+/g, "-")}`}>
        {level ? LEVEL_LABEL[level] ?? level : "등급 없음"}
      </span>
      {href ? (
        <a className="action-doc" href={href} target="_blank" rel="noreferrer noopener"
           title={`${action} · AWS 문서`}>{name}</a>
      ) : name}
      {/* An action that brings this type into being acts on resources that do not exist yet, so a
          restriction naming today's ARNs is no scope for it. The picker says the same thing. */}
      {makes && <span className="muted small">이 유형을 생성한다</span>}
    </li>
  );
}

/** One finding, as this panel shows it: the grade, what it is, and what fired it. */
function PanelFinding({ card, onOpen }: { card: FindingCard; onOpen: () => void }) {
  // A real button rather than a clickable <li>: the keyboard, the focus ring and the reading order
  // all come with it. It opens the finding's own card and changes nothing, so it is a link to a
  // window rather than a control - which is why it carries no pressed state.
  return (
    <li className="panel-finding">
      <button type="button" className="panel-finding-open" onClick={onOpen}
              title={`${card.title} — 카드 원문을 연다`}>
        <div className="panel-finding-head">
          <span className={GRADE_CLASS[card.grade]}>{GRADE_LABEL[card.grade]}</span>
          <strong>{card.title}</strong>
          <span className="muted small">{CATEGORY_LABEL[card.category] ?? card.category}</span>
          <span className="muted small">{STATUS_LABEL[card.status] ?? card.status}</span>
          {card.source === "model" && <span className="panel-source">AI</span>}
          {!card.restrictable && <span className="muted small">차단 불가</span>}
        </div>
        <div className="panel-finding-why">
          <span className="muted small">{card.reachLabel}</span>
          {card.actions.length > 0 && (
            <span className="panel-finding-actions">
              {card.actions.map((a) => <code key={a}>{a}</code>)}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

/**
 * The panel. Everything in it is about ONE resource, and every sentence says where it came from:
 * the actions from the assessment's own group, the findings from the two analyses, and the three
 * counts that say which findings reach this resource and which only reach its type.
 */
function ResourcePanel({ facts, ran, onClose, onOpenFinding, onOpenRules }: {
  facts: ResourceFacts;
  ran: boolean;
  onClose: () => void;
  /** Open one finding's own card over the picture, by its id. */
  onOpenFinding: (id: string) => void;
  /** Open this resource's rules table over the picture. Only a security group has one. */
  onOpenRules: () => void;
}) {
  const { named, typed, elsewhere } = facts.findings;
  return (
    <aside className="graph-panel" aria-label={`${facts.id} 상세`}>
      <div className="graph-panel-head">
        <h5>
          {facts.name ? <>{facts.name} <code>{facts.id}</code></> : <code>{facts.id}</code>}
          {facts.sensitive && <span className="sensitive"> 민감</span>}
        </h5>
        <button type="button" onClick={onClose} aria-label="상세 닫기">닫기</button>
      </div>
      <p className="muted small">
        <code>{facts.resourceType}</code> · {facts.region}
        {facts.worstGrade && (
          <> · 이 자원에 걸린 가장 높은 등급{" "}
            <span className={GRADE_CLASS[facts.worstGrade]}>{GRADE_LABEL[facts.worstGrade]}</span>
          </>
        )}
      </p>

      {/* A route table's routes, above the actions: for this one type the routes ARE what the
          reader came to check - which subnet is public and why - and the answer is the pair
          (destination, target), not the target alone. */}
      {facts.resourceType === "ec2:route-table" && (
        <>
          <h6>경로 {facts.routes.length}개</h6>
          {facts.routes.length === 0 ? (
            <p className="muted small">
              이 평가에는 이 표의 경로가 없다 — 조회기가 경로를 기록하기 전에 만들어진 평가다.
              다시 조회하면 채워진다.
            </p>
          ) : (
            <table className="panel-routes">
              <thead><tr><th>목적지</th><th>대상</th><th>상태</th></tr></thead>
              <tbody>
                {facts.routes.map((r) => {
                  const dflt = r.destination === "0.0.0.0/0" || r.destination === "::/0";
                  return (
                    <tr key={`${r.destination}|${r.target}`} className={dflt ? "panel-route-default" : undefined}>
                      <td><code>{r.destination}</code>{dflt && <span className="muted"> 기본</span>}</td>
                      <td><code>{r.target}</code></td>
                      <td className={r.state === "blackhole" ? "sensitive" : "muted"}>{r.state || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted small">
            <strong>기본 경로(0.0.0.0/0 · ::/0)가 <code>igw-</code>로 가면</strong> 이 표에 연결된
            서브넷이 퍼블릭이다. 좁은 대역만 게이트웨이로 가는 표는 퍼블릭이 아니고,{" "}
            <code>eigw-</code>는 IPv6 송신 전용이라 퍼블릭이 아니다.
          </p>
        </>
      )}

      {/* What a security group ALLOWS is not in the panel: it is the table the popup holds, and
          this is the way back into it. Clicking the plate opened both, so the button is for the
          reader who closed the table and wants it again without hunting for the plate. */}
      {facts.resourceType === "ec2:security-group" && (
        <>
          <h6>규칙 {facts.rules.length}개</h6>
          {facts.rules.length === 0 ? (
            <p className="muted small">
              이 평가에는 이 그룹의 규칙이 없다 — 조회기가 규칙을 기록하기 전에 만들어진
              평가이거나, 규칙이 하나도 없는 그룹이다. 다시 조회하면 갈린다.
            </p>
          ) : (
            <p className="small">
              <button type="button" className="panel-rules-open" onClick={onOpenRules}>
                규칙 {facts.rules.length}개 표로 보기
              </button>
            </p>
          )}
        </>
      )}

      <h6>이 정책이 이 자원에 허용하는 작업 {facts.actions.length}개</h6>
      {/* The two facts that change what the list MEANS, and both come from the group rather than
          from the resource: a policy that named no resource covers what is made next, and a group
          the reference could not attribute lists every action of the service. */}
      <p className="muted small">
        {facts.scope === "*"
          ? "이 정책은 자원을 지정하지 않았다 — 지금 있는 것과 앞으로 생기는 것 모두에 해당한다."
          : "이 정책이 이름으로 지정한 자원이다."}
        {facts.attribution === "service" && " 어느 작업이 이 유형에 닿는지 판정하지 못해 이 서비스의 작업 전부를 적었다."}
        {facts.levels.length > 0 && ` 접근 수준: ${facts.levels.map((l) => `${l.label} ${l.count}`).join(" · ")}.`}
      </p>
      {facts.actions.length === 0 ? (
        <p className="muted small">이 평가는 이 유형에 닿는 작업을 적지 않았다.</p>
      ) : (
        <ul className="panel-actions">
          {facts.actions.map((a) => (
            <PanelAction key={a.name} action={a.name} level={a.level} makes={a.makes} />
          ))}
        </ul>
      )}

      <h6>이 자원에 대한 분석</h6>
      {!ran ? (
        <p className="muted small">
          아직 분석을 돌리지 않았다. 아래 <strong>위험 및 공격 경로</strong>에서 「정책 기반 분석」이나
          「AI 분석」을 누르면 결과가 여기에 함께 나온다. <strong>지금 비어 있는 것은 발견이 없다는
          뜻이 아니다.</strong>
        </p>
      ) : named.length === 0 && typed.length === 0 ? (
        <p className="muted small">
          이 자원을 지목한 발견이 없다.
          {elsewhere > 0 && ` 같은 유형의 다른 자원에 걸린 발견은 ${elsewhere}개다.`}
        </p>
      ) : (
        <>
          {named.length > 0 && (
            <>
              {/* The list below is a summary and says so. What a row opens is the SAME card the
                  분석 page draws - not a second rendering of it - so a reader can check the
                  narrative, the full trigger actions, the targets and the containment badge
                  without leaving the picture. */}
              <p className="muted small">
                이 자원을 지목한 발견 {named.length}개 — <strong>줄을 누르면</strong> 그 발견의
                카드 원문이 열린다.
              </p>
              <ul className="panel-findings">
                {named.map((c) => (
                  <PanelFinding key={c.id} card={c} onOpen={() => onOpenFinding(c.id)} />
                ))}
              </ul>
            </>
          )}
          {/* Kept apart from the named ones, and said out loud. A finding whose sample was cut may
              or may not reach this resource, and folding it in would put a grade on a resource
              nothing said was reachable. */}
          {typed.length > 0 && (
            <>
              <p className="muted small">
                이 유형에 걸렸지만 <strong>이 자원인지는 알 수 없는</strong> 발견 {typed.length}개 —
                목록이 잘려 자원 이름을 전부 담지 못했다.
              </p>
              <ul className="panel-findings">
                {typed.map((c) => (
                  <PanelFinding key={c.id} card={c} onOpen={() => onOpenFinding(c.id)} />
                ))}
              </ul>
            </>
          )}
          {elsewhere > 0 && (
            <p className="muted small">
              같은 유형의 <strong>다른</strong> 자원에만 걸린 발견 {elsewhere}개는 여기 적지 않았다.
            </p>
          )}
        </>
      )}
    </aside>
  );
}

/**
 * The table under the relationship picture: one row per DRAWN resource, with the number of lines
 * that touch it. What the budget left out is not here - the foot line says how many, and the
 * filter bar is how to see them.
 */
function GraphTable({ scene }: { scene: RelationScene }) {
  return (
    <table className="topology-table">
      <thead>
        <tr><th>유형</th><th>이름</th><th>ID</th><th>자리</th><th>연결</th><th>민감</th></tr>
      </thead>
      <tbody>
        {scene.rows.map((row) => (
          <tr key={row.id}>
            <td>{row.typeLabel} <code>{row.resourceType}</code></td>
            <td className={row.name ? undefined : "none"}>{row.name || "—"}</td>
            <td><code>{row.id}</code></td>
            <td className={row.where ? undefined : "none"}>{row.where || "없음"}</td>
            <td className={row.degree > 0 ? undefined : "none"}>{row.degree > 0 ? row.degree : "—"}</td>
            <td className={row.sensitive ? "sensitive" : "none"}>{row.sensitive ? "민감" : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One dimension of the filter: 전체 plus a checkbox per value, with the count beside it.
 *
 * "전체" is a real control and not a decoration - it is the state the window opens in, and the one
 * an approver returns to after narrowing. It is rendered as its own checkbox rather than as a
 * "clear" button so the three states an approver can be in (everything / some / nothing chosen)
 * read the same way on every dimension.
 */
function FacetPicker({ label, values, chosen, onChange }: {
  label: string;
  values: { id: string; total: number }[];
  /** Empty means 전체 - see keeps() in the module. */
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const all = chosen.length === 0;
  // A dimension with one value cannot narrow anything: 전체 and that one value are the same
  // picture. It used to render as a live checkbox that collapsed straight back to 전체 on every
  // click - a control that looked responsive and was not, sitting next to rows that explain in so
  // many words why they are disabled. Said rather than mimed, in the same grammar.
  const single = values.length === 1;
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((v) => v !== id) : [...chosen, id];
    // Ticking every value one by one lands on the same picture as 전체, so it collapses to 전체 -
    // otherwise the window would hold two states that draw identically and an approver could not
    // tell which one they were in.
    onChange(next.length === values.length ? [] : next);
  };
  return (
    <div className="topology-facet">
      <span className="topology-facet-name">{label}</span>
      {!single && (
        <label className={all ? "topology-chip on" : "topology-chip"}>
          <input type="checkbox" checked={all} onChange={() => onChange([])} />
          전체
        </label>
      )}
      {values.map((value) => (
        <label key={value.id}
               className={single ? "topology-chip off"
                 : chosen.includes(value.id) ? "topology-chip on" : "topology-chip"}
               title={single ? "값이 하나뿐이라 좁힐 것이 없다" : undefined}>
          <input
            type="checkbox"
            checked={single || chosen.includes(value.id)}
            disabled={single}
            readOnly={single}
            onChange={single ? undefined : () => toggle(value.id)}
          />
          {value.id} <span className="muted">{value.total.toLocaleString()}</span>
        </label>
      ))}
      {single && <span className="muted small">값이 하나뿐이라 좁힐 것이 없다</span>}
    </div>
  );
}

/**
 * The filter bar: the four dimensions a container actually recorded.
 *
 * The account and the region are on every row. The VPC and the subnet are there because the impact
 * querier now looks them up - no EC2 ARN carries a VPC and Resource Explorer does not return one,
 * so impact/inventory.py joins the membership on from the EC2 Describe calls.
 *
 * What still has to be said out loud is the rows that lookup could not place. A VPC filter cannot
 * speak for them, and folding them silently into "not in this VPC" would let an approver read a
 * denied optional permission as an empty VPC.
 */
/**
 * The type checkboxes: every type the policy reaches, all on, unticking hides.
 *
 * NOT a FacetPicker, and the difference is the grammar rather than the styling. A facet narrows TO
 * what is ticked and collapses back to 전체 when everything is; this hides what is UNTICKED and
 * 전체 is the state it starts in. They read the opposite way round because the questions are
 * opposite: an account or a VPC is a place ("show me that one"), a resource type is a layer over
 * the picture ("take that away"), and forty network interfaces drawn over the instances they belong
 * to is the second question every time.
 *
 * Container types are not offered. A VPC and a subnet are the border round what is inside them, so
 * unticking one would have to either leave the border (a box that does nothing) or take it away
 * (and claim the instances inside are in no subnet). Said out loud below rather than left as a gap.
 */
function TypePicker({ types, hidden, onChange }: {
  types: GraphType[];
  hidden: string[];
  onChange: (next: string[]) => void;
}) {
  const offered = types.filter((t) => !t.container);
  if (offered.length === 0) return null;
  const toggle = (type: string) => onChange(
    hidden.includes(type) ? hidden.filter((t) => t !== type) : [...hidden, type],
  );
  const off = offered.filter((t) => hidden.includes(t.resourceType));
  return (
    <div className="topology-types">
      <span className="topology-facet-name">유형</span>
      <div className="topology-type-list">
        {offered.map((t) => (
          <label key={t.resourceType}
                 className={hidden.includes(t.resourceType) ? "topology-chip" : "topology-chip on"}
                 title={t.resourceType}>
            <input type="checkbox" checked={!hidden.includes(t.resourceType)}
                   onChange={() => toggle(t.resourceType)} />
            {t.label} <span className="muted">{t.total.toLocaleString()}</span>
          </label>
        ))}
      </div>
      <p className="muted small">
        체크를 풀면 그 유형의 자원이 그림에서 빠진다 — 그 자원에 붙은 선도 함께 빠진다.{" "}
        <strong>라우팅 테이블과 네트워크 ACL은 처음부터 꺼져 있다</strong>: 서브넷이 퍼블릭인지
        프라이빗인지는 이름 옆 띠가 이미 말하므로, 표를 그리지 않아도 그 답은 화면에 있다. 표의
        경로 전부를 보려면 켜서 판을 누른다.
        {" "}<strong>VPC와 서브넷은 여기 없다</strong> — 그 둘은 판이 아니라 안에 있는 것을 두르는
        테두리이고, 테두리를 지우는 것은 판을 지우는 것과 다른 요청이다.
        {off.length > 0 && (
          <>
            {" "}지금 {off.length}종을 감췄다 ({off.map((t) => t.label).join(" · ")}).{" "}
            <button type="button" className="linkish" onClick={() => onChange([])}>모두 켜기</button>
          </>
        )}
      </p>
    </div>
  );
}

function FilterBar({ facets, filter, onChange }: {
  facets: Facets;
  filter: SceneFilter;
  onChange: (next: SceneFilter) => void;
}) {
  /** One dimension, rendered only when the picture offers it and the data filled it. */
  const dimension = (id: keyof SceneFilter, label: string) => {
    const values = facets[id as "accounts"] ?? [];
    if (!facets.dimensions.includes(id) || values.length === 0) return null;
    return (
      <FacetPicker
        label={label}
        values={values}
        chosen={filter[id] ?? []}
        onChange={(next) => onChange({ ...filter, [id]: next })}
      />
    );
  };
  return (
    <div className="topology-filter">
      {dimension("accounts", "계정")}
      {dimension("regions", "리전")}
      {/* Between the region and the VPC, because a cluster is region-scoped and holds services
          that may sit in several VPCs - the same order the picture draws them in. */}
      {dimension("clusters", "클러스터")}
      {dimension("vpcs", "VPC")}
      {dimension("subnets", "서브넷")}
      {/* A resource can name up to sixteen subnets, so the chips can sum to more than the row
          count. Said out loud rather than folded away: folding it would mean picking one. */}
      {facets.multiSubnet && facets.subnets.length > 0 && (
        <p className="muted small">
          한 자원이 서브넷을 여러 개 쓸 수 있어서, 서브넷 칩의 합은 자원 수보다 클 수 있다.
        </p>
      )}
      {facets.unplaced > 0 && (
        <p className="muted small">
          VPC를 알 수 없는 자원이 {facets.unplaced.toLocaleString()}개 있다
          (VPC에 속할 수 있는 {facets.placeable.toLocaleString()}개 중). VPC나 서브넷으로 좁히면
          <strong> 이 자원들은 빠진다</strong> — 조회기가 배치를 읽지 못했거나(선택 권한이다),
          이 평가가 그 값이 생기기 전에 만들어졌다는 뜻이다. 볼륨·스냅샷·AMI처럼 VPC가 아예 없는
          유형은 이 수에 들어 있지 않다.
        </p>
      )}
      {facets.unavailable.map((dimension) => (
        <div className="topology-facet" key={dimension.id}>
          <span className="topology-facet-name">{dimension.label}</span>
          <span className="topology-chip off" title={dimension.why}>
            <input type="checkbox" disabled checked={false} readOnly />
            고를 수 없다
          </span>
          <span className="muted small">{dimension.why}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Why the placement lookup could not speak for some of the picture.
 *
 * `placement: 'none'` never reaches here - AWS answering "this is in no VPC" is an answer, and it
 * is the ordinary state for a Lambda function. What is left is the states where the lookup did not
 * get to say anything, and each of them is a different thing for an approver to do about it: a
 * denied permission is a deploy step, a spent budget is a bigger account, a short ARN is a listing
 * the role may not do. One sentence each, and none of them changes a count.
 */
const UNMEASURED: Record<string, (n: string) => string> = {
  failed: (n) => `자원 ${n}개의 배치를 읽지 못했다 — 조회기에 권한이 없거나 호출이 거절되었다. `
    + '이 정책이 닿는 자원의 수는 그대로다.',
  'over-budget': (n) => `자원 ${n}개는 한 번의 평가가 쓰는 배치 조회 한도를 넘어서 읽지 못했다.`,
  'no-cluster': (n) => `서비스 ${n}개는 ARN이 짧은 형식이라 클러스터를 읽을 수 없었다.`,
  'subnet-unknown': (n) => `서비스 ${n}개는 서브넷은 알아냈지만 그 서브넷의 VPC를 조회하지 못했다.`,
  unanswered: (n) => `자원 ${n}개는 조회가 답하지 않았다 — 이 평가가 배치를 읽기 전에 만들어졌거나, `
    + '조회 뒤에 사라진 자원이다.',
};

function UnmeasuredNote({ unmeasured }: { unmeasured: Record<string, number> }) {
  const said = Object.entries(unmeasured)
    .filter(([reason, n]) => n > 0 && reason in UNMEASURED)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (said.length === 0) return null;
  return (
    <p className="warn-inline">
      {said.map(([reason, n]) => UNMEASURED[reason](n.toLocaleString())).join(" ")}
    </p>
  );
}

/**
 * The button, the closed-state summary beside it, and the window.
 *
 * The GATE LIVES HERE, not in Impact.tsx: this returns null when scene() returns null, so the
 * three policy names never appear in a 1,700-line file where nobody would find them, and
 * widening the scope later touches one module.
 *
 * `disabled` is deliberately not a prop. Every other control in this subtree honours the read-only
 * gate because it writes something; this one only reads, and an approver who cannot edit is
 * exactly the reader who most needs to see what the policy reaches.
 */
export function PolicyTopology({ policy, name, accountId, coverage, reference, findings,
                                 analysed = false, containmentOf }: {
  policy: ImpactPolicy;
  /** The policy as a person names it - policyName(identifier). */
  name: string;
  accountId: string;
  /** The assessment's own record of what it managed to enumerate. An empty picture and a failed
   *  EC2 lookup are the same document shape and opposite news, and this is what tells them apart. */
  coverage: ImpactCoverage | null;
  /** The assessment's action reference, for each action's AWS access level. Null on an assessment
   *  written before the container carried it - the panel then prints no level rather than a guess. */
  reference?: ImpactActionReference | null;
  /** Every finding both analyses produced, deduplicated by id. Empty until somebody runs one, and
   *  the panel says which of the two it is - empty is not "nothing was found". */
  findings?: Finding[];
  /**
   * Whether an analysis has ANSWERED for this plan, told rather than inferred.
   *
   * The panel used to read this off `findings.length > 0`, which is the same guess with a rarer
   * failure: a run that fired no rule at all would have been drawn as a run nobody started. The
   * count answers "무엇이 나왔나"; this answers "물어보기는 했나", and those are two questions.
   */
  analysed?: boolean;
  /**
   * How far this decision cuts one finding's path, for the badge on its card.
   *
   * Passed in rather than computed here: it depends on the restrictions being composed right now,
   * on the permission set's protected actions and on the PassRole fence - none of which this window
   * holds, and all of which the policy block above it does. Omitted, every card reads 차단되지 않음,
   * which is the answer for a screen that cannot see the restrictions rather than a claim about
   * them - so the caller passes it and the two screens agree.
   */
  containmentOf?: (finding: Finding) => ContainmentState;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  /** The finding whose own card is open over the picture, by id. Null is the picture alone. */
  const cardBox = useRef<HTMLDialogElement>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  /** The security group whose rules table is open over the picture, by ARN. */
  const rulesBox = useRef<HTMLDialogElement>(null);
  const [openRules, setOpenRules] = useState<string | null>(null);
  const uid = useId();
  /**
   * The picture the button promises: no dimension narrowed, and two types switched off.
   *
   * 라우팅 테이블 and 네트워크 ACL start off because the question they used to be needed for is
   * already answered elsewhere on the screen - the subnet's own label band names its table and the
   * default route that made it public or private, so the table's plate and its association lines
   * are a second copy of an answer the reader has. Switching them on is one click and shows the
   * routes in full; leaving them on by default put twelve plates and their lines over the
   * resources somebody opened the window to look at.
   *
   * A DEFAULT, not a decision, so the sentence under the picture says 「지금 그림에 있는 것은
   * 일부다」 rather than 「고른 조건만 그렸다」 - nobody chose this one.
   */
  const empty: SceneFilter = { accounts: [], regions: [], vpcs: [], subnets: [],
                               hiddenTypes: ["ec2:route-table", "ec2:network-acl"] };
  // 전체 on every dimension, which is the picture the button promises. Reset in onClose below, and
  // not merely by the initial value: this component never unmounts (the sweep poll re-renders it
  // with the same key), so a filter an approver set five minutes ago survived closing the window,
  // and a filter nobody can see is a filter that makes the next picture a quiet lie.
  const [filter, setFilter] = useState<SceneFilter>(empty);
  const spec = specOf(policy);
  const enumerated = enumeratedFor(policy, coverage);
  const facets = useMemo(() => facetsOf(policy), [policy]);
  // Unfiltered, for the closed-state summary and for the sentence that says what was narrowed away.
  const whole = useMemo(
    () => sceneOf(policy, accountId, null, enumerated), [policy, accountId, enumerated],
  );
  const scene = useMemo(
    () => sceneOf(policy, accountId, filter, enumerated),
    [policy, accountId, filter, enumerated],
  );
  // The relationship picture, for the policies whose spec has one. Null for the others, and then
  // the window has one view and no switch.
  const wholeGraph = useMemo(
    () => relationScene(policy, accountId, null, enumerated), [policy, accountId, enumerated],
  );
  // Which instance boxes are open. Closed by default: the picture shows the instance, its group
  // lines and its volumes, and a click on the box opens it to show the interfaces inside.
  const [expanded, setExpanded] = useState<string[]>([]);
  const graph = useMemo(
    () => relationScene(policy, accountId, filter, enumerated, { expanded }),
    [policy, accountId, filter, enumerated, expanded],
  );
  const toggle = (id: string) => setExpanded(
    (prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]),
  );
  /** The resource whose panel is open, by ARN. Null is the picture with nothing chosen. */
  const [chosen, setChosen] = useState<string | null>(null);
  const found = findings ?? [];
  // Which resources a finding NAMES, so the picture can mark them before anything is clicked.
  const marks = useMemo(() => gradesByResource(policy, found), [policy, found]);
  /** The findings by id, for the card a panel row opens. */
  const byId = useMemo(() => new Map(found.map((f) => [f.id, f])), [found]);
  /**
   * The assessment's own row for an ARN, so the card's target list reads as it does on the analysis
   * page - a name and a region rather than a bare ARN. Built once per policy: a card holds eight
   * targets and an enterprise policy holds thousands of rows.
   */
  const rows = useMemo(() => {
    const index = new Map<string, ImpactResource>();
    for (const group of policy?.affected ?? []) {
      for (const r of group.resources ?? []) if (r?.arn && !index.has(r.arn)) index.set(r.arn, r);
    }
    return index;
  }, [policy]);
  const card = openCard ? byId.get(openCard) ?? null : null;
  // The dialog element follows the state rather than being opened at the click: showModal() on a
  // node React has not rendered yet does nothing, and closing it from the ESC key has to put the
  // state back or the next click on the same row opens nothing.
  useEffect(() => {
    const box = cardBox.current;
    if (!box) return;
    if (card && !box.open) box.showModal();
    if (!card && box.open) box.close();
  }, [card]);
  const facts = useMemo(
    () => (chosen ? resourceFacts(policy, reference ?? null, found, chosen) : null),
    [policy, reference, found, chosen],
  );
  /**
   * The group the rules table is about, and its rules.
   *
   * Its OWN facts and not `facts` above: the two states move separately on purpose. A reader who
   * closes the table keeps the panel, and one who clicks another plate while the table is open
   * gets that plate's panel - so the table must go on saying which group it is a table of.
   */
  const rulesOf = useMemo(
    () => (openRules ? resourceFacts(policy, reference ?? null, found, openRules) : null),
    [policy, reference, found, openRules],
  );
  // Same shape as the finding card below: the element follows the state, because showModal() on a
  // node React has not rendered does nothing and ESC has to put the state back.
  useEffect(() => {
    const box = rulesBox.current;
    if (!box) return;
    if (rulesOf && !box.open) box.showModal();
    if (!rulesOf && box.open) box.close();
  }, [rulesOf]);
  // Which picture the window shows. Null is "not chosen", and the document then decides: an
  // assessment that recorded a placement or a link opens on the relationship picture, an older
  // one that recorded neither opens on the type picture, because a graph of unconnected plates in
  // one region band says less than the type picture does. Unlike the filter this may outlive the
  // window: it is visible state, the pressed button says which view is up.
  const [chosenView, setChosenView] = useState<"graph" | "types" | null>(null);
  if (!facets || !graph || !wholeGraph) return null;
  /**
   * Whether this policy gets a window at all.
   *
   * It used to be "is this one of three named policies". It is now a question about the ASSESSMENT:
   * a policy whose actions reach a resource has a picture, and so does one whose lookup failed -
   * there the empty picture is a fact about the assessment rather than about the policy, which is
   * the sentence inside. A policy that reaches nothing, on an assessment that enumerated fine, gets
   * no button: the group list above already says it reaches nothing, and an empty box would say it
   * a second time less clearly.
   *
   * The three policies with a spec keep their window either way - their type picture draws the
   * canonical frames whether or not a row landed in them, and that was true before this.
   */
  if (wholeGraph.empty && enumerated && !spec) return null;
  /**
   * Which picture is up.
   *
   * The relationship picture is drawn for every policy; the 유형별 자리 picture only where a spec
   * says where each type belongs. So the fallback inverted: it used to be "types unless the graph
   * is informative", and a policy with no spec has no types picture to fall back TO.
   */
  const typed = !!(spec && scene && whole);
  const view: "graph" | "types" = typed
    ? (chosenView ?? (wholeGraph.informative ? "graph" : "types")) : "graph";
  /**
   * What the window calls what it draws.
   *
   * 「EC2 자원」 for a policy whose spec names a service, plain 「자원」 for one without. A heading
   * that named a service over a picture spanning four of them would be the heading lying about the
   * picture - and for AdministratorAccess there is no service to name.
   */
  const subject = spec ? `${spec.words.title} 자원` : "자원";
  /** The edge kinds this picture actually draws, in KIND_LABEL's order. The legend shows these. */
  const drawnKinds = (Object.keys(KIND_LABEL) as EdgeKind[])
    .filter((kind) => graph.edges.some((e) => e.kind === kind));
  /**
   * What a double click opens IN THIS PICTURE, as the halves of one sentence.
   *
   * Off the plates rather than off the counts: a plate opens what it itself holds, so a scene of
   * closed instance boxes with no interfaces recorded, or of groups whose rules this assessment
   * never read, has nothing to promise and says nothing. Read from the drawn scene, so the
   * sentence follows the type checkboxes - switch the instances off and it stops mentioning them.
   */
  const holders = [
    graph.nodes.some((n) => n.box && n.holds > 0)
      && "인스턴스는 상자가 펼쳐지며 안의 네트워크 인터페이스가 나온다.",
    graph.nodes.some((n) => n.ruleCount > 0)
      && "보안 그룹은 규칙 표가 그림 위에 뜬다.",
  ].filter((x): x is string => typeof x === "string");
  /**
   * The line beside the closed button, off the UNFILTERED scene.
   *
   * The type scene where there is one, because that is the picture the button opens on for those
   * policies and the line counts what it draws. The relationship scene otherwise - its `omitted`
   * is rows the assessment counted and does not carry, which is what makes the count a floor there
   * exactly as `truncated` does above.
   */
  const summary = whole
    ? { kinds: whole.kinds, measured: whole.measured, regions: whole.regions,
        floor: whole.truncated, unslotted: whole.unslotted.length }
    : { kinds: wholeGraph.kinds, measured: wholeGraph.measured, regions: wholeGraph.regions,
        floor: wholeGraph.omitted.length > 0, unslotted: 0 };

  // Read off the UNFILTERED scene. The line beside a closed button says what the policy reaches;
  // a filter set inside the window is a property of the window, and letting it change this line
  // would make the panel disagree with itself for a reason nobody can see.
  //
  // A truncated enumeration makes the region list a floor exactly as it makes the count one, and
  // this line carried 이상 on the count while stating the regions flat.
  const floor = summary.floor ? " 이상" : "";
  const regionLabel = summary.regions.length === 0 ? "리전 없음"
    : summary.regions.length === 1 ? `리전 ${summary.regions[0]}${floor}`
      : `리전 ${summary.regions.length}곳${floor}`;

  return (
    <div className="topology-launch">
      <button
        type="button"
        aria-label={`${name}이 닿는 자원의 구성도 보기`}
        onClick={() => dialog.current?.showModal()}
      >
        구성도 보기
      </button>
      <span className="muted small">
        {subject} {summary.kinds}종 · {summary.measured.toLocaleString()}개
        {summary.floor && " 이상"} · {regionLabel}
        {summary.unslotted > 0 && ` · 자리 없는 유형 ${summary.unslotted}종`}
        {/* Off the UNFILTERED graph, for the reason the line above reads the unfiltered scene. A
            spent line budget makes the count a floor, the same way truncation does above. */}
        {wholeGraph?.informative && ` · 연결 ${wholeGraph.counts.edges.toLocaleString()}개`}
        {wholeGraph?.informative && wholeGraph.counts.droppedEdgeTotal > 0 && " 이상"}
      </span>

      {/* The click that closes this is decided by COORDINATES and not by identity. e.target is the
          dialog itself for a click on the dialog's own scrollbar, and for a mouseup outside it
          after a mousedown within - so dragging the scrollbar, or selecting a row in the table and
          releasing past the edge, closed the window. The rect test asks the question the reader is
          actually asking: did the pointer land outside the box. */}
      <dialog
        ref={dialog}
        className="policy-dialog topology-dialog"
        aria-labelledby={`${uid}-h`}
        aria-describedby={`${uid}-c`}
        onClose={() => setFilter(empty)}
        onClick={(e) => {
          const box = dialog.current;
          if (!box || e.target !== box) return;
          const r = box.getBoundingClientRect();
          const inside = e.clientX >= r.left && e.clientX <= r.right
            && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) box.close();
        }}
      >
        <div className="policy-dialog-body">
          <h4 id={`${uid}-h`}>
            이 정책이 닿는 {subject}의 {view === "graph" ? "연결 관계도" : "구성도"}{" "}
            <span className="muted">— <code>{name}</code></span>
          </h4>

          {/* The switch, offered only when the spec has both pictures. Two pressed/unpressed
              buttons rather than a tab strip: the pictures share the filter bar, the notes and the
              닫기 row, so they are two views of one window and not two panels. */}
          {typed && (
            <div className="topology-views" role="group" aria-label="그림 종류">
              <button type="button" aria-pressed={view === "graph"}
                      onClick={() => setChosenView("graph")}>
                연결 관계
              </button>
              <button type="button" aria-pressed={view === "types"}
                      onClick={() => setChosenView("types")}>
                유형별 자리
              </button>
              <span className="muted small">
                {view === "graph"
                  ? "자원 하나가 판 하나이고, 조회기가 읽은 연결 하나가 선 하나다."
                  : "유형 하나가 판 하나이고, 그 유형이 놓이는 자리에 있다. 실제 값은 개수뿐이다."}
              </span>
            </div>
          )}

          {/* ABOVE the picture and OUTSIDE the scrolling region below, so these two cannot scroll
              away from what they qualify. A caveat that scrolls off is a caveat somebody
              screenshots without - and showModal() focuses this rather than the first checkbox in
              the filter bar, so a screen reader reaches the caveats before the controls. */}
          <div className="topology-caveats" id={`${uid}-c`} tabIndex={-1} autoFocus>
            {/* The relationship picture's one caveat. Everything in it was read off a resource -
                which is the claim - so what has to be said is what "read" covers and what a
                missing line means. */}
            {view === "graph" && graph && (
              <p className="muted small">
                이 그림은 자원 하나를 판 하나로 그리고,{" "}
                <strong>조회기가 자원마다 읽은 연결</strong>을 선으로 잇는다 — 인스턴스에 붙은
                네트워크 인터페이스·볼륨·보안 그룹·AMI, 서브넷에 붙은 라우팅 테이블과 네트워크 ACL과
                엔드포인트, 라우팅 테이블의 경로가 가리키는 게이트웨이, 한 보안 그룹이 규칙으로
                지목한 다른 보안 그룹. 테두리는{" "}
                <strong>자원이 자기 자리라고 답한 VPC·가용 영역·서브넷</strong>이다.{" "}
                선이 없다고 연결이 없다는 뜻은 아니다 — 조회기는 위의 연결만 읽고, 상대가 이 평가에
                없는 연결은 그림 밖으로 나간 것으로 센다.{" "}
                <strong>무엇이 무엇과 통신하는지는 여전히 답하지 않는다</strong> — 인스턴스에서
                보안 그룹으로 가는 선은 소속이고, 그룹과 그룹 사이의 <strong>화살표</strong>는
                규칙이 허용하는 방향이지 오간 트래픽을 본 것이 아니다.
              </p>
            )}
            {view === "types" && scene && spec && (
              <>
            <p className="muted small">
              이 그림은 자원을{" "}
              <strong>유형에 따라 {spec.words.title} 구성에서 놓이는 자리</strong>에 놓은 것이다.
              어느 자원이 정확히 어디에 있는지는 이 평가가 유형 단위로 답하는 질문이 아니다 —
              그래서 이 그림은 그것을 말하지 않는다.{" "}
              <strong>
                테두리의 포함 관계는 측정한 것이 아니라 {spec.words.title}의 일반적인 구성이다.
              </strong>
            </p>
            {/* The second paragraph differs per picture, because what each one measured differs.
                EC2 measured nothing beyond the account and the region; Lambda and ECS have a VPC
                frame whose count came from a real service call, and a reader must not read that
                number as "these functions are in this VPC". */}
            {scene.kind === "ec2" && (
              <p className="muted small">
                자원마다 실제 값인 것은 <strong>계정과 리전과 개수</strong>뿐이다. 가용 영역은
                평가에 없어서 테두리만 그리고 개수를 적지 않는다. 개수는{" "}
                <strong>리전을 합친 수</strong>다 — 리전별로 보려면 위의 자원 목록에 리전마다
                관리콘솔 링크가 있다. 자원끼리의 연결선은 그리지 않는다 — 그것은 「연결 관계」
                그림의 일이다. 무엇이 무엇과 통신하는지는 두 그림 모두 답하지 않는다.
              </p>
            )}
            {scene.kind === "lambda" && (
              <p className="muted small">
                자원마다 실제 값인 것은 <strong>계정과 리전과 개수</strong>뿐이다. VPC 테두리는
                조회기가 함수마다 <code>VpcConfig</code>를 읽어 확인한 것이고,{" "}
                <strong>그 안에는 아무것도 그리지 않는다</strong> — 어느 함수가 그 VPC에 있는지는 이
                그림이 말하지 않는다. VPC에 붙지 않은 함수가 보통이고 그것은 조회 실패가 아니다.
                개수는 <strong>리전을 합친 수</strong>다. 자원끼리의 연결선은 그리지 않는다.
              </p>
            )}
            {scene.kind === "ecs" && (
              <p className="muted small">
                자원마다 실제 값인 것은 <strong>계정과 리전과 개수</strong>뿐이다.{" "}
                <strong>클러스터와 VPC는 나란히 그린다</strong> — 클러스터는 리전 단위의 묶음이고
                VPC에 속하지 않으며, VPC도 클러스터에 속하지 않는다. VPC 테두리는 조회기가 서비스의
                awsvpc 서브넷을 읽어 확인한 것이고 그 안에는 아무것도 그리지 않는다. 태스크는
                조회하지 않는다 — 태스크의 서브넷은 모델이 이름을 정해 두지 않은 자리에 들어 있어서,
                읽어 오면 못 읽은 것과 구별되지 않는다. 개수는 <strong>리전을 합친 수</strong>다.
              </p>
            )}
              </>
            )}
          </div>

          <div className="topology-scroll">
          {/* The lookup failed, so the empty picture below is a fact about this assessment and
              not about the policy. The panel says this in a banner - which this window covers. */}
          {!enumerated && (
            <p className="error">
              이 평가는 <strong>{subject} 조회에 실패했다.</strong> 아래 그림이 비어 있는 것은 이
              정책이 닿는 자원이 없다는 뜻이 아니라 세어 보지 못했다는 뜻이다.
            </p>
          )}

          {/* Types first and places second: which LAYERS are on is the question a reader answers
              once on opening, and which place they want is the one they answer repeatedly. Read
              off the UNFILTERED scene so a type switched off is still in the list to switch on. */}
          <TypePicker types={wholeGraph.types} hidden={filter.hiddenTypes ?? []}
                      onChange={(next) => setFilter({ ...filter, hiddenTypes: next })} />
          <FilterBar facets={facets} filter={filter} onChange={setFilter} />

          {/* What the placement lookup did NOT answer, one sentence per reason, and only the
              reasons that actually occurred. Summing them would make a denied permission and a
              spent budget the same news; leaving them out would make either of them look like
              "AWS says these are in no VPC", which is the one thing they are not. */}
          {scene && <UnmeasuredNote unmeasured={scene.unmeasured} />}

          {/* What the filter took away, in the picture's own units. An approver who narrows and
              then reads a small number has to be able to tell "this policy reaches little" from
              "I am looking at part of it", and the picture alone cannot say which. */}
          {/* 「고른 조건만」 was the old wording and it is wrong now that two types are off by
              DEFAULT: nobody chose those. What the sentence has to say either way is that the
              count under the picture is not the count of what the policy reaches. */}
          {graph.narrowed && (
            <p className="warn-inline">
              지금 그림에 있는 것은 일부다 — {subject} {(scene ?? graph).kinds}종{" "}
              {(scene ?? graph).measured.toLocaleString()}개.
              좁히지 않으면 {summary.kinds}종 {summary.measured.toLocaleString()}개다.
              {graph.counts.hiddenRows > 0
                && ` 유형 체크를 풀어 감춘 것이 ${graph.counts.hiddenRows.toLocaleString()}개 있다.`}
              {(scene ?? graph).empty && " 고른 조건에 맞는 자원이 없어서 계정과 리전 테두리만 남았다."}
            </p>
          )}

          {view === "graph" && graph && (
            <>
              {/* The picture and the panel side by side: clicking a plate must not scroll the
                  thing you clicked out of view, which is what a panel below the figure does on a
                  tall scene. The panel is the picture's equal here, as the table is below. */}
              <div className="graph-with-panel">
                <div className="topology-figure" tabIndex={0} role="group" aria-label="자원 연결 관계도">
                  <GraphFigure scene={graph} name={name} title={spec?.words.title ?? ""} uid={uid}
                               onToggle={toggle} onSelect={setChosen} onRules={setOpenRules}
                               selected={chosen} marks={marks} />
                </div>
                {facts && (
                  <ResourcePanel facts={facts} ran={analysed}
                                 onClose={() => setChosen(null)}
                                 onOpenFinding={setOpenCard}
                                 onOpenRules={() => setOpenRules(facts.arn)} />
                )}
              </div>
              {!facts && (
                <p className="muted small">
                  자원 판을 <strong>한 번 누르면</strong> 그 자원 하나에 대해서만 —{" "}
                  <strong>이 정책이 그 자원에 허용하는 작업</strong>과{" "}
                  <strong>정책 기반 분석·AI 분석이 그 자원에 대해 찾은 것</strong>이 옆에 열리고,
                  {" "}<strong>그 자원에 닿는 선이 판 테두리와 같은 색으로 바뀐다</strong> — 무엇과
                  이어져 있는지 선을 따라가지 않고 본다.
                  {/* The second half only where there is something to open. Built from the kinds
                      this picture actually has: a scene of buckets holds neither, and a sentence
                      promising a fold that is not there is worse than no sentence. */}
                  {holders.length > 0 && (
                    <>
                      {" "}<strong>두 번 누르면</strong> 그 자원이 품고 있는 것이 열린다 —{" "}
                      {holders.join(" ")}
                    </>
                  )}
                  {found.length > 0 && marks.size > 0
                    && ` 발견이 지목한 자원 ${marks.size}개에는 판 모서리에 점을 찍었다.`}
                </p>
              )}

              <ul className="topology-legend">
                <li>
                  <strong>실선 테두리</strong> — 조회기가 기록한 소속이다. 계정·리전·VPC·가용
                  영역·서브넷, 자원마다 <code>VpcId</code>·<code>SubnetId</code>·가용 영역으로 읽었다.
                </li>
                {graph.containers.some((c) => c.dashed) && (
                  <li>
                    <strong>점선인 테두리</strong> — 자원들이 자기 자리라고 답했지만 그 VPC나 서브넷
                    자체는 이 평가에 없거나, 가용 영역을 읽지 못한 서브넷이다. 안의 자원은 실제
                    값이고 테두리만 빌린 것이다.
                  </li>
                )}
                <li>
                  <strong>자리</strong> — 인터넷 게이트웨이는 VPC 위쪽 가운데에, 라우팅 테이블·네트워크
                  ACL·엔드포인트는 가운데 열에, 가용 영역은 그 좌우에 같은 수로 놓는다. 보안 그룹과
                  나머지는 그 위에 좌우로 번갈아 놓는다. 자리는 그리는 규칙이고, 소속은 테두리다.
                </li>
                {graph.containers.some((c) => c.kind === "subnet") && (
                <li>
                  <strong>서브넷의 줄</strong> — 퍼블릭 서브넷이 위, 색이 없는 것이 가운데,
                  프라이빗이 아래다. 위쪽이 <strong>인터넷 게이트웨이와 가까운 쪽</strong>이고,
                  가용 영역이 좌우로 놓이므로 퍼블릭은 상단 좌우에 프라이빗은 하단 좌우에 온다.
                  줄은 가용 영역을 가로질러 맞춘다 — 한쪽 영역이 더 높아도 프라이빗 줄이 퍼블릭
                  옆으로 올라오지 않는다. <strong>서브넷은 여전히 자기 가용 영역 안에 있다</strong>:
                  줄은 그리는 규칙이고, 무엇인지는 이름 옆 띠가 말한다.
                </li>
                )}
                {graph.nodes.some((n) => n.box) && (
                <li>
                  <strong>인스턴스 상자</strong> — <strong>두 번 누르면</strong> 붙은 네트워크
                  인터페이스가 안에 펼쳐지고, 다시 두 번 누르면 접힌다. 한 번 누르는 것은 그
                  인스턴스 하나의 상세를 여는 것이고 상자는 그대로다. 접혀 있어도 아래 표에는
                  인터페이스가 「인스턴스 안」으로 있다.{" "}
                  보안 그룹 선은 인터페이스가 아니라 인스턴스 상자로 향한다 — 인스턴스의 그룹은 그
                  인터페이스의 그룹이고, 펼치든 접든 선은 같다. 인터페이스가 이 평가에 없으면 상자는
                  비어 있고 그렇다고 적는다. 볼륨은 상자 아래에 선으로 붙는다 — 부착이지 포함이 아니다.
                </li>
                )}
                {/* Both subnet lines together: they explain the same two marks - the colour and the
                    table printed beside the name - and neither mark exists in a picture with no
                    subnet in it. This file's own banner is the rule: a legend that explains marks
                    the reader cannot see teaches them to skim it, and every policy draws this
                    picture now, so most of them have no subnet. */}
                {graph.containers.some((c) => c.kind === "subnet") && (
                <>
                <li>
                  <strong>연한 하늘색 서브넷</strong> — 퍼블릭: 연결된 라우팅 테이블의{" "}
                  <strong>기본 경로(0.0.0.0/0 · ::/0)가 <code>igw-</code>로 간다.</strong>{" "}
                  <strong>연한 초록 서브넷</strong> — 프라이빗: 기본 경로가 없거나 다른 곳으로 간다.
                  좁은 대역만 게이트웨이로 보내는 표는 퍼블릭이 아니고, <code>eigw-</code>는 IPv6
                  송신 전용이라 퍼블릭이 아니다. 색이 없으면 이 평가에 그 서브넷의 라우팅 테이블이
                  없다는 뜻이다.
                </li>
                <li>
                  <strong>서브넷 이름 옆의 라우팅 테이블</strong> — 그 서브넷이 연결된 표와, 색의
                  근거가 된 기본 경로다. 명시적 연결이 없으면 VPC의 기본 테이블이고, 선은 촘촘한
                  점선으로 그린다. 표를 누르면 경로 전부를 볼 수 있다.{" "}
                  <code>(경로 미기록)</code>이라고 적혀 있으면 조회기가 경로를 기록하기 전의
                  평가여서 「게이트웨이 경로가 하나라도 있는가」로 판단한 것이다 — 퍼블릭을 실제보다
                  넓게 잡는다. 다시 조회하면 사라진다.
                </li>
                </>
                )}
                {/* The swatches are the kinds ACTUALLY DRAWN. Six colours over a picture holding
                    two of them is five sentences about nothing, and the reader has no way to tell
                    which of the six they are looking at. */}
                {drawnKinds.length > 0 && (
                <li>
                  <strong>연결선</strong> — 전부 점선이고, 상자의 변에서 나와 직각으로만 꺾인다.
                  종류마다 색이 다르다.{" "}
                  {drawnKinds.map((kind) => (
                    <span key={kind} className="graph-legend-item">
                      <svg className="graph-legend-swatch" width="28" height="8" aria-hidden="true">
                        <line className={`graph-edge graph-edge-${kind}`} x1="0" y1="4" x2="28" y2="4" />
                      </svg>
                      {KIND_LABEL[kind]}
                    </span>
                  ))}
                </li>
                )}
                {graph.counts.implicitEdges > 0 && (
                  <li>
                    <strong>촘촘한 점선</strong> — 기본 라우팅 테이블에서 도출한 연결이다. 명시적
                    연결이 없는 서브넷은 VPC의 기본 라우팅 테이블을 쓴다는 AWS의 규칙이고, 조회기가
                    그 연결을 읽은 것은 아니다. 나머지 점선은 조회기가 읽은 것이다.
                  </li>
                )}
                {graph.edges.some((e) => e.kind === "route") && (
                  <li>
                    <strong>화살표</strong> — 라우팅 테이블의 경로가 가리키는 게이트웨이다. 경로표의
                    대상이지 트래픽을 확인한 것이 아니다.
                  </li>
                )}
                {graph.edges.some((e) => e.kind === "chain") && (
                  <li>
                    <strong>보안 그룹 사이의 화살표</strong> — 한쪽 그룹의 규칙이 상대 그룹을
                    지목한 것이고, 화살표는 <strong>허용된 방향</strong>을 가리킨다. 인바운드 규칙은
                    지목한 그룹에서 이쪽으로, 아웃바운드 규칙은 이쪽에서 저쪽으로. 주소가 아니라
                    그룹이 대상이므로 그 그룹을 단 자원이 어디에 있든 허용된다 — 규칙 값은 그룹
                    판을 두 번 누르면 표로 열린다.
                  </li>
                )}
                <li>
                  <strong>민감 자원</strong> — 자원 판의 <strong>빨간 테두리</strong>와 아래 표의{" "}
                  <code>민감</code> 칸이 같은 것을 말한다. 보안 그룹 선의 색은 종류의 색이고 민감도와
                  무관하다.
                </li>
                <li>
                  <strong>선이 붙는 자리</strong> — 선은 판의 <strong>위 면 가운데</strong>와{" "}
                  <strong>아래 면 가운데</strong>, 그 두 점에만 붙는다. 위아래로 놓인 두 판을 이을
                  때는 <strong>위쪽 판의 아래 면에서 나와 아래쪽 판의 위 면으로 들어간다</strong> —
                  선이 위로 돌아 올라갔다 내려오는 일이 없으므로, 어느 판에서 나온 선인지 눈으로
                  따라가지 않아도 안다. 나란히 놓인 두 판은 위아래가 없으니 줄 위나 아래로 돈다.
                </li>
                <li>
                  <strong>고른 자원</strong> — 한 번 누른 판은 테두리가 <strong>파랑</strong>이 되고,
                  그 판에 닿는 선도 같은 파랑에 조금 굵게 그려진다. 위의 종류별 색을 덮어쓰는 것이니
                  그 동안은 선의 색이 종류를 말하지 않는다 — 굵기가 「고른 것」이라는 표시다. 점선의
                  촘촘함은 그대로라, 도출한 연결은 고른 뒤에도 도출한 연결로 보인다.
                </li>
                {(graph.overflow.length > 0 || graph.counts.droppedEdgeTotal > 0) && (
                  <li>
                    <strong>「외 N개」 판과 그리지 못한 연결</strong> — 한 그림과 한 서브넷에 놓는
                    자원 수, 한 그림에 긋는 선 수에 한도가 있다. 넘친 수는 판과 그림 아래 줄에 적혀
                    있고, 아래 표에는 그린 자원만 있다. 계정·리전·VPC·서브넷으로 좁히면 나머지가
                    보인다.
                  </li>
                )}
                <li>
                  <strong>판 위의 이름</strong> — <code>Name</code> 태그가 있으면 그것이고 그 아래가
                  ID다. 없으면 ID가 위에, 유형이 아래에 있다. 긴 ID는 가운데를 줄였고, 판 위에 마우스를
                  올리면 전체가 보인다.
                </li>
              </ul>

              <GraphTable scene={graph} />
            </>
          )}

          {view === "types" && scene && spec && (
            <>
          <div className="topology-figure" tabIndex={0} role="group" aria-label="자원 구성도">
            <Figure scene={scene} name={name} title={spec.words.title} uid={uid} />
          </div>

          <ul className="topology-legend">
            <li>
              <strong>실선 테두리</strong> — 평가가 확인한 포함 관계다. 계정과 리전, 둘뿐이다.
            </li>
            {/* Every line below the first is conditional on the picture actually drawing the mark
                it explains. A legend that describes an arrow the reader cannot see, or an Amazon
                EBS border that is not in this picture, teaches them the legend is decoration. */}
            {scene.frames.some((f) => f.dashed) && scene.kind === "ec2" && (
              <li>
                <strong>점선 테두리</strong> — EC2의 일반적인 자리다. 측정한 것이 아니다. 안에 무엇이
                들어 있든 마찬가지다. 겹쳐진 순서는 AWS의 범위다 —{" "}
                <strong>리전 ⊃ VPC ⊃ 가용 영역 ⊃ 서브넷.</strong> VPC는 리전의 모든 가용 영역에
                걸쳐 있고, 가용 영역에 속하는 것은 서브넷이다.
              </li>
            )}
            {scene.kind === "lambda" && (
              <li>
                <strong>점선 테두리</strong> — 자리를 나타낸다. VPC 테두리 위의 개수는 조회기가
                <code> lambda ListFunctions</code>로 확인한 것이지만, 그 테두리가 무엇을 담고
                있는지는 측정한 것이 아니다. 가용 영역과 서브넷 테두리는 <strong>없다</strong> —
                함수 하나가 서브넷을 최대 16개까지 쓰기 때문에, 하나의 상자에 넣으면 그중 하나를
                지목하는 것이 된다.
              </li>
            )}
            {scene.kind === "ecs" && (
              <li>
                <strong>점선 테두리</strong> — 자리를 나타낸다.{" "}
                <strong>클러스터와 VPC는 서로 포함하지 않는다</strong> — 클러스터는 리전 단위이고
                그 서비스들은 서로 다른 VPC에 있을 수 있다. 가용 영역과 서브넷 테두리는 없다.
              </li>
            )}
            {scene.kind === "ec2" && (
              <li>
                <strong>Amazon EBS 테두리</strong> — 볼륨은 <strong>가용 영역 범위</strong>여서 그
                안에 그린다. <strong>VPC에는 속하지 않는다</strong> — VPC 테두리 안에 보이는 것은
                가용 영역이 그 안에 그려지기 때문이고, 볼륨이 VPC에 속한다는 뜻이 아니다.
              </li>
            )}
            {scene.frames.some((f) => f.id === "vpc" && /배치 확인/.test(f.count ?? "")) && (
              <li>
                <strong>개수가 적힌 VPC 테두리</strong> — 조회기가 배치를 <strong>읽어서</strong>
                확인한 자원의 수다. 이 그림에서 서비스 호출로 얻은 유일한 숫자이고, 그래서
                「자원 N개」가 아니라 「N개 배치 확인」이라고 적는다.{" "}
                <strong>그 테두리 안에는 아무것도 그리지 않는다</strong> — 어느 자원인지는 이 그림이
                말하지 않고, 그 자원들이 모두 같은 VPC에 있다고도 말하지 않는다.
              </li>
            )}
            <li>
              <strong>개수가 없는 테두리</strong> — 이 정책이 닿는 자원이 그 유형에 없거나
              (<code>인벤토리에 없음</code>), 평가가 아예 세지 않는다
              (<code>가용 영역 · 평가에 없음</code>).
            </li>
            {scene.link && (
              <li>
                <strong>화살표 하나</strong> — 인터넷 게이트웨이가 VPC의 출입구라는 뜻이다.
                이 계정에서 확인한 연결이 아니다.
              </li>
            )}
            <li>
              <strong>민감 자원</strong> — 자원 판의 <strong>빨간 테두리</strong>와 빨간 개수,
              테두리 이름 옆의 <code>민감 N개</code>, 그리고 아래 표의 <code>민감</code> 칸,
              셋이 같은 것을 말한다.
              {scene.kind === "ec2" && (
                <>
                  {" "}<strong>보안 그룹 테두리의 빨강은 AWS의 그룹 색</strong>이고 민감도와
                  무관하다 — 안에 무엇이 있든 빨갛다.
                </>
              )}
            </li>
            <li>
              <strong>*</strong> 정책이 자원을 지정하지 않았다 — 지금의 개수이고 앞으로 생기는
              것도 포함한다. <strong>⚠</strong> 참조가 동작별 자원 유형을 판정하지 못해 이 서비스의
              자원 전부가 들어 있다. <strong>†</strong> 목록이 잘렸다. 개수는 <strong>하한</strong>
              이다.
            </li>
          </ul>

          {scene.truncated && (
            <p className="warn-inline">
              잘린 그룹이 있다. Resource Explorer가 한 번에 1,000개까지만 돌려주므로, 표시된
              개수와 리전 목록은 하한이다.
            </p>
          )}

          <SceneTable scene={scene} spec={spec} />
            </>
          )}

          {/* What the picture above has no plate for, per service. The two pictures leave out
              different things and say so differently: the type picture leaves out the services its
              spec does not place, and the relationship picture leaves out nothing by service - what
              it cannot show is rows the ASSESSMENT counted and does not carry, because the
              enumeration was cut. Naming either as the other would be a false reassurance. */}
          {view === "types" && scene && spec && scene.omitted.length > 0 && (
            <p className="muted small">
              그림 밖 서비스:{" "}
              {scene.omitted.map((o) => `${o.service} ${o.total.toLocaleString()}개`).join(" · ")}
              {" "}— {spec.words.omitted} 위의 표는 이 그림의 자원만 담는다.
            </p>
          )}
          {view === "graph" && graph.omitted.length > 0 && (
            <p className="muted small">
              평가가 행을 담지 않은 자원:{" "}
              {graph.omitted.map((o) => `${o.service} ${o.total.toLocaleString()}개`).join(" · ")}
              {" "}— 이 정책이 닿지만 목록이 잘려 이 그림에 판이 없다. 위의 개수는 하한이다.
            </p>
          )}
          </div>

          <div className="row">
            <button type="button" onClick={() => dialog.current?.close()}>닫기</button>
          </div>

          {/* One finding's own card, over the picture. A second modal inside the first: the reader
              came from a row in the panel and goes back to it, so the picture stays where it was
              and nothing about the window - the filter, the open boxes, the chosen resource - is
              disturbed by reading a card.

              onClose puts the state back rather than only the ESC handler doing it. The dialog can
              close three ways (ESC, the button, a click outside) and two of them do not run a
              click handler at all; without this the row that opened it would open nothing next
              time, because the state still said it was open. */}
          <dialog ref={cardBox} className="policy-dialog finding-dialog"
                  aria-label={card ? `${card.id} ${card.title}` : "발견 카드"}
                  onClose={() => setOpenCard(null)}
                  onClick={(e) => {
                    const box = cardBox.current;
                    if (!box || e.target !== box) return;
                    const r = box.getBoundingClientRect();
                    const inside = e.clientX >= r.left && e.clientX <= r.right
                      && e.clientY >= r.top && e.clientY <= r.bottom;
                    if (!inside) box.close();
                  }}>
            <div className="policy-dialog-body">
              {card && (
                <>
                  <h4>
                    위험 분석 카드 <code>{card.id}</code>{" "}
                    <span className="muted">— <code>{name}</code></span>
                  </h4>
                  {/* The analysis page's own card, with its own fold opened. `block` is null on
                      purpose: this window reads, and the 차단 button writes into the restriction
                      set the policy block below composes. A dead button here would be worse than
                      no button, and a live one would put the decision form inside a picture. */}
                  <RiskFindingCard finding={card} block={null} showAxis defaultOpen
                                   containment={containmentOf ? containmentOf(card) : "none"}
                                   resourceOf={(arn) => rows.get(arn) ?? null}
                                   accountId={accountId} />
                  <p className="muted small">
                    이 창은 읽기만 한다. <strong>이 경로를 차단</strong>하려면 아래{" "}
                    <strong>위험 및 공격 경로</strong>의 같은 카드에서 「이 경로 차단」을 누른다 —
                    제한은 결정과 함께 쓰이는 것이라 그림 안에서 쓰지 않는다.
                  </p>
                </>
              )}
              <div className="row">
                <button type="button" onClick={() => cardBox.current?.close()}>닫기</button>
              </div>
            </div>
          </dialog>

          {/* The rules table, over the picture. Same three ways out as the card - ESC, the button,
              a click outside - and the same onClose putting the state back, or the next click on
              the same group would open nothing. */}
          <dialog ref={rulesBox} className="policy-dialog rules-dialog"
                  aria-label={rulesOf ? `${rulesOf.id} 규칙` : "보안 그룹 규칙"}
                  onClose={() => setOpenRules(null)}
                  onClick={(e) => {
                    const box = rulesBox.current;
                    if (!box || e.target !== box) return;
                    const r = box.getBoundingClientRect();
                    const inside = e.clientX >= r.left && e.clientX <= r.right
                      && e.clientY >= r.top && e.clientY <= r.bottom;
                    if (!inside) box.close();
                  }}>
            <div className="policy-dialog-body">
              {rulesOf && (
                <>
                  <h4>
                    보안 그룹 규칙 {rulesOf.rules.length}개{" "}
                    <code>{rulesOf.id}</code>
                    {rulesOf.name && <span className="muted"> — {rulesOf.name}</span>}
                  </h4>
                  {rulesOf.rules.length === 0 ? (
                    <p className="muted small">
                      이 평가에는 이 그룹의 규칙이 없다 — 조회기가 규칙을 기록하기 전에 만들어진
                      평가이거나, 규칙이 하나도 없는 그룹이다. 다시 조회하면 갈린다.
                    </p>
                  ) : (
                    <RulesTable rules={rulesOf.rules} />
                  )}
                  <p className="muted small">
                    대상이 <strong>보안 그룹</strong>이면 주소가 아니라 <strong>체인</strong>이다 —
                    그 그룹을 단 자원이 어디에 있든 허용된다. 그림에서는 그룹과 그룹 사이의
                    화살표가 그 체인이고, 화살표는 트래픽이 허용된 쪽을 가리킨다. 규칙 자체는
                    그림에 판으로 그리지 않는다 — 값이 넷이라 표가 맞다.
                  </p>
                </>
              )}
              <div className="row">
                <button type="button" onClick={() => rulesBox.current?.close()}>닫기</button>
              </div>
            </div>
          </dialog>
        </div>
      </dialog>
    </div>
  );
}

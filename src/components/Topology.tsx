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

import { useId, useMemo, useRef, useState } from "react";
import type { ImpactCoverage, ImpactPolicy } from "../types";
import type {
  Facets, Frame, Link, Scene, SceneFilter, Slot, TopologySpec,
} from "../../server/topology.js";
import {
  enumeratedFor, facets as facetsOf, scene as sceneOf, sceneSummary, specOf,
} from "../../server/topology.js";
import type {
  EdgeKind, GraphContainer, GraphEdge, GraphNode, GraphOverflow, RelationScene,
} from "../../server/graph.js";
import { G_ICON, KIND_LABEL, graphSummary, relationScene } from "../../server/graph.js";

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
function GraphNodeShape({ node, onToggle }: { node: GraphNode; onToggle: (id: string) => void }) {
  // An instance: a frame holding its interfaces, which are nodes of their own painted after it.
  // The head band carries what a plate would - the glyph, the Name or the id, the other one -
  // and a closed or empty frame says in one line what it folds, or why it is empty. A frame with
  // interfaces to show is a button: a click, Enter or Space opens and closes it.
  if (node.box) {
    const openable = node.holds > 0;
    const type = node.resourceType.replace(":", "-");
    return (
      <g
        className={`graph-node graph-node-box graph-node-${type}${openable ? " graph-node-toggle" : ""}`}
        role={openable ? "button" : undefined}
        tabIndex={openable ? 0 : undefined}
        aria-expanded={node.open}
        aria-label={openable ? `${node.title.split("\n")[0]} — 네트워크 인터페이스 ${node.holds}개 ${node.open ? "접기" : "펼치기"}` : undefined}
        onClick={openable ? () => onToggle(node.id) : undefined}
        onKeyDown={openable ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(node.id); }
        } : undefined}
      >
        <rect
          className={node.sensitive ? "graph-plate graph-plate-box graph-plate-sensitive"
            : "graph-plate graph-plate-box"}
          x={node.x} y={node.y} width={node.w} height={node.h} rx={4}
        >
          <title>{node.title}</title>
        </rect>
        {node.icon && (
          <image href={`/aws-icons/${node.icon}`} x={node.x + 8} y={node.y + 5} width={18} height={18} />
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
    <g className={`graph-node graph-node-${node.resourceType.replace(":", "-")}`}>
      {node.erase && (
        <rect className="topo-erase" x={node.x} y={node.y} width={node.w} height={node.h} />
      )}
      <rect
        className={node.sensitive ? "graph-plate graph-plate-sensitive" : "graph-plate"}
        x={node.x} y={node.y} width={node.w} height={node.h} rx={4}
      >
        <title>{node.title}</title>
      </rect>
      {node.icon ? (
        <image href={`/aws-icons/${node.icon}`} x={node.x + (node.w - G_ICON) / 2} y={node.y + 6}
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
 * rather than read it, and with an arrowhead only on a route - the one kind that has a direction
 * (a route points at its gateway). Membership and attachment have none, and an arrowhead on them
 * would claim one.
 *
 * A ring on each end. Lines are painted under the plates, so a line can vanish under a plate it
 * does not end at and reappear on the far side; the rings are what says where it really stops.
 * The route's far end has the arrowhead instead.
 */
function GraphEdgeShape({ edge, uid }: { edge: GraphEdge; uid: string }) {
  const kind = `graph-edge graph-edge-${edge.kind}`;
  const cls = `${kind}${edge.implicit ? " graph-edge-implicit" : ""}`;
  return (
    <g>
      <polyline
        className={cls}
        points={edge.points.map((p) => `${p.x},${p.y}`).join(" ")}
        markerEnd={edge.kind === "route" ? `url(#${uid}-ga)` : undefined}
      >
        <title>{edge.title}</title>
      </polyline>
      <circle className={`${kind} graph-edge-end`} cx={edge.x1} cy={edge.y1} r={2.5} />
      {edge.kind !== "route" && (
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
function GraphFigure({ scene, name, title, uid, onToggle }:
                     { scene: RelationScene; name: string; title: string; uid: string;
                       onToggle: (id: string) => void }) {
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
      </defs>
      <rect className="topo-ground" x={0} y={0} width={scene.width} height={scene.height} />
      {scene.containers.map((c) => <GraphContainerShape key={c.id} box={c} />)}
      {scene.edges.map((e) => (
        <GraphEdgeShape key={`${e.kind}|${e.from}|${e.to}`} edge={e} uid={uid} />
      ))}
      {scene.containers.map((c) => <GraphContainerLabel key={c.id} box={c} />)}
      {scene.overflow.map((o) => <GraphOverflowShape key={o.container} plate={o} />)}
      {/* Boxes before plates, so an interface is painted over the instance frame that holds it. */}
      {scene.nodes.filter((n) => n.box).map((n) => <GraphNodeShape key={n.id} node={n} onToggle={onToggle} />)}
      {scene.nodes.filter((n) => !n.box).map((n) => <GraphNodeShape key={n.id} node={n} onToggle={onToggle} />)}
      {scene.foot.map((line) => (
        <text className="topo-foot" key={line.text} x={8} y={line.y}>{line.text}</text>
      ))}
    </svg>
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
function FilterBar({ facets, filter, spec, onChange }: {
  facets: Facets;
  filter: SceneFilter;
  spec: TopologySpec;
  onChange: (next: SceneFilter) => void;
}) {
  /** One dimension, rendered only when the picture offers it and the data filled it. */
  const dimension = (id: keyof SceneFilter, label: string) => {
    const values = facets[id as "accounts"] ?? [];
    if (!spec.dimensions.includes(id) || values.length === 0) return null;
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
      {spec.multiSubnet && facets.subnets.length > 0 && (
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
export function PolicyTopology({ policy, name, accountId, coverage }: {
  policy: ImpactPolicy;
  /** The policy as a person names it - policyName(identifier). */
  name: string;
  accountId: string;
  /** The assessment's own record of what it managed to enumerate. An empty picture and a failed
   *  EC2 lookup are the same document shape and opposite news, and this is what tells them apart. */
  coverage: ImpactCoverage | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const uid = useId();
  const empty: SceneFilter = { accounts: [], regions: [], vpcs: [], subnets: [] };
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
  // Which picture the window shows. Null is "not chosen", and the document then decides: an
  // assessment that recorded a placement or a link opens on the relationship picture, an older
  // one that recorded neither opens on the type picture, because a graph of unconnected plates in
  // one region band says less than the type picture does. Unlike the filter this may outlive the
  // window: it is visible state, the pressed button says which view is up.
  const [chosenView, setChosenView] = useState<"graph" | "types" | null>(null);
  if (!scene || !whole || !facets || !spec) return null;
  const view: "graph" | "types" = graph && wholeGraph
    ? (chosenView ?? (wholeGraph.informative ? "graph" : "types")) : "types";

  // Read off the UNFILTERED scene. The line beside a closed button says what the policy reaches;
  // a filter set inside the window is a property of the window, and letting it change this line
  // would make the panel disagree with itself for a reason nobody can see.
  //
  // A truncated enumeration makes the region list a floor exactly as it makes the count one, and
  // this line carried 이상 on the count while stating the regions flat.
  const floor = whole.truncated ? " 이상" : "";
  const regionLabel = whole.regions.length === 0 ? "리전 없음"
    : whole.regions.length === 1 ? `리전 ${whole.regions[0]}${floor}`
      : `리전 ${whole.regions.length}곳${floor}`;

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
        {spec.words.title} 자원 {whole.kinds}종 · {whole.measured.toLocaleString()}개
        {whole.truncated && " 이상"} · {regionLabel}
        {whole.unslotted.length > 0 && ` · 자리 없는 유형 ${whole.unslotted.length}종`}
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
            이 정책이 닿는 {spec.words.title} 자원의 {view === "graph" ? "연결 관계도" : "구성도"}{" "}
            <span className="muted">— <code>{name}</code></span>
          </h4>

          {/* The switch, offered only when the spec has both pictures. Two pressed/unpressed
              buttons rather than a tab strip: the pictures share the filter bar, the notes and the
              닫기 row, so they are two views of one window and not two panels. */}
          {graph && wholeGraph && (
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
                엔드포인트, 라우팅 테이블의 경로가 가리키는 게이트웨이. 테두리는{" "}
                <strong>자원이 자기 자리라고 답한 VPC·가용 영역·서브넷</strong>이다.{" "}
                선이 없다고 연결이 없다는 뜻은 아니다 — 조회기는 위의 연결만 읽고, 상대가 이 평가에
                없는 연결은 그림 밖으로 나간 것으로 센다. 무엇이 무엇과 통신하는지는 여전히 답하지
                않는다 — 보안 그룹 선은 규칙이 아니라 소속이다.
              </p>
            )}
            {view === "types" && (
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
          {!scene.enumerated && (
            <p className="error">
              이 평가는 <strong>{spec.words.title} 자원 조회에 실패했다.</strong> 아래 그림이 비어 있는 것은 이
              정책이 닿는 자원이 없다는 뜻이 아니라 세어 보지 못했다는 뜻이다.
            </p>
          )}

          <FilterBar facets={facets} filter={filter} spec={spec} onChange={setFilter} />

          {/* What the placement lookup did NOT answer, one sentence per reason, and only the
              reasons that actually occurred. Summing them would make a denied permission and a
              spent budget the same news; leaving them out would make either of them look like
              "AWS says these are in no VPC", which is the one thing they are not. */}
          <UnmeasuredNote unmeasured={scene.unmeasured} />

          {/* What the filter took away, in the picture's own units. An approver who narrows and
              then reads a small number has to be able to tell "this policy reaches little" from
              "I am looking at part of it", and the picture alone cannot say which. */}
          {scene.narrowed && (
            <p className="warn-inline">
              고른 조건만 그렸다 — {spec.words.title} 자원 {scene.kinds}종{" "}
              {scene.measured.toLocaleString()}개.
              조건 없이는 {whole.kinds}종 {whole.measured.toLocaleString()}개다.
              {scene.empty && " 고른 조건에 맞는 자원이 없어서 계정과 리전 테두리만 남았다."}
            </p>
          )}

          {view === "graph" && graph && (
            <>
              <div className="topology-figure" tabIndex={0} role="group" aria-label="자원 연결 관계도">
                <GraphFigure scene={graph} name={name} title={spec.words.title} uid={uid} onToggle={toggle} />
              </div>

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
                <li>
                  <strong>인스턴스 상자</strong> — 누르면 붙은 네트워크 인터페이스가 안에 펼쳐지고, 다시
                  누르면 접힌다. 접혀 있어도 아래 표에는 인터페이스가 「인스턴스 안」으로 있다.{" "}
                  보안 그룹 선은 인터페이스가 아니라 인스턴스 상자로 향한다 — 인스턴스의 그룹은 그
                  인터페이스의 그룹이고, 펼치든 접든 선은 같다. 인터페이스가 이 평가에 없으면 상자는
                  비어 있고 그렇다고 적는다. 볼륨은 상자 아래에 선으로 붙는다 — 부착이지 포함이 아니다.
                </li>
                <li>
                  <strong>연한 하늘색 서브넷</strong> — 퍼블릭: 연결된 라우팅 테이블(명시적 연결이
                  없으면 VPC의 기본 테이블)에 인터넷 게이트웨이로 가는 경로가 있다.{" "}
                  <strong>연한 초록 서브넷</strong> — 프라이빗: 그 경로가 없다. 색이 없으면 이 평가에
                  그 서브넷의 라우팅 테이블이 없다.
                </li>
                <li>
                  <strong>연결선</strong> — 전부 점선이고, 상자의 변에서 나와 직각으로만 꺾인다.
                  종류마다 색이 다르다.{" "}
                  {(Object.keys(KIND_LABEL) as EdgeKind[]).map((kind) => (
                    <span key={kind} className="graph-legend-item">
                      <svg className="graph-legend-swatch" width="28" height="8" aria-hidden="true">
                        <line className={`graph-edge graph-edge-${kind}`} x1="0" y1="4" x2="28" y2="4" />
                      </svg>
                      {KIND_LABEL[kind]}
                    </span>
                  ))}
                </li>
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
                <li>
                  <strong>민감 자원</strong> — 자원 판의 <strong>빨간 테두리</strong>와 아래 표의{" "}
                  <code>민감</code> 칸이 같은 것을 말한다. 보안 그룹 선의 색은 종류의 색이고 민감도와
                  무관하다.
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

          {view === "types" && (
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

          {scene.omitted.length > 0 && (
            <p className="muted small">
              그림 밖 서비스:{" "}
              {scene.omitted.map((o) => `${o.service} ${o.total.toLocaleString()}개`).join(" · ")}
              {" "}— {spec.words.omitted} 위의 표는 이 그림의 자원만 담는다.
            </p>
          )}
          </div>

          <div className="row">
            <button type="button" onClick={() => dialog.current?.close()}>닫기</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

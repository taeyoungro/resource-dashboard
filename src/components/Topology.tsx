// "구성도 보기" - the impact assessment as a picture instead of a list.
//
// A list of thirty resource types with counts beside them is a true answer nobody reads, and that
// is the complaint this exists to answer. The difficulty of a picture is that it says more than a
// list does: putting an instance inside a security group inside a subnet inside a VPC claims four
// things, and this assessment measured none of them. So every sentence in here is arranged around
// keeping the picture honest about what it is - see the two caveat paragraphs, the legend's
// solid/dashed grammar, and the caption drawn inside the viewBox so it survives a screenshot.
//
// THIS FILE COMPUTES NOTHING. Every coordinate, every count, every label comes out of
// server/ec2Topology.js, which is plain JS with unit tests behind it. What is here is three .maps
// and a conditional. That split is deliberate: geometry that decides whether a slot escapes its
// frame - a picture that lies about containment while every sentence above it says the opposite -
// is exactly the thing a source-text test cannot catch and a unit test can.
//
// It also never renders ServiceIcon. resourceIconPath('ec2', …) never returns null: it falls
// through to the service icon, so a type with no glyph of its own would draw the Amazon-EC2 tile.
// In the panel's list that is decoration; here an EC2 tile inside the 보안 그룹 frame is a
// placement claim about key pairs.

import { useId, useMemo, useRef, useState } from "react";
import type { ImpactCoverage, ImpactPolicy } from "../types";
import type { Facets, Frame, Link, Scene, SceneFilter, Slot } from "../../server/ec2Topology.js";
import {
  FRAME_LABEL, ec2Enumerated, ec2Scene, facets as facetsOf, sceneSummary,
} from "../../server/ec2Topology.js";

/**
 * One frame: the box, its badge, and a label band of up to three parts.
 *
 * The class carries the frame id, so a frame added to EC2_FRAMES gets `.topo-frame-<id>` with no
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
function Figure({ scene, name, uid }: { scene: Scene; name: string; uid: string }) {
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
      <title id={`${uid}-t`}>{`${name}이 닿는 EC2 자원 구성도`}</title>
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
function SceneTable({ scene }: { scene: Scene }) {
  // FRAME_LABEL comes from the module rather than from a copy here. The copy was byte-identical
  // until somebody added a frame, at which point the 자리 column printed the raw id while the
  // drawing beside it printed the Korean name - and this file's own banner says it computes
  // nothing, which a second table of labels quietly made untrue.
  const place = (row: Scene["rows"][number]) => {
    if (!row.frame) return <td className="none">없음</td>;
    return <td>{FRAME_LABEL[row.frame] ?? row.frame}</td>;
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
function FilterBar({ facets, filter, onChange }: {
  facets: Facets;
  filter: SceneFilter;
  onChange: (next: SceneFilter) => void;
}) {
  return (
    <div className="topology-filter">
      {facets.accounts.length > 0 && (
        <FacetPicker
          label="계정"
          values={facets.accounts}
          chosen={filter.accounts ?? []}
          onChange={(accounts) => onChange({ ...filter, accounts })}
        />
      )}
      <FacetPicker
        label="리전"
        values={facets.regions}
        chosen={filter.regions ?? []}
        onChange={(regions) => onChange({ ...filter, regions })}
      />
      {facets.vpcs.length > 0 && (
        <FacetPicker
          label="VPC"
          values={facets.vpcs}
          chosen={filter.vpcs ?? []}
          onChange={(vpcs) => onChange({ ...filter, vpcs })}
        />
      )}
      {facets.subnets.length > 0 && (
        <FacetPicker
          label="서브넷"
          values={facets.subnets}
          chosen={filter.subnets ?? []}
          onChange={(subnets) => onChange({ ...filter, subnets })}
        />
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
 * The button, the closed-state summary beside it, and the window.
 *
 * The GATE LIVES HERE, not in Impact.tsx: this returns null when ec2Scene() returns null, so the
 * string AmazonEC2FullAccess never appears in a 1,722-line file where nobody would find it, and
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
  const enumerated = ec2Enumerated(coverage);
  const facets = useMemo(() => facetsOf(policy), [policy]);
  // Unfiltered, for the closed-state summary and for the sentence that says what was narrowed away.
  const whole = useMemo(
    () => ec2Scene(policy, accountId, null, enumerated), [policy, accountId, enumerated],
  );
  const scene = useMemo(
    () => ec2Scene(policy, accountId, filter, enumerated), [policy, accountId, filter, enumerated],
  );
  if (!scene || !whole || !facets) return null;

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
        EC2 자원 {whole.kinds}종 · {whole.measured.toLocaleString()}개
        {whole.truncated && " 이상"} · {regionLabel}
        {whole.unslotted.length > 0 && ` · 자리 없는 유형 ${whole.unslotted.length}종`}
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
            이 정책이 닿는 EC2 자원의 구성도 <span className="muted">— <code>{name}</code></span>
          </h4>

          {/* ABOVE the picture and OUTSIDE the scrolling region below, so these two cannot scroll
              away from what they qualify. A caveat that scrolls off is a caveat somebody
              screenshots without - and showModal() focuses this rather than the first checkbox in
              the filter bar, so a screen reader reaches the caveats before the controls. */}
          <div className="topology-caveats" id={`${uid}-c`} tabIndex={-1} autoFocus>
            <p className="muted small">
              이 그림은 자원을 <strong>유형에 따라 EC2 구성에서 놓이는 자리</strong>에 놓은 것이다.
              어느 인스턴스가 어느 서브넷에 있는지, 어느 볼륨이 어느 인스턴스에 붙어 있는지는 이
              평가에 들어 있지 않다 — 그래서 이 그림은 그것을 말하지 않는다.{" "}
              <strong>테두리의 포함 관계는 측정한 것이 아니라 EC2의 일반적인 구성이다.</strong>
            </p>
            <p className="muted small">
              자원마다 실제 값인 것은 <strong>계정과 리전과 개수</strong>뿐이다. 가용 영역은 평가에
              없어서 테두리만 그리고 개수를 적지 않는다. 개수는 <strong>리전을 합친 수</strong>다 —
              리전별로 보려면 위의 자원 목록에 리전마다 관리콘솔 링크가 있다. 자원끼리의 연결선은
              그리지 않는다. 무엇이 무엇과 통신하는지는 이 평가가 답하지 않는 질문이다.
            </p>
          </div>

          <div className="topology-scroll">
          {/* The EC2 lookup failed, so the empty picture below is a fact about this assessment and
              not about the policy. The panel says this in a banner - which this window covers. */}
          {!scene.enumerated && (
            <p className="error">
              이 평가는 <strong>EC2 자원 조회에 실패했다.</strong> 아래 그림이 비어 있는 것은 이
              정책이 닿는 자원이 없다는 뜻이 아니라 세어 보지 못했다는 뜻이다.
            </p>
          )}

          <FilterBar facets={facets} filter={filter} onChange={setFilter} />

          {/* What the filter took away, in the picture's own units. An approver who narrows and
              then reads a small number has to be able to tell "this policy reaches little" from
              "I am looking at part of it", and the picture alone cannot say which. */}
          {scene.narrowed && (
            <p className="warn-inline">
              고른 조건만 그렸다 — EC2 자원 {scene.kinds}종 {scene.measured.toLocaleString()}개.
              조건 없이는 {whole.kinds}종 {whole.measured.toLocaleString()}개다.
              {scene.empty && " 고른 조건에 맞는 자원이 없어서 계정과 리전 테두리만 남았다."}
            </p>
          )}

          <div className="topology-figure" tabIndex={0} role="group" aria-label="자원 구성도">
            <Figure scene={scene} name={name} uid={uid} />
          </div>

          <ul className="topology-legend">
            <li>
              <strong>실선 테두리</strong> — 평가가 확인한 포함 관계다. 계정과 리전, 둘뿐이다.
            </li>
            <li>
              <strong>점선 테두리</strong> — EC2의 일반적인 자리다. 측정한 것이 아니다. 안에 무엇이
              들어 있든 마찬가지다. 겹쳐진 순서는 AWS의 범위다 —{" "}
              <strong>리전 ⊃ VPC ⊃ 가용 영역 ⊃ 서브넷.</strong> VPC는 리전의 모든 가용 영역에
              걸쳐 있고, 가용 영역에 속하는 것은 서브넷이다.
            </li>
            <li>
              <strong>Amazon EBS 테두리</strong> — 볼륨은 <strong>가용 영역 범위</strong>여서 그
              안에 그린다. <strong>VPC에는 속하지 않는다</strong> — VPC 테두리 안에 보이는 것은
              가용 영역이 그 안에 그려지기 때문이고, 볼륨이 VPC에 속한다는 뜻이 아니다.
            </li>
            <li>
              <strong>개수가 없는 테두리</strong> — 이 정책이 닿는 자원이 그 유형에 없거나
              (<code>인벤토리에 없음</code>), 평가가 아예 세지 않는다
              (<code>가용 영역 · 평가에 없음</code>).
            </li>
            <li>
              <strong>화살표 하나</strong> — 인터넷 게이트웨이가 VPC의 출입구라는 뜻이다.
              이 계정에서 확인한 연결이 아니다.
            </li>
            <li>
              <strong>민감 자원</strong> — 자원 판의 <strong>빨간 테두리</strong>와 빨간 개수,
              테두리 이름 옆의 <code>민감 N개</code>, 그리고 아래 표의 <code>민감</code> 칸,
              셋이 같은 것을 말한다. <strong>보안 그룹 테두리의 빨강은 AWS의 그룹 색</strong>이고
              민감도와 무관하다 — 안에 무엇이 있든 빨갛다.
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

          <SceneTable scene={scene} />

          {scene.omitted.length > 0 && (
            <p className="muted small">
              그림 밖 서비스:{" "}
              {scene.omitted.map((o) => `${o.service} ${o.total.toLocaleString()}개`).join(" · ")}
              {" "}— 이 정책이 닿지만 EC2 구성도에 자리가 없는 서비스다. 위의 표는 EC2 자원만
              담는다.
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

import { jsx, jsxs } from "react/jsx-runtime";
import { useId, useRef } from "react";
import { ec2Scene, sceneSummary } from "./p/ec2Topology.js";
function FrameShape({ frame }) {
  return (
    // The id class goes on the GROUP, not on the rect. A rule for one frame's label -
    // `.topo-frame-sg .topo-frame-label` - has to reach a <tspan> in a sibling <text>, and from
    // the rect it reaches nothing: the 보안 그룹 label rendered in the ordinary text colour while
    // its border was red, which is the one frame whose colour carries a meaning.
    /* @__PURE__ */ jsxs("g", { className: `topo-frame-${frame.id}`, children: [
      /* @__PURE__ */ jsx(
        "rect",
        {
          className: "topo-frame",
          x: frame.x,
          y: frame.y,
          width: frame.w,
          height: frame.h,
          rx: 4,
          style: frame.stroke ? { stroke: frame.stroke } : void 0,
          strokeWidth: frame.width,
          strokeDasharray: frame.dashed ? "6 4" : void 0,
          children: frame.title && /* @__PURE__ */ jsx("title", { children: frame.title })
        }
      ),
      frame.badge && /* @__PURE__ */ jsx(
        "image",
        {
          href: `/aws-icons/${frame.badge}`,
          x: frame.x + 8,
          y: frame.y + 6,
          width: 20,
          height: 20
        }
      ),
      /* @__PURE__ */ jsxs("text", { className: "topo-frame-text", x: frame.x + (frame.badge ? 34 : 10), y: frame.y + 20, children: [
        /* @__PURE__ */ jsx("tspan", { className: "topo-frame-label", children: frame.label }),
        frame.count && /* @__PURE__ */ jsx("tspan", { className: "topo-frame-count", dx: "6", children: frame.count }),
        frame.note && /* @__PURE__ */ jsx("tspan", { className: "topo-frame-note", dx: "6", children: frame.note })
      ] })
    ] })
  );
}
function SlotShape({ slot }) {
  return /* @__PURE__ */ jsxs("g", { children: [
    slot.erase && /* @__PURE__ */ jsx("rect", { className: "topo-erase", x: slot.x, y: slot.y, width: slot.w, height: slot.h }),
    /* @__PURE__ */ jsx(
      "rect",
      {
        className: slot.sensitive ? "topo-slot topo-slot-sensitive" : "topo-slot",
        x: slot.x,
        y: slot.y,
        width: slot.w,
        height: slot.h,
        rx: 4,
        children: /* @__PURE__ */ jsx("title", { children: slot.title })
      }
    ),
    slot.icon && /* @__PURE__ */ jsx(
      "image",
      {
        href: `/aws-icons/${slot.icon}`,
        x: slot.x + 36,
        y: slot.y + 8,
        width: 48,
        height: 48
      }
    ),
    slot.label[0] && /* @__PURE__ */ jsx("text", { className: "topo-slot-label", x: slot.x + 60, y: slot.y + 70, textAnchor: "middle", children: slot.label[0] }),
    slot.label[1] && /* @__PURE__ */ jsx("text", { className: "topo-slot-label", x: slot.x + 60, y: slot.y + 82, textAnchor: "middle", children: slot.label[1] }),
    /* @__PURE__ */ jsx(
      "text",
      {
        className: slot.sensitive ? "topo-slot-count sensitive" : "topo-slot-count",
        x: slot.x + 60,
        y: slot.y + 96,
        textAnchor: "middle",
        children: slot.count
      }
    )
  ] });
}
function LinkShape({ link, uid }) {
  return /* @__PURE__ */ jsxs("g", { children: [
    /* @__PURE__ */ jsxs("defs", { children: [
      /* @__PURE__ */ jsx(
        "marker",
        {
          id: `${uid}-up`,
          viewBox: "0 0 8 8",
          refX: "4",
          refY: "4",
          markerWidth: "5",
          markerHeight: "5",
          orient: "auto-start-reverse",
          children: /* @__PURE__ */ jsx("path", { className: "topo-link-marker", d: "M 0 0 L 8 4 L 0 8 z" })
        }
      ),
      /* @__PURE__ */ jsx(
        "marker",
        {
          id: `${uid}-down`,
          viewBox: "0 0 8 8",
          refX: "4",
          refY: "4",
          markerWidth: "5",
          markerHeight: "5",
          orient: "auto",
          children: /* @__PURE__ */ jsx("path", { className: "topo-link-marker", d: "M 0 0 L 8 4 L 0 8 z" })
        }
      )
    ] }),
    /* @__PURE__ */ jsx("image", { href: `/aws-icons/${link.glyph}`, x: link.cx - 16, y: 8, width: 32, height: 32 }),
    /* @__PURE__ */ jsx("text", { className: "topo-link-label", x: link.cx, y: 56, textAnchor: "middle", children: link.label }),
    /* @__PURE__ */ jsx(
      "path",
      {
        className: "topo-link",
        d: `M ${link.cx} ${link.from} L ${link.cx} ${link.to}`,
        markerStart: `url(#${uid}-up)`,
        markerEnd: `url(#${uid}-down)`
      }
    )
  ] });
}
function Figure({ scene, name, uid }) {
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      className: "topology-svg",
      viewBox: `0 0 ${scene.width} ${scene.height}`,
      width: scene.width,
      height: scene.height,
      preserveAspectRatio: "xMinYMin meet",
      fontFamily: "inherit",
      role: "img",
      "aria-labelledby": `${uid}-t ${uid}-d`,
      children: [
        /* @__PURE__ */ jsx("title", { id: `${uid}-t`, children: `${name}\uC774 \uB2FF\uB294 EC2 \uC790\uC6D0 \uAD6C\uC131\uB3C4` }),
        /* @__PURE__ */ jsx("desc", { id: `${uid}-d`, children: sceneSummary(scene) }),
        /* @__PURE__ */ jsx("rect", { className: "topo-ground", x: 0, y: 0, width: scene.width, height: scene.height }),
        scene.frames.map((f) => /* @__PURE__ */ jsx(FrameShape, { frame: f }, f.id)),
        scene.link && /* @__PURE__ */ jsx(LinkShape, { link: scene.link, uid }),
        scene.slots.map((s) => /* @__PURE__ */ jsx(SlotShape, { slot: s }, s.key)),
        scene.foot.map((line) => /* @__PURE__ */ jsx("text", { className: "topo-foot", x: 8, y: line.y, children: line.text }, line.text))
      ]
    }
  );
}
function SceneTable({ scene }) {
  const place = (row) => {
    if (!row.frame) return /* @__PURE__ */ jsx("td", { className: "none", children: "\uC5C6\uC74C" });
    return /* @__PURE__ */ jsx("td", { children: FRAME_NAME[row.frame] ?? row.frame });
  };
  return /* @__PURE__ */ jsxs("table", { className: "topology-table", children: [
    /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
      /* @__PURE__ */ jsx("th", { children: "\uC720\uD615" }),
      /* @__PURE__ */ jsx("th", { children: "\uC790\uB9AC" }),
      /* @__PURE__ */ jsx("th", { children: "\uAC1C\uC218" }),
      /* @__PURE__ */ jsx("th", { children: "\uBC94\uC704" }),
      /* @__PURE__ */ jsx("th", { children: "\uBBFC\uAC10" })
    ] }) }),
    /* @__PURE__ */ jsx("tbody", { children: scene.rows.map((row) => /* @__PURE__ */ jsxs("tr", { children: [
      /* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("code", { children: row.resourceType }) }),
      place(row),
      /* @__PURE__ */ jsx("td", { children: row.countLabel }),
      /* @__PURE__ */ jsx("td", { children: row.scope }),
      /* @__PURE__ */ jsx("td", { className: row.sensitive > 0 ? "sensitive" : "none", children: row.sensitive > 0 ? `${row.sensitive}\uAC1C` : "\u2014" })
    ] }, row.resourceType)) })
  ] });
}
const FRAME_NAME = {
  cloud: "AWS \uD074\uB77C\uC6B0\uB4DC",
  region: "\uB9AC\uC804",
  az: "\uAC00\uC6A9 \uC601\uC5ED",
  vpc: "VPC",
  subnet: "\uC11C\uBE0C\uB137",
  sg: "\uBCF4\uC548 \uADF8\uB8F9",
  ebs: "Amazon EBS"
};
function PolicyTopology({ policy, name, accountId }) {
  const dialog = useRef(null);
  const uid = useId();
  const scene = ec2Scene(policy, accountId);
  if (!scene) return null;
  const regionLabel = scene.regions.length === 0 ? "\uB9AC\uC804 \uC5C6\uC74C" : scene.regions.length === 1 ? `\uB9AC\uC804 ${scene.regions[0]}` : `\uB9AC\uC804 ${scene.regions.length}\uACF3`;
  return /* @__PURE__ */ jsxs("div", { className: "topology-launch", children: [
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        "aria-label": `${name}\uC774 \uB2FF\uB294 \uC790\uC6D0\uC758 \uAD6C\uC131\uB3C4 \uBCF4\uAE30`,
        onClick: () => dialog.current?.showModal(),
        children: "\uAD6C\uC131\uB3C4 \uBCF4\uAE30"
      }
    ),
    /* @__PURE__ */ jsxs("span", { className: "muted small", children: [
      "EC2 \uC790\uC6D0 ",
      scene.kinds,
      "\uC885 \xB7 ",
      scene.measured.toLocaleString(),
      "\uAC1C",
      scene.truncated && " \uC774\uC0C1",
      " \xB7 ",
      regionLabel,
      scene.unslotted.length > 0 && ` \xB7 \uC790\uB9AC \uC5C6\uB294 \uC720\uD615 ${scene.unslotted.length}\uC885`
    ] }),
    /* @__PURE__ */ jsx(
      "dialog",
      {
        ref: dialog,
        className: "policy-dialog topology-dialog",
        onClick: (e) => {
          if (e.target === dialog.current) dialog.current?.close();
        },
        children: /* @__PURE__ */ jsxs("div", { className: "policy-dialog-body", children: [
          /* @__PURE__ */ jsxs("h4", { children: [
            "\uC774 \uC815\uCC45\uC774 \uB2FF\uB294 EC2 \uC790\uC6D0\uC758 \uAD6C\uC131\uB3C4 ",
            /* @__PURE__ */ jsxs("span", { className: "muted", children: [
              "\u2014 ",
              /* @__PURE__ */ jsx("code", { children: name })
            ] })
          ] }),
          /* @__PURE__ */ jsxs("p", { className: "muted small", children: [
            "\uC774 \uADF8\uB9BC\uC740 \uC790\uC6D0\uC744 ",
            /* @__PURE__ */ jsx("strong", { children: "\uC720\uD615\uC5D0 \uB530\uB77C EC2 \uAD6C\uC131\uC5D0\uC11C \uB193\uC774\uB294 \uC790\uB9AC" }),
            "\uC5D0 \uB193\uC740 \uAC83\uC774\uB2E4. \uC5B4\uB290 \uC778\uC2A4\uD134\uC2A4\uAC00 \uC5B4\uB290 \uC11C\uBE0C\uB137\uC5D0 \uC788\uB294\uC9C0, \uC5B4\uB290 \uBCFC\uB968\uC774 \uC5B4\uB290 \uC778\uC2A4\uD134\uC2A4\uC5D0 \uBD99\uC5B4 \uC788\uB294\uC9C0\uB294 \uC774 \uD3C9\uAC00\uC5D0 \uB4E4\uC5B4 \uC788\uC9C0 \uC54A\uB2E4 \u2014 \uADF8\uB798\uC11C \uC774 \uADF8\uB9BC\uC740 \uADF8\uAC83\uC744 \uB9D0\uD558\uC9C0 \uC54A\uB294\uB2E4.",
            " ",
            /* @__PURE__ */ jsx("strong", { children: "\uD14C\uB450\uB9AC\uC758 \uD3EC\uD568 \uAD00\uACC4\uB294 \uCE21\uC815\uD55C \uAC83\uC774 \uC544\uB2C8\uB77C EC2\uC758 \uC77C\uBC18\uC801\uC778 \uAD6C\uC131\uC774\uB2E4." })
          ] }),
          /* @__PURE__ */ jsxs("p", { className: "muted small", children: [
            "\uC790\uC6D0\uB9C8\uB2E4 \uC2E4\uC81C \uAC12\uC778 \uAC83\uC740 ",
            /* @__PURE__ */ jsx("strong", { children: "\uACC4\uC815\uACFC \uB9AC\uC804\uACFC \uAC1C\uC218" }),
            "\uBFD0\uC774\uB2E4. \uAC00\uC6A9 \uC601\uC5ED\uC740 \uD3C9\uAC00\uC5D0 \uC5C6\uC5B4\uC11C \uD14C\uB450\uB9AC\uB9CC \uADF8\uB9AC\uACE0 \uAC1C\uC218\uB97C \uC801\uC9C0 \uC54A\uB294\uB2E4. \uAC1C\uC218\uB294 ",
            /* @__PURE__ */ jsx("strong", { children: "\uB9AC\uC804\uC744 \uD569\uCE5C \uC218" }),
            "\uB2E4 \u2014 \uB9AC\uC804\uBCC4\uB85C \uBCF4\uB824\uBA74 \uC704\uC758 \uC790\uC6D0 \uBAA9\uB85D\uC5D0 \uB9AC\uC804\uB9C8\uB2E4 \uAD00\uB9AC\uCF58\uC194 \uB9C1\uD06C\uAC00 \uC788\uB2E4. \uC790\uC6D0\uB07C\uB9AC\uC758 \uC5F0\uACB0\uC120\uC740 \uADF8\uB9AC\uC9C0 \uC54A\uB294\uB2E4. \uBB34\uC5C7\uC774 \uBB34\uC5C7\uACFC \uD1B5\uC2E0\uD558\uB294\uC9C0\uB294 \uC774 \uD3C9\uAC00\uAC00 \uB2F5\uD558\uC9C0 \uC54A\uB294 \uC9C8\uBB38\uC774\uB2E4."
          ] }),
          /* @__PURE__ */ jsx("div", { className: "topology-figure", tabIndex: 0, role: "group", "aria-label": "\uC790\uC6D0 \uAD6C\uC131\uB3C4", children: /* @__PURE__ */ jsx(Figure, { scene, name, uid }) }),
          /* @__PURE__ */ jsxs("ul", { className: "topology-legend", children: [
            /* @__PURE__ */ jsxs("li", { children: [
              /* @__PURE__ */ jsx("strong", { children: "\uC2E4\uC120 \uD14C\uB450\uB9AC" }),
              " \u2014 \uD3C9\uAC00\uAC00 \uD655\uC778\uD55C \uD3EC\uD568 \uAD00\uACC4\uB2E4. \uACC4\uC815\uACFC \uB9AC\uC804, \uB458\uBFD0\uC774\uB2E4."
            ] }),
            /* @__PURE__ */ jsxs("li", { children: [
              /* @__PURE__ */ jsx("strong", { children: "\uC810\uC120 \uD14C\uB450\uB9AC" }),
              " \u2014 EC2\uC758 \uC77C\uBC18\uC801\uC778 \uC790\uB9AC\uB2E4. \uCE21\uC815\uD55C \uAC83\uC774 \uC544\uB2C8\uB2E4. \uC548\uC5D0 \uBB34\uC5C7\uC774 \uB4E4\uC5B4 \uC788\uB4E0 \uB9C8\uCC2C\uAC00\uC9C0\uB2E4."
            ] }),
            /* @__PURE__ */ jsxs("li", { children: [
              /* @__PURE__ */ jsx("strong", { children: "\uAC1C\uC218\uAC00 \uC5C6\uB294 \uD14C\uB450\uB9AC" }),
              " \u2014 \uC774 \uC815\uCC45\uC774 \uB2FF\uB294 \uC790\uC6D0\uC774 \uADF8 \uC720\uD615\uC5D0 \uC5C6\uAC70\uB098 (",
              /* @__PURE__ */ jsx("code", { children: "\uC778\uBCA4\uD1A0\uB9AC\uC5D0 \uC5C6\uC74C" }),
              "), \uD3C9\uAC00\uAC00 \uC544\uC608 \uC138\uC9C0 \uC54A\uB294\uB2E4 (",
              /* @__PURE__ */ jsx("code", { children: "\uAC00\uC6A9 \uC601\uC5ED \xB7 \uD3C9\uAC00\uC5D0 \uC5C6\uC74C" }),
              ")."
            ] }),
            /* @__PURE__ */ jsxs("li", { children: [
              /* @__PURE__ */ jsx("strong", { children: "\uD654\uC0B4\uD45C \uD558\uB098" }),
              " \u2014 \uC778\uD130\uB137 \uAC8C\uC774\uD2B8\uC6E8\uC774\uAC00 VPC\uC758 \uCD9C\uC785\uAD6C\uB77C\uB294 \uB73B\uC774\uB2E4. \uC774 \uACC4\uC815\uC5D0\uC11C \uD655\uC778\uD55C \uC5F0\uACB0\uC774 \uC544\uB2C8\uB2E4."
            ] }),
            /* @__PURE__ */ jsxs("li", { children: [
              /* @__PURE__ */ jsx("strong", { children: "*" }),
              " \uC815\uCC45\uC774 \uC790\uC6D0\uC744 \uC9C0\uC815\uD558\uC9C0 \uC54A\uC558\uB2E4 \u2014 \uC9C0\uAE08\uC758 \uAC1C\uC218\uC774\uACE0 \uC55E\uC73C\uB85C \uC0DD\uAE30\uB294 \uAC83\uB3C4 \uD3EC\uD568\uD55C\uB2E4. ",
              /* @__PURE__ */ jsx("strong", { children: "\u26A0" }),
              " \uCC38\uC870\uAC00 \uB3D9\uC791\uBCC4 \uC790\uC6D0 \uC720\uD615\uC744 \uD310\uC815\uD558\uC9C0 \uBABB\uD574 \uC774 \uC11C\uBE44\uC2A4\uC758 \uC790\uC6D0 \uC804\uBD80\uAC00 \uB4E4\uC5B4 \uC788\uB2E4. ",
              /* @__PURE__ */ jsx("strong", { children: "\u2020" }),
              " \uBAA9\uB85D\uC774 \uC798\uB838\uB2E4. \uAC1C\uC218\uB294 ",
              /* @__PURE__ */ jsx("strong", { children: "\uD558\uD55C" }),
              "\uC774\uB2E4. ",
              /* @__PURE__ */ jsx("strong", { children: "\uBE68\uAC04 \uD14C\uB450\uB9AC" }),
              " \uBBFC\uAC10 \uC790\uC6D0\uC774 \uB4E4\uC5B4 \uC788\uB2E4."
            ] })
          ] }),
          scene.truncated && /* @__PURE__ */ jsx("p", { className: "warn-inline", children: "\uC798\uB9B0 \uADF8\uB8F9\uC774 \uC788\uB2E4. Resource Explorer\uAC00 \uD55C \uBC88\uC5D0 1,000\uAC1C\uAE4C\uC9C0\uB9CC \uB3CC\uB824\uC8FC\uBBC0\uB85C, \uD45C\uC2DC\uB41C \uAC1C\uC218\uC640 \uB9AC\uC804 \uBAA9\uB85D\uC740 \uD558\uD55C\uC774\uB2E4." }),
          /* @__PURE__ */ jsx(SceneTable, { scene }),
          scene.omitted.length > 0 && /* @__PURE__ */ jsxs("p", { className: "muted small", children: [
            "\uADF8\uB9BC \uBC16 \uC11C\uBE44\uC2A4:",
            " ",
            scene.omitted.map((o) => `${o.service} ${o.total.toLocaleString()}\uAC1C`).join(" \xB7 "),
            " ",
            "\u2014 \uC774 \uC815\uCC45\uC774 \uB2FF\uC9C0\uB9CC EC2 \uAD6C\uC131\uB3C4\uC5D0 \uC790\uB9AC\uAC00 \uC5C6\uB294 \uC11C\uBE44\uC2A4\uB2E4."
          ] }),
          /* @__PURE__ */ jsx("div", { className: "row", children: /* @__PURE__ */ jsx("button", { type: "button", onClick: () => dialog.current?.close(), children: "\uB2EB\uAE30" }) })
        ] })
      }
    )
  ] });
}
export {
  PolicyTopology
};

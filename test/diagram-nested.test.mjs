import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNested } from "../scripts/lib/diagrams/nested.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

/** @param {string} svg @param {string} cls @returns {{x: number, y: number, w: number, h: number}[]} */
function rectsOfClass(svg, cls) {
  const out = [];
  for (const m of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const classMatch = /class="([^"]*)"/.exec(attrs);
    if (!classMatch || !classMatch[1].split(/\s+/).includes(cls)) continue;
    const num = (name) => Number(new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs)[1]);
    out.push({ x: num("x"), y: num("y"), w: num("width"), h: num("height") });
  }
  return out;
}

/** @param {{x: number, y: number, w: number, h: number}} inner @param {{x: number, y: number, w: number, h: number}} outer @returns {boolean} */
function strictlyInside(inner, outer) {
  return (
    inner.x > outer.x &&
    inner.y > outer.y &&
    inner.x + inner.w < outer.x + outer.w &&
    inner.y + inner.h < outer.y + outer.h
  );
}

const SPEC = {
  kind: "nested",
  id: "topo",
  title: "Deployment topology",
  root: {
    label: "eks cluster",
    sub: "ns core",
    children: [
      {
        label: "pod: bumblebee",
        children: [
          { label: "container", sub: "jvm 21", kind: "focal" },
          { label: "sidecar", sub: "envoy" },
        ],
      },
      {
        label: "pod: webhooks",
        children: [{ label: "container", sub: "jvm 21" }],
      },
    ],
  },
};

test("a nested spec renders one zone per container and one nb per leaf, with no geometric findings", () => {
  const svg = renderNested(SPEC);
  assert.deepEqual(validateSvg(svg), []);

  const zones = rectsOfClass(svg, "zone");
  const leaves = rectsOfClass(svg, "nb");
  assert.equal(zones.length, 3, "root + two pods");
  assert.equal(leaves.length, 3, "two children under bumblebee, one under webhooks");

  assert.ok(svg.includes("eks cluster"));
  assert.ok(svg.includes("ns core"));
  assert.ok(svg.includes("pod: bumblebee"));
  assert.ok(svg.includes("pod: webhooks"));
  assert.ok(svg.includes("jvm 21"));
  assert.ok(svg.includes("envoy"));
  assert.equal((svg.match(/<rect class="nb focal"/g) ?? []).length, 1);
});

test("every container and leaf lies strictly inside its parent's rect", () => {
  const svg = renderNested(SPEC);
  const [root, pod1, pod2] = rectsOfClass(svg, "zone");
  const [leaf1a, leaf1b, leaf2a] = rectsOfClass(svg, "nb");

  assert.ok(strictlyInside(pod1, root), "bumblebee pod sits inside the cluster");
  assert.ok(strictlyInside(pod2, root), "webhooks pod sits inside the cluster");
  assert.ok(strictlyInside(leaf1a, pod1), "focal container sits inside its pod");
  assert.ok(strictlyInside(leaf1b, pod1), "sidecar sits inside its pod");
  assert.ok(strictlyInside(leaf2a, pod2), "webhooks container sits inside its pod");
  assert.ok(strictlyInside(leaf1a, root), "transitively inside the cluster too");
  assert.ok(strictlyInside(leaf2a, root), "transitively inside the cluster too");
});

test("a single leaf root renders one nb box with no zone frame", () => {
  const svg = renderNested({
    kind: "nested",
    id: "solo",
    title: "Solo",
    root: { label: "standalone" },
  });
  assert.deepEqual(validateSvg(svg), []);
  assert.equal(rectsOfClass(svg, "nb").length, 1);
  assert.equal(rectsOfClass(svg, "zone").length, 0);
});

test("a spec with no root fails loudly", () => {
  assert.throws(
    () => renderNested({ kind: "nested", id: "x", title: "x", root: undefined }),
    /needs a root node/,
  );
});

test("an unknown leaf kind fails loudly rather than rendering an invisible accent", () => {
  assert.throws(
    () =>
      renderNested({
        kind: "nested",
        id: "x",
        title: "x",
        root: { label: "outer", children: [{ label: "bogus leaf", kind: "bogus" }] },
      }),
    /unknown node kind "bogus" for node "bogus leaf"/,
  );
});

test("a fifth nesting level fails loudly instead of rendering something illegible", () => {
  const deep = {
    kind: "nested",
    id: "x",
    title: "x",
    root: {
      label: "l1",
      children: [
        {
          label: "l2",
          children: [
            {
              label: "l3",
              children: [{ label: "l4", children: [{ label: "l5" }] }],
            },
          ],
        },
      ],
    },
  };
  assert.throws(() => renderNested(deep), /exceeds max depth of 4/);
});

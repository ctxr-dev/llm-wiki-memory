import { test } from "node:test";
import assert from "node:assert/strict";
import { renderVenn } from "../scripts/lib/diagrams/venn.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

/** @param {string} svg @returns {{cx: number, cy: number, r: number, classes: string[]}[]} */
function circles(svg) {
  /** @type {{cx: number, cy: number, r: number, classes: string[]}[]} */
  const out = [];
  for (const m of svg.matchAll(/<circle\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const num = (/** @type {string} */ name) =>
      Number(new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs)?.[1]);
    const classes = (/class="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/).filter(Boolean);
    out.push({ cx: num("cx"), cy: num("cy"), r: num("r"), classes });
  }
  return out;
}

/** @param {string} svg @param {string} cls @returns {{x: number, y: number, anchor: string, text: string}[]} */
function texts(svg, cls) {
  /** @type {{x: number, y: number, anchor: string, text: string}[]} */
  const out = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1];
    const classes = (/class="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/).filter(Boolean);
    if (!classes.includes(cls)) continue;
    const num = (/** @type {string} */ name) =>
      Number(new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs)?.[1]);
    out.push({
      x: num("x"),
      y: num("y"),
      anchor: /text-anchor="([^"]*)"/.exec(attrs)?.[1] ?? "",
      text: m[2],
    });
  }
  return out;
}

const THREE_SET_SPEC = {
  kind: "venn",
  id: "coverage",
  title: "Memory pipeline coverage",
  sets: [{ label: "recalled", focal: false }, { label: "saved" }, { label: "consolidated" }],
  regions: [
    { sets: [0], label: "12" },
    { sets: [1], label: "9" },
    { sets: [2], label: "5" },
    { sets: [0, 1], label: "4" },
    { sets: [0, 2], label: "3" },
    { sets: [1, 2], label: "2" },
    { sets: [0, 1, 2], label: "6" },
  ],
};

const TWO_SET_SPEC = {
  kind: "venn",
  id: "cache",
  title: "Cache overlap",
  sets: [{ label: "warm", focal: true }, { label: "cold" }],
  regions: [
    { sets: [0], label: "40" },
    { sets: [1], label: "55" },
    { sets: [0, 1], label: "5" },
  ],
};

test("a 3-set venn with all 7 regions labelled renders with zero geometric findings", () => {
  const svg = renderVenn(THREE_SET_SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("a 2-set venn renders with zero geometric findings", () => {
  const svg = renderVenn(TWO_SET_SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("one circle mark is drawn per set", () => {
  const svg = renderVenn(THREE_SET_SPEC);
  assert.equal(circles(svg).length, THREE_SET_SPEC.sets.length);
});

test("the focal set gets the focal mark class, others get sequential s-classes", () => {
  const svg = renderVenn(TWO_SET_SPEC);
  const cs = circles(svg);
  const focalCount = cs.filter((c) => c.classes.includes("focal")).length;
  assert.equal(focalCount, 1);
  assert.ok(cs.some((c) => c.classes.includes("s1")));
});

test("one set label is drawn per set, and one region label per named region", () => {
  const svg = renderVenn(THREE_SET_SPEC);
  const setLabels = texts(svg, "clab");
  const regionLabels = texts(svg, "vlab");
  assert.equal(setLabels.length, THREE_SET_SPEC.sets.length);
  assert.equal(regionLabels.length, THREE_SET_SPEC.regions.length);
  assert.deepEqual(
    setLabels.map((t) => t.text).sort(),
    THREE_SET_SPEC.sets.map((s) => s.label).sort(),
  );
  assert.deepEqual(
    regionLabels.map((t) => t.text).sort(),
    THREE_SET_SPEC.regions.map((r) => r.label).sort(),
  );
});

test("every region label sits inside every set it names and outside every set it doesn't", () => {
  const svg = renderVenn(THREE_SET_SPEC);
  const cs = circles(svg);
  const regionLabels = texts(svg, "vlab");
  // Emission order matches `spec.regions` order, so the two arrays zip directly.
  THREE_SET_SPEC.regions.forEach((region, i) => {
    const label = regionLabels[i];
    cs.forEach((c, setIndex) => {
      const d = Math.hypot(label.x - c.cx, label.y - c.cy);
      if (region.sets.includes(setIndex)) {
        assert.ok(
          d < c.r,
          `region ${JSON.stringify(region.sets)} label is outside set ${setIndex}`,
        );
      } else {
        assert.ok(
          d > c.r,
          `region ${JSON.stringify(region.sets)} label sits inside set ${setIndex}`,
        );
      }
    });
  });
});

test("set labels sit outside their own circle", () => {
  const svg = renderVenn(THREE_SET_SPEC);
  const cs = circles(svg);
  const setLabels = texts(svg, "clab");
  setLabels.forEach((label) => {
    for (const c of cs) {
      const d = Math.hypot(label.x - c.cx, label.y - c.cy);
      assert.ok(d > c.r, `set label "${label.text}" sits inside a circle`);
    }
  });
});

test("fewer than 2 or more than 3 sets fails loudly", () => {
  assert.throws(() => renderVenn({ ...TWO_SET_SPEC, sets: [{ label: "solo" }] }), /2 or 3 sets/);
  assert.throws(
    () =>
      renderVenn({
        ...TWO_SET_SPEC,
        sets: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }],
      }),
    /2 or 3 sets/,
  );
});

test("more than one focal set fails loudly", () => {
  assert.throws(
    () =>
      renderVenn({
        ...TWO_SET_SPEC,
        sets: [
          { label: "a", focal: true },
          { label: "b", focal: true },
        ],
      }),
    /one focal set/,
  );
});

test("a region referencing an unknown set index fails loudly", () => {
  assert.throws(
    () => renderVenn({ ...TWO_SET_SPEC, regions: [{ sets: [5], label: "x" }] }),
    /set index 5/,
  );
});

test("a region listing a set index twice fails loudly", () => {
  assert.throws(
    () => renderVenn({ ...TWO_SET_SPEC, regions: [{ sets: [0, 0], label: "x" }] }),
    /more than once/,
  );
});

test("two regions naming the same combination fails loudly", () => {
  assert.throws(
    () =>
      renderVenn({
        ...TWO_SET_SPEC,
        regions: [
          { sets: [0], label: "x" },
          { sets: [0], label: "y" },
        ],
      }),
    /both label the \{0\}/,
  );
});

test("a region with an empty label fails loudly", () => {
  assert.throws(
    () => renderVenn({ ...TWO_SET_SPEC, regions: [{ sets: [0], label: "   " }] }),
    /non-empty label/,
  );
});

test("a region naming more sets than exist fails loudly", () => {
  assert.throws(
    () => renderVenn({ ...TWO_SET_SPEC, regions: [{ sets: [0, 1, 0], label: "x" }] }),
    /1-2 set indices/,
  );
});

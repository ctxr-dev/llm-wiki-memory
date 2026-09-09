import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPyramid } from "../scripts/lib/diagrams/pyramid.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";
import { NAME_CH } from "../scripts/lib/diagrams/text.mjs";

/** @param {string} svg @param {string} cls @returns {{x: number, y: number, w: number, h: number}[]} */
function rectsOfClass(svg, cls) {
  /** @type {{x: number, y: number, w: number, h: number}[]} */
  const out = [];
  for (const m of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const classMatch = /class="([^"]*)"/.exec(attrs);
    if (!classMatch || !classMatch[1].split(/\s+/).includes(cls)) continue;
    const num = (/** @type {string} */ name) =>
      Number(new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs)?.[1]);
    out.push({ x: num("x"), y: num("y"), w: num("width"), h: num("height") });
  }
  return out;
}

const FUNNEL_SPEC = {
  kind: "pyramid",
  id: "f1",
  title: "Signup funnel",
  shape: "funnel",
  stages: [
    { label: "visits", value: 10000 },
    { label: "signups", value: 4200 },
    { label: "activated", value: 1800 },
    { label: "paid", value: 620, focal: true },
    { label: "renewed", value: 340 },
  ],
};

const PYRAMID_SPEC = {
  kind: "pyramid",
  id: "p1",
  title: "Needs hierarchy",
  shape: "pyramid",
  stages: [
    { label: "physiological", value: 5 },
    { label: "safety", value: 4 },
    { label: "belonging", value: 3, focal: true },
    { label: "esteem", value: 2 },
    { label: "self-actualization needs", value: 1 },
  ],
};

test("a funnel renders one mark per stage, with strictly narrowing widths and no geometric findings", () => {
  const svg = renderPyramid(FUNNEL_SPEC);
  assert.deepEqual(validateSvg(svg), []);

  const slabs = rectsOfClass(svg, "mark").sort((a, b) => a.y - b.y);
  assert.equal(slabs.length, 5);
  for (let i = 1; i < slabs.length; i += 1) {
    assert.ok(
      slabs[i].w < slabs[i - 1].w,
      `slab ${i} (${slabs[i].w}) must be narrower than slab ${i - 1} (${slabs[i - 1].w})`,
    );
  }
  assert.equal((svg.match(/<rect class="mark focal"/g) ?? []).length, 1);
});

test("a pyramid renders one mark per stage, all sharing decorative equal steps, with no geometric findings", () => {
  const svg = renderPyramid(PYRAMID_SPEC);
  assert.deepEqual(validateSvg(svg), []);

  const slabs = rectsOfClass(svg, "mark").sort((a, b) => a.y - b.y);
  assert.equal(slabs.length, 5);
  const steps = new Set();
  for (let i = 1; i < slabs.length; i += 1) {
    assert.ok(slabs[i].w < slabs[i - 1].w, "each pyramid step is narrower than the one above");
    steps.add(Math.round((slabs[i - 1].w - slabs[i].w) * 100));
  }
  assert.equal(steps.size, 1, "pyramid steps are equal-sized regardless of the underlying values");
});

test("stage labels that fit render centered inside their own slab, never overflowing it", () => {
  const svg = renderPyramid(FUNNEL_SPEC);
  const slabs = rectsOfClass(svg, "mark").sort((a, b) => a.y - b.y);
  const insideLabels = [
    ...svg.matchAll(
      /<text class="nn" x="([\d.]+)" y="([\d.]+)" text-anchor="middle">([^<]+)<\/text>/g,
    ),
  ];
  assert.ok(insideLabels.length >= 4, "most of these short labels fit inside their slab");
  for (const [, xStr, yStr, text] of insideLabels) {
    const x = Number(xStr);
    const y = Number(yStr);
    const halfWidth = (text.length * NAME_CH) / 2;
    const slab = slabs.find((s) => y >= s.y && y <= s.y + s.h);
    assert.ok(slab, `label "${text}" lands within some slab's row`);
    assert.ok(
      x - halfWidth >= slab.x && x + halfWidth <= slab.x + slab.w,
      `label "${text}" (${(x - halfWidth).toFixed(0)}-${(x + halfWidth).toFixed(0)}) must stay inside its slab (${slab.x}-${slab.x + slab.w})`,
    );
  }
});

test("a label too wide for its slab moves to a leader line outside it, never claiming to be inside", () => {
  const svg = renderPyramid(PYRAMID_SPEC);
  const slabs = rectsOfClass(svg, "mark").sort((a, b) => a.y - b.y);
  const narrowest = slabs[slabs.length - 1];
  assert.ok(svg.includes('<path class="hair"'), "the long bottom label gets a leader line");
  const outside =
    /<text class="nn" x="([\d.]+)" y="[\d.]+" text-anchor="end">self-actualization needs<\/text>/.exec(
      svg,
    );
  assert.ok(outside, "the long label is rendered right-anchored outside its slab");
  const labelRight = Number(outside[1]);
  assert.ok(labelRight < narrowest.x, "the outside label sits fully left of the slab it names");
});

test("value and drop-off annotations appear once per stage, with none on the first stage", () => {
  const svg = renderPyramid(FUNNEL_SPEC);
  const vlabs = [...svg.matchAll(/<text class="vlab[^"]*"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
  assert.equal(vlabs.length, 5);
  assert.equal(vlabs[0], "10,000", "the top stage shows only its raw count, no drop-off");
  assert.ok(vlabs[1].includes("(-58%)"), "signups drop 58% from 10000 visits");
  assert.equal((svg.match(/<text class="vlab focal"/g) ?? []).length, 1);
});

test("fewer than 3 or more than 7 stages fails loudly", () => {
  assert.throws(
    () => renderPyramid({ ...FUNNEL_SPEC, stages: FUNNEL_SPEC.stages.slice(0, 2) }),
    /3-7 stages/,
  );
  const eight = Array.from({ length: 8 }, (_, i) => ({ label: `s${i}`, value: 100 - i }));
  assert.throws(() => renderPyramid({ ...FUNNEL_SPEC, stages: eight }), /3-7 stages/);
});

test("an unknown shape fails loudly", () => {
  assert.throws(
    () => renderPyramid({ ...FUNNEL_SPEC, shape: "cone" }),
    /unknown pyramid shape "cone"/,
  );
});

test("a non-finite or non-positive stage value fails loudly, naming the stage", () => {
  const stages = [
    { label: "visits", value: 100 },
    { label: "signups", value: NaN },
    { label: "paid", value: 10 },
  ];
  assert.throws(() => renderPyramid({ ...FUNNEL_SPEC, stages }), /"signups"/);
});

test("a value that increases going down the funnel fails loudly, naming both stages", () => {
  const stages = [
    { label: "visits", value: 100 },
    { label: "signups", value: 50 },
    { label: "rebound", value: 80 },
  ];
  assert.throws(() => renderPyramid({ ...FUNNEL_SPEC, stages }), /"rebound".*"signups"/s);
});

test("more than one focal stage fails loudly", () => {
  const stages = [
    { label: "visits", value: 100, focal: true },
    { label: "signups", value: 50, focal: true },
    { label: "paid", value: 10 },
  ];
  assert.throws(() => renderPyramid({ ...FUNNEL_SPEC, stages }), /at most one focal/);
});

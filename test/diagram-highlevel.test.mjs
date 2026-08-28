import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHighLevel } from "../scripts/lib/diagrams/highlevel.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

/** @param {string} svg @param {string} cls @returns {{x: number, y: number, w: number, h: number}[]} */
function rectsOfClass(svg, cls) {
  /** @type {{x: number, y: number, w: number, h: number}[]} */
  const out = [];
  for (const m of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const classes = /class="([^"]*)"/.exec(attrs)?.[1].split(/\s+/) ?? [];
    if (!classes.includes(cls)) continue;
    const num = (/** @type {string} */ name) =>
      Number(new RegExp(`${name}="(-?[\\d.]+)"`).exec(attrs)?.[1]);
    out.push({ x: num("x"), y: num("y"), w: num("width"), h: num("height") });
  }
  return out;
}

const SPEC = {
  kind: "high-level",
  id: "h",
  title: "Streaming data stack",
  chevrons: ["ingest", "store", "query", "serve"],
  components: [
    { label: "kafka", phase: 0, focal: false },
    { label: "nifi", phase: 0, focal: false },
    { label: "minio", phase: 1, focal: true },
    { label: "trino", phase: 2, focal: false },
    { label: "superset", phase: 3, focal: false },
    { label: "grafana api", phase: 3, focal: false },
  ],
  orchestration: "argo",
  identity: "oidc",
};

test("a high-level overview renders one nb box per component plus the orchestration and identity bars, with no geometric findings", () => {
  const svg = renderHighLevel(SPEC);
  assert.deepEqual(validateSvg(svg), []);
  assert.match(svg, /<svg viewBox="0 0 1000 456" role="img" aria-label="Streaming data stack">/);
  assert.equal(
    (svg.match(/<rect class="nb/g) ?? []).length,
    8,
    "6 components + orchestration bar + identity footer",
  );
  assert.equal(
    (svg.match(/<rect class="nb focal"/g) ?? []).length,
    1,
    "exactly one focal component",
  );
  assert.equal((svg.match(/<polygon class="mark/g) ?? []).length, 4, "one polygon per chevron");
  assert.equal((svg.match(/<rect class="zone"/g) ?? []).length, 1, "one deployment-boundary zone");
});

test("the chevron banner reads left to right and every component's box is centered on its own chevron", () => {
  const svg = renderHighLevel(SPEC);
  for (const name of ["INGEST", "STORE", "QUERY", "SERVE"]) {
    assert.ok(svg.includes(name), `missing chevron label ${name}`);
  }
  const chevronCx = [124, 372, 620, 872];
  const nodes = rectsOfClass(svg, "nb").filter((r) => r.w === 152); // components only, not the two bars
  assert.equal(nodes.length, 6);
  const expectedCx = [
    chevronCx[0], // kafka
    chevronCx[0], // nifi
    chevronCx[1], // minio
    chevronCx[2], // trino
    chevronCx[3], // superset
    chevronCx[3], // grafana api
  ];
  nodes.forEach((node, i) => {
    assert.equal(node.x + node.w / 2, expectedCx[i], `component ${i} not centered on its chevron`);
  });
});

test("components sharing a phase stack in declaration order without overlapping", () => {
  const svg = renderHighLevel(SPEC);
  assert.match(
    svg,
    /<rect class="nb" x="48" y="120" width="152" height="80" rx="6"\/><text class="nn" x="124" y="164"[^>]*><tspan[^>]*>kafka/,
  );
  assert.match(
    svg,
    /<rect class="nb" x="48" y="216" width="152" height="80" rx="6"\/><text class="nn" x="124" y="260"[^>]*><tspan[^>]*>nifi/,
  );
  assert.match(
    svg,
    /<rect class="nb" x="796" y="216"[^>]*\/><text class="nn" x="872" y="260"[^>]*><tspan[^>]*>grafana api/,
  );
});

test("the orchestration bar and identity footer name their tools, labelled by role", () => {
  const svg = renderHighLevel(SPEC);
  assert.match(
    svg,
    /<text class="tag"[^>]*>ORCHESTRATION<\/text><text class="nn"[^>]*>argo<\/text>/,
  );
  assert.match(svg, /<text class="tag"[^>]*>IDENTITY<\/text><text class="nn"[^>]*>oidc<\/text>/);
});

test("rendering the same spec twice yields byte-identical SVG", () => {
  assert.equal(renderHighLevel(SPEC), renderHighLevel(SPEC));
});

test("a phase column deeper than the reference's flat 336px cluster grows the boundary instead of clipping", () => {
  const deep = {
    ...SPEC,
    components: [
      ...SPEC.components,
      { label: "extra-1", phase: 0, focal: false },
      { label: "extra-2", phase: 0, focal: false },
    ],
  };
  const shallow = renderHighLevel(SPEC);
  const svg = renderHighLevel(deep);
  assert.deepEqual(validateSvg(svg), []);
  const shallowH = Number(/viewBox="0 0 1000 (\d+)"/.exec(shallow)[1]);
  const deepH = Number(/viewBox="0 0 1000 (\d+)"/.exec(svg)[1]);
  assert.ok(
    deepH > shallowH,
    `deeper stack (${deepH}) should grow the canvas past the shallow one (${shallowH})`,
  );
});

test("a component with an out-of-range phase fails loudly, naming the component", () => {
  const bad = {
    ...SPEC,
    components: [...SPEC.components, { label: "ghost", phase: 9, focal: false }],
  };
  assert.throws(() => renderHighLevel(bad), /component "ghost" has phase 9, outside 0\.\.3/);
});

test("zero or more than one focal component fails loudly, naming the offenders", () => {
  const noFocal = SPEC.components.map((c) => ({ ...c, focal: false }));
  assert.throws(
    () => renderHighLevel({ ...SPEC, components: noFocal }),
    /exactly one focal component, got 0$/,
  );
  const twoFocal = SPEC.components.map((c, i) => ({ ...c, focal: i === 0 || i === 2 }));
  assert.throws(
    () => renderHighLevel({ ...SPEC, components: twoFocal }),
    /exactly one focal component, got 2 \(kafka, minio\)/,
  );
});

test("a missing orchestration tool, identity tool, chevron list or component list fails loudly", () => {
  assert.throws(
    () => renderHighLevel({ ...SPEC, orchestration: "" }),
    /needs an orchestration tool/,
  );
  assert.throws(() => renderHighLevel({ ...SPEC, identity: undefined }), /needs an identity tool/);
  assert.throws(() => renderHighLevel({ ...SPEC, chevrons: [] }), /at least one phase chevron/);
  assert.throws(() => renderHighLevel({ ...SPEC, components: [] }), /at least one component/);
});

test("far more chevrons than the banner can legibly fit fails loudly instead of rendering an inverted polygon", () => {
  const many = { ...SPEC, chevrons: Array.from({ length: 20 }, (_, i) => `p${i}`) };
  assert.throws(() => renderHighLevel(many), /too many chevrons \(20\)/);
});

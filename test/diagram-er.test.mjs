import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEr } from "../scripts/lib/diagrams/er.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const SPEC = {
  kind: "er",
  id: "er1",
  title: "Order data model",
  entities: [
    {
      id: "order",
      label: "webhook_orders_v1",
      col: 0,
      row: 0,
      kind: "store",
      fields: [
        { name: "order_id", type: "string", key: "pk" },
        { name: "shop_url", type: "string" },
        { name: "decision_id", type: "string", key: "fk" },
        { name: "total_price", type: "decimal" },
        { name: "currency", type: "string" },
        { name: "created_at", type: "timestamp" },
      ],
    },
    {
      id: "decision",
      label: "fraud_decisions",
      col: 1,
      row: 0,
      kind: "focal",
      fields: [
        { name: "decision_id", type: "string", key: "pk" },
        { name: "order_id", type: "string", key: "fk" },
        { name: "verdict", type: "string" },
      ],
    },
    {
      id: "merchant",
      label: "merchants",
      col: 0,
      row: 1,
      fields: [
        { name: "shop_url", type: "string", key: "pk" },
        { name: "display_name", type: "string" },
      ],
    },
  ],
  relations: [
    { from: "order", to: "decision", label: "has one", cardinality: "1..1" },
    { from: "merchant", to: "order", label: "has many", cardinality: "1..N" },
  ],
};

test("an er spec renders one svg with an entity box, header, and field rows", () => {
  const svg = renderEr(SPEC);
  assert.match(svg, /^<svg viewBox="/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<rect class="nb /g) ?? []).length, 3, "one box per entity");
  assert.equal(
    (svg.match(/<line class="hair"/g) ?? []).length,
    3,
    "every entity with fields gets a header divider",
  );
  // 11 fields total (6 + 3 + 2), each rendering a name AND a right-aligned type.
  assert.equal((svg.match(/<text class="ns"/g) ?? []).length, 11 * 2);
  // 3 "ENTITY" header eyebrows + 5 keyed fields (2 + 2 + 1) = 8 mono tags.
  assert.equal((svg.match(/<text class="tag"/g) ?? []).length, 8);
  assert.match(svg, /<text class="tag"[^>]*>ENTITY<\/text>/, "header eyebrow reads ENTITY");
  assert.match(svg, /<text class="tag"[^>]*>#<\/text>/, "a pk field gets a # marker");
  assert.match(svg, /<text class="tag"[^>]*>\u2192<\/text>/, "an fk field gets a \u2192 marker");
});

test("entity names, field names, and relationship labels with cardinality reach the output", () => {
  const svg = renderEr(SPEC);
  for (const needle of [
    "webhook_orders_v1",
    "fraud_decisions",
    "merchants",
    "order_id",
    "verdict",
    "display_name",
    "has one",
    "1..1",
    "has many",
    "1..N",
  ]) {
    assert.ok(svg.includes(needle), `expected "${needle}" in the rendered svg`);
  }
  // Both relations carry a label, so both get a masked, placed label rect.
  assert.equal((svg.match(/<rect class="emask"/g) ?? []).length, 2);
  assert.equal((svg.match(/<path class="e/g) ?? []).length, 2, "one line per relation");
});

test("a rendered er diagram has no geometric findings", () => {
  const svg = renderEr(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("an entity box grows with its field count and stays tall enough to hold every row", () => {
  const svg = renderEr(SPEC);
  const rects = [
    ...svg.matchAll(
      /<rect class="nb[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
    ),
  ];
  assert.equal(rects.length, 3);
  // Entities render in spec order: order (6 fields), decision (3), merchant (2).
  const [orderH, decisionH, merchantH] = rects.map((m) => Number(m[4]));
  assert.ok(orderH > decisionH, "6 fields must be taller than 3 fields");
  assert.ok(decisionH > merchantH, "3 fields must be taller than 2 fields");
  // Each extra field row must add real height, not be absorbed by rounding.
  assert.ok(
    orderH - merchantH >= 4 * 10,
    `4 extra fields should add well over 40px (got ${orderH - merchantH})`,
  );

  // Every field row for the 6-field entity must actually sit inside its box.
  const [, orderY, , orderHeight] = rects[0].map(Number);
  const top = orderY;
  const bottom = orderY + orderHeight;
  for (const name of [
    "order_id",
    "shop_url",
    "decision_id",
    "total_price",
    "currency",
    "created_at",
  ]) {
    const row = new RegExp(`<text class="ns" x="[\\d.]+" y="([\\d.]+)">${name}<`).exec(svg);
    assert.ok(row, `expected a field row for ${name}`);
    const y = Number(row[1]);
    assert.ok(
      y > top && y < bottom,
      `${name} row at y=${y} must fall inside the order box [${top}, ${bottom}]`,
    );
  }
});

test("an er diagram needs at least one entity", () => {
  assert.throws(
    () => renderEr({ kind: "er", id: "e", title: "empty", entities: [] }),
    /at least one entity/,
  );
});

test("a relation referencing an unknown entity fails loudly rather than drawing a partial diagram", () => {
  assert.throws(
    () =>
      renderEr({
        kind: "er",
        id: "bad",
        title: "Bad",
        entities: [{ id: "a", label: "a", col: 0, row: 0, fields: [] }],
        relations: [{ from: "a", to: "ghost", label: "x" }],
      }),
    /unknown entity ghost/,
  );
});

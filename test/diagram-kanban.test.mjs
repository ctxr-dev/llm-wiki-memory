import { test } from "node:test";
import assert from "node:assert/strict";
import { renderKanban } from "../scripts/lib/diagrams/kanban.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const SPEC = {
  kind: "kanban",
  id: "k",
  title: "Sprint board",
  columns: [
    {
      id: "todo",
      label: "To do",
      cards: [
        {
          label: "Port the diagram assembly pipeline over to the new shared text module",
          sub: "owner: core",
          kind: "focal",
        },
        { label: "Write kanban tests" },
      ],
    },
    {
      id: "doing",
      label: "In progress",
      wip: 3,
      cards: [{ label: "Review PR", sub: "TICKET-42 · nadia" }],
    },
    {
      id: "done",
      label: "Done",
      cards: [],
    },
  ],
};

test("a kanban board renders one zone frame per column, all at the same height", () => {
  const svg = renderKanban(SPEC);
  assert.match(svg, /^<svg viewBox="/);
  assert.match(svg, /<\/svg>$/);
  const frames = [...svg.matchAll(/<rect class="zone" x="([\d.]+)"[^>]*height="([\d.]+)"/g)];
  assert.equal(frames.length, 3, "one frame per column, including the empty one");
  assert.equal(frames[0][2], frames[1][2], "frames share a height");
  assert.equal(frames[1][2], frames[2][2], "the empty column's frame matches its neighbours");
});

test("cards render as nb rects and carry their labels and sub-lines", () => {
  const svg = renderKanban(SPEC);
  assert.equal((svg.match(/<rect class="nb[ "]/g) ?? []).length, 3, "3 cards across the board");
  assert.match(svg, /<rect class="nb focal"/, "the focal card keeps its kind modifier");
  assert.ok(svg.includes("1/3"), "wip header shows count over limit as n/limit");
  assert.ok(svg.includes("TICKET-42"), "sub-lines reach the output");
  assert.ok(svg.includes(">0<"), "the empty column shows a bare zero count, no limit");
});

test("a long card label wraps across multiple tspans", () => {
  const svg = renderKanban(SPEC);
  const nameBlock = /<text class="nn" x="[\d.]+" y="[\d.]+">(<tspan[^]+?<\/tspan>)+<\/text>/g;
  const withTwoOrMoreTspans = [...svg.matchAll(nameBlock)].filter(
    (m) => (m[0].match(/<tspan/g) ?? []).length >= 2,
  );
  assert.ok(withTwoOrMoreTspans.length >= 1, "the long label produced a wrapped, multi-line name");
});

test("cards within a column never overlap", () => {
  const svg = renderKanban(SPEC);
  /** @type {{ x: number, y: number, w: number, h: number }[]} */
  const cards = [
    ...svg.matchAll(
      /<rect class="nb[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
    ),
  ].map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }));
  const inTodo = cards.filter((c) => c.x === cards[0].x);
  assert.equal(inTodo.length, 2, "the todo column has two stacked cards");
  const [first, second] = inTodo.sort((a, b) => a.y - b.y);
  assert.ok(
    second.y >= first.y + first.h,
    "the second card starts at or below the first card's bottom edge",
  );
});

test("a rendered kanban board has no geometric findings", () => {
  const svg = renderKanban(SPEC);
  assert.deepEqual(validateSvg(svg), []);
});

test("a duplicate column id fails loudly rather than drawing a partial board", () => {
  assert.throws(
    () =>
      renderKanban({
        ...SPEC,
        columns: [...SPEC.columns, { id: "todo", label: "Also todo", cards: [] }],
      }),
    /duplicate kanban column id: todo/,
  );
});

test("an unknown card kind fails loudly rather than drawing a partial board", () => {
  assert.throws(
    () =>
      renderKanban({
        ...SPEC,
        columns: [{ id: "x", label: "X", cards: [{ label: "bad", kind: "danger" }] }],
      }),
    /unknown card kind "danger" on card "bad" in column "x"/,
  );
});

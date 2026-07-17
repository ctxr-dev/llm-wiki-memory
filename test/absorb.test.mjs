import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

process.env.MEMORY_EMBED_BACKEND = "lexical";
const { setupWorkspace, cleanup } = await import("./harness.mjs");
const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const ISSUES_TOPOLOGY = `
  - path: issues
    placement_facets: []
    consolidate: none
    topology:
      strategy: caller_path
      helper:
        module: ./issues-helper.mjs
      file_kinds:
        knowledge:
          required_facets: [tracker, prefix, number]
          to_path: |
            function to_path({ tracker, prefix, number }) {
              const n = Number(number);
              return \`issues/\${tracker}/\${prefix}/\${Math.floor(n/1000)}/\${Math.floor((n%1000)/10)}/\${n%10}/\${prefix}-\${n}.md\`;
            }
          from_path: |
            function from_path(rel) {
              const m = /^issues\\/([^/]+)\\/([^/]+)\\/(\\d+)\\/(\\d+)\\/(\\d+)\\/[^/]+-(\\d+)\\.md$/.exec(rel);
              return m ? { tracker: m[1], prefix: m[2], number: parseInt(m[6], 10) } : null;
            }
      facet_inputs:
        tracker: { type: string }
        prefix: { type: string }
        number: { type: integer, minimum: 1 }
`;

fs.writeFileSync(
  path.join(wiki, ".layout", "layout.yaml"),
  `mode: hosted
vocabularies:
  subject_domains:
    - architecture
    - operations
    - data
    - general
layout:
  - path: knowledge
    placement_facets: [area, subject]
    facet_rules:
      subject: { kind: path, vocabulary: subject_domains, fallback: general }
    max_depth: 6
    consolidate: refine
  - path: self_improvement
    placement_facets: [area, task_type]
    max_depth: 5
    consolidate: refine
  - path: daily
    placement_strategy: daily-date
    max_depth: 5
    consolidate: none
` + ISSUES_TOPOLOGY,
);

const store = await import("../scripts/lib/wiki-store.mjs");
store._resetLayoutCacheForTests();
const { absorbDocument } = await import("../scripts/lib/absorb.mjs");

afterEach(() => {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  delete process.env.MEMORY_LLM_MOCK_FAIL_INDICES;
});

function withMock(json, fn) {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify(json);
  return fn();
}
function withDownLLM(fn) {
  process.env.MEMORY_LLM_PROVIDER = "mock"; // no MOCK_RESPONSE -> mockResponse() throws
  return fn();
}
function absPath(id) {
  return path.join(wiki, String(id).split("/").join(path.sep));
}
function readLeaf(id) {
  return matter(fs.readFileSync(absPath(id), "utf8"));
}
function countByBasename(root, base) {
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === base) n += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return n;
}

const BODY =
  "# Checkout redesign\n\nThe checkout service is being re-architected.\n\n" + "x ".repeat(400);

test("absorbDocument: places by inferred facets, stores body verbatim, marks memory.full", async () => {
  const res = await withMock(
    { area: "platform", atom_type: "reference", subject: ["architecture"] },
    () => absorbDocument({ text: BODY, name: "checkout.md", category: "knowledge" }),
  );
  assert.equal(res.dir, "knowledge/platform/architecture", "area + subject path");
  assert.equal(res.id, "knowledge/platform/architecture/checkout.md");
  const leaf = readLeaf(res.id);
  assert.equal(leaf.content.trim(), BODY.trim(), "body stored verbatim (not shortened)");
  assert.equal(leaf.data.memory.full, true, "memory.full persisted");
});

test("absorbDocument: dryRun returns the proposal and writes NOTHING", async () => {
  const before = countByBasename(path.join(wiki, "knowledge"), "dry.md");
  const res = await withMock({ area: "ops", atom_type: "reference", subject: ["operations"] }, () =>
    absorbDocument({ text: BODY, name: "dry.md", category: "knowledge", dryRun: true }),
  );
  assert.equal(res.dir, "knowledge/ops/operations");
  assert.equal(res.id, undefined, "no id on a dry run");
  assert.equal(countByBasename(path.join(wiki, "knowledge"), "dry.md"), before, "no leaf written");
});

test("absorbDocument: caller overrides win over inferred facets", async () => {
  const res = await withMock(
    { area: "platform", atom_type: "reference", subject: ["architecture"] },
    () =>
      absorbDocument({
        text: BODY,
        name: "override.md",
        category: "knowledge",
        overrides: { area: "billing" },
      }),
  );
  assert.equal(
    res.dir,
    "knowledge/billing/architecture",
    "override area applied, inferred subject kept",
  );
});

test("absorbDocument: LLM unavailable -> sentinel placement (area=unscoped, subject omitted), never throws", async () => {
  const res = await withDownLLM(() =>
    absorbDocument({ text: BODY, name: "offline.md", category: "knowledge" }),
  );
  assert.equal(res.dir, "knowledge/unscoped/general", "sentinel area + subject fallback");
  assert.equal(readLeaf(res.id).data.memory.full, true);
});

test("absorbDocument: re-absorb (same name) is idempotent even when the model drifts to a new area/subject", async () => {
  await withMock({ area: "platform", atom_type: "reference", subject: ["architecture"] }, () =>
    absorbDocument({ text: BODY, name: "drift.md", category: "knowledge" }),
  );
  const second = await withMock({ area: "billing", atom_type: "decision", subject: ["data"] }, () =>
    absorbDocument({ text: "# Drift\n\nUpdated body.", name: "drift.md", category: "knowledge" }),
  );
  assert.equal(second.dir, "knowledge/platform/architecture", "reused the original placement");
  assert.equal(
    countByBasename(path.join(wiki, "knowledge"), "drift.md"),
    1,
    "exactly one leaf, no duplicate",
  );
  assert.match(readLeaf(second.id).content, /Updated body/, "content overwritten in place");
});

test("absorbDocument: refuses the gated self_improvement category", async () => {
  await assert.rejects(
    () =>
      withMock({ area: "x" }, () =>
        absorbDocument({ text: BODY, name: "l.md", category: "self_improvement" }),
      ),
    /self_improvement/,
  );
});

test("absorbDocument: refuses a topology category (issues)", async () => {
  await assert.rejects(
    () =>
      withMock({ area: "x" }, () =>
        absorbDocument({ text: BODY, name: "i.md", category: "issues" }),
      ),
    /topology/,
  );
});

test("absorbDocument: unknown category throws with the declared list", async () => {
  await assert.rejects(
    () => absorbDocument({ text: BODY, name: "n.md", category: "nope" }),
    /unknown category 'nope'/,
  );
});

test("absorbDocument: a document with no `# ` heading still absorbs (title from the name slug)", async () => {
  const res = await withMock(
    { area: "platform", atom_type: "reference", subject: ["architecture"] },
    () =>
      absorbDocument({
        text: "no heading here, just prose.\n" + "z ".repeat(50),
        name: "no-heading.md",
        category: "knowledge",
      }),
  );
  assert.ok(res.id?.endsWith("no-heading.md"), res.id);
  assert.equal(readLeaf(res.id).data.memory.full, true);
});

test("absorbDocument: empty text and missing name are refused", async () => {
  await assert.rejects(
    () => absorbDocument({ text: "   ", name: "e.md", category: "knowledge" }),
    /empty/,
  );
  await assert.rejects(
    () => absorbDocument({ text: BODY, name: "", category: "knowledge" }),
    /name/,
  );
});

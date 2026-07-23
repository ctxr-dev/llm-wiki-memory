import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const { renderDailyDocument } = await import("../scripts/hooks/flush.mjs");

// A minimal facet-placed layout that opts `knowledge` OUT of auto-distill.
const LAYOUT_KNOWLEDGE_OFF = `layout:
  - path: knowledge
    placement_facets: [area, atom_type]
    auto_distill: false
  - path: self_improvement
    placement_facets: [area, task_type]
  - path: plans
    placement_facets: [area]
  - path: investigations
    placement_facets: [area]
  - path: daily
    placement_strategy: daily-date
`;

const KNOWLEDGE_ATOM = {
  type: "decision",
  title: "Use X over Y for concurrency",
  body: "Use X over Y.\nWhy: X is safer under load.\nHow to apply: pick X for new code.",
  tags: ["arch"],
  metadata: { area: "infra", task_type: "planning" },
};

test("compile SKIPS promotion into a category with auto_distill:false (human-only)", () => {
  fs.writeFileSync(path.join(wiki, ".layout", "layout.yaml"), LAYOUT_KNOWLEDGE_OFF);
  store._resetLayoutCacheForTests();

  const text = renderDailyDocument({
    atoms: [KNOWLEDGE_ATOM],
    source: {
      sessionId: "autodistill-off",
      cwd: "/tmp/proj",
      hookEvent: "session-end",
      capturedAtMs: Date.parse("2026-07-01T10:00:00Z"),
      body: "seed transcript",
    },
  });
  store.saveDocument({ name: "daily-2026-07-01-100000001.md", text, datasetId: "daily" });

  // No LLM mock needed: the auto_distill guard skips BEFORE any LLM decision.
  const r = runScript("scripts/cli.mjs", ["compile", "--force"], {
    env: { MEMORY_LLM_PROVIDER: "mock", MEMORY_LLM_MOCK_RESPONSE: "" },
  });
  assert.equal(r.status, 0, `compile should succeed (skip is clean): ${r.stderr}`);

  store._resetLayoutCacheForTests();
  const knowledge = store.listDocuments({ datasetId: "knowledge" }).documents;
  assert.equal(knowledge.length, 0, "nothing promoted into the auto_distill:false category");

  // The daily was disabled cleanly (clean skip, no retry loop).
  const dailies = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  assert.equal(dailies.length, 0, "the source daily is disabled after a clean skip");
});

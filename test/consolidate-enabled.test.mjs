import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const { consolidateMemory } = await import("../scripts/consolidate.mjs");
const { runCronJob, cronHealth } = await import("../scripts/cron-job.mjs");
const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");
after(() => __clearSettingsForTest());

// Every category must declare `consolidate:` or the orchestrator refuses to run
// — so the enabled-path test reaches real work instead of a layout error.
fs.writeFileSync(
  path.join(wiki, ".layout", "layout.yaml"),
  `mode: hosted
layout:
  - path: knowledge
    placement_facets: [area, atom_type]
    max_depth: 5
    consolidate: refine
  - path: self_improvement
    placement_facets: [area, task_type]
    max_depth: 5
    consolidate: refine
  - path: plans
    placement_facets: [area]
    max_depth: 5
    consolidate: none
  - path: investigations
    placement_facets: [area]
    max_depth: 5
    consolidate: none
  - path: daily
    placement_strategy: daily-date
    max_depth: 5
    consolidate: none
`,
);

const NOW = new Date("2026-06-02T12:00:00Z");

test("consolidate.enabled=false: consolidateMemory() is a no-op, even with force:true", async () => {
  __setSettingsForTest({ consolidate: { enabled: false } });
  try {
    const plain = await consolidateMemory({ now: NOW });
    assert.equal(plain.ok, true);
    assert.equal(plain.skipped, "disabled", "no passes run when disabled");

    const forced = await consolidateMemory({ force: true, now: NOW });
    assert.equal(forced.skipped, "disabled", "force does NOT override the disable flag");

    const dryRun = await consolidateMemory({ dryRun: true, now: NOW });
    assert.equal(dryRun.skipped, "disabled");
  } finally {
    __clearSettingsForTest();
  }
});

test("consolidate.enabled=false: runCronJob() no-ops (no compile, no consolidate)", async () => {
  __setSettingsForTest({ consolidate: { enabled: false } });
  try {
    const entry = await runCronJob();
    assert.equal(entry.ok, true);
    assert.equal(entry.skipped, "disabled");
    assert.equal(entry.compile, null, "compile step did not run");
    assert.equal(entry.consolidate, null, "consolidate step did not run");
  } finally {
    __clearSettingsForTest();
  }
});

test("consolidate.enabled=false: cronHealth() reports healthy + disabled", () => {
  __setSettingsForTest({ consolidate: { enabled: false } });
  try {
    const health = cronHealth();
    assert.equal(health.healthy, true, "a deliberate disable is not an unhealthy cron");
    assert.equal(health.disabled, true);
    assert.match(health.summary, /consolidation disabled/);
    assert.ok(health.summary.length <= 200, "summary stays within the context budget");
  } finally {
    __clearSettingsForTest();
  }
});

test("consolidate.enabled=true: consolidateMemory() runs (not skipped:disabled)", async () => {
  __setSettingsForTest({ consolidate: { enabled: true } });
  try {
    const r = await consolidateMemory({ dryRun: true, llm: false, now: NOW });
    assert.equal(r.ok, true);
    assert.notEqual(r.skipped, "disabled", "the gate is open when enabled");
    assert.equal(r.dryRun, true);
  } finally {
    __clearSettingsForTest();
  }
});

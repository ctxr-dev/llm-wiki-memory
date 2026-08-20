import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "../harness.mjs";

// LIVE confidence gate (JL9). Runs the REAL compile through the `claude` CLI with
// the judge-in-the-loop and asserts the wiki quality it produces. OPT-IN: it is
// skipped unless MEMORY_LLM_LIVE=1 (and the claude CLI is on PATH). Kept out of
// `npm test` (it lives under test/e2e/); run it via `npm run test:llm-live`. It
// is slow — one real compile + up to 3 judge round-trips per atom + a final
// independent judge pass — so the node:test timeout is raised well above
// MEMORY_LLM_TIMEOUT_MS × leaves.
const LIVE = process.env.MEMORY_LLM_LIVE === "1";
const SKIP = LIVE ? false : "set MEMORY_LLM_LIVE=1 (claude CLI on PATH) to run the live judge e2e";
const TEST_TIMEOUT_MS = 15 * 60_000;

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

// The compile subprocess reads THIS settings.yaml: enable the judge (the harness
// default disables it) and keep the lexical embed backend (no model download).
if (LIVE) {
  fs.writeFileSync(
    path.join(dataDir, "settings", "settings.yaml"),
    "embed:\n  backend: lexical\nquality:\n  judgeEnabled: true\n  maxRounds: 3\n",
  );
}

const store = await import("../../scripts/lib/wiki-store.mjs");
const { renderDailyDocument } = await import("../../scripts/hooks/flush.mjs");
const { health } = await import("../../scripts/lib/llm.mjs");
const { judgeLeaf } = await import("../../scripts/lib/quality-loop.mjs");

const VOLATILE_ATOM = {
  type: "pattern-gotcha",
  title: "Bumblebee context propagation wiring",
  body:
    "Snapshot Baggage before async boundaries. See BumblebeeFilter.scala:42, then " +
    "BaggageUtil.scala:88, and finally ContextPropagator.scala:130 for the exact wiring.",
  tags: ["bumblebee", "kamon"],
  metadata: { area: "bumblebee", task_type: "debugging" },
};
const CONCEPTUAL_ATOM = {
  type: "bug-root-cause",
  title: "Kafka partition key must derive from WebhooksOrder.id",
  body:
    "Kafka partition key must derive from the original WebhooksOrder.id, not the optional " +
    "eventContext.\nWhy: routing broke when keyed on eventContext (absent for replays).\n" +
    "How to apply: always key the producer on WebhooksOrder.id.",
  tags: ["kafka", "webhooks"],
  metadata: { area: "webhooks", task_type: "debugging", error_pattern: "wrong-partition-key" },
};

function seedDaily(name, atoms) {
  const text = renderDailyDocument({
    atoms,
    source: {
      sessionId: name,
      cwd: "/tmp/proj",
      hookEvent: "session-end",
      capturedAtMs: Date.parse("2026-07-01T10:00:00Z"),
      body: "seed transcript",
    },
  });
  store.saveDocument({ name, text, datasetId: "daily" });
}

const VOLATILE_LOCATOR = /\b[\w./-]*\.(?:scala|mjs|ts|py|rb|go|java):\d{1,6}\b|\bL\d{2,6}\b/g;

test(
  "live: compile+judge de-volatilizes/flags a volatile atom and keeps the conceptual one durable",
  { skip: SKIP, timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const probe = await health();
    if (!probe?.available) {
      t.skip(`LLM provider not available: ${probe?.reason}`);
      return;
    }

    seedDaily("daily-2026-07-01-100000001.md", [VOLATILE_ATOM]);
    seedDaily("daily-2026-07-01-100000002.md", [CONCEPTUAL_ATOM]);

    const r = runScript("scripts/cli.mjs", ["compile", "--force"], {
      env: { MEMORY_LLM_PROVIDER: "claude", MEMORY_EMBED_BACKEND: "lexical" },
    });
    assert.equal(r.status, 0, `compile failed: ${r.stderr}`);

    const knowledge = store.listDocuments({ datasetId: "knowledge", enabled: "true" }).documents;

    // The conceptual atom must survive as a durable leaf.
    const conceptual = knowledge.find((d) => /webhooks|partition/i.test(d.name));
    assert.ok(
      conceptual,
      `conceptual atom should be promoted; got ${JSON.stringify(knowledge.map((d) => d.name))}`,
    );

    // The volatile atom is acceptable in exactly the durable outcomes: dropped
    // (not promoted), flagged unverified, or rewritten so line locators no
    // longer dominate. Any surviving knowledge leaf must not be a locator dump.
    let flaggedCount = 0;
    for (const d of knowledge) {
      const doc = store.readDocument({ documentId: d.id, datasetId: "knowledge" });
      if (doc.metadata?.quality === "unverified") flaggedCount += 1;
      const locators = (String(doc.text || "").match(VOLATILE_LOCATOR) || []).length;
      const hasFraming = /(^|\n)\s*(why|how to apply)\s*:/i.test(doc.text || "");
      assert.ok(
        locators < 3 || hasFraming || doc.metadata?.quality === "unverified",
        `no promoted leaf may be a volatile-locator dump: ${d.name} (${locators} locators)`,
      );

      // Final independent judge pass: every surviving leaf either passes the
      // judge OR is explicitly flagged unverified (never a silent low-quality leaf).
      const verdict = await judgeLeaf({
        category: "knowledge",
        title: String(doc.metadata?.focus || d.name),
        body: String(doc.text || ""),
      });
      assert.ok(
        verdict.pass || doc.metadata?.quality === "unverified",
        `leaf ${d.name} must pass the independent judge or be flagged unverified (score=${verdict.score})`,
      );
    }
    process.stderr.write(
      `[e2e] live judge: ${knowledge.length} knowledge leaf(s), ${flaggedCount} flagged unverified\n`,
    );
  },
);

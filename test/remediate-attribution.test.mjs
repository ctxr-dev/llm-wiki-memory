import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));
process.env.MEMORY_LLM_PROVIDER = "mock";

const store = await import("../scripts/lib/wiki-store.mjs");
const { remediate, remediationCategories } = await import("../scripts/remediate-attribution.mjs");
const { __clearSettingsForTest } = await import("../scripts/lib/settings.mjs");

function resetLlm() {
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  __clearSettingsForTest();
}
after(() => resetLlm());

function seed(name, text) {
  const r = store.saveDocument({
    name,
    text,
    datasetId: "self_improvement",
    metadata: { area: "infra", task_type: "refactor", error_pattern: "attr-test" },
  });
  if (!r.ok) throw new Error(`seed failed: ${JSON.stringify(r)}`);
  return r.created.document.id;
}

function purge() {
  for (const cat of ["self_improvement", "knowledge"]) {
    const { documents } = store.listDocuments({ datasetId: cat });
    for (const d of documents) {
      try {
        store.deleteDocument({ documentId: d.id });
      } catch {
        /* best effort */
      }
    }
  }
}

test("remediationCategories keeps only the body-only categories (knowledge + self_improvement)", () => {
  assert.deepEqual(
    remediationCategories([
      "knowledge",
      "self_improvement",
      "daily",
      "plans",
      "investigations",
      "issues",
      "weird",
    ]),
    ["knowledge", "self_improvement"],
    "plans/investigations/issues excluded (lifecycle frontmatter); daily raw; unknown dropped",
  );
});

test("dry-run flags only attribution leaves and does NOT write", async () => {
  purge();
  resetLlm();
  const attrId = seed(
    "lesson-attr-2026-06-01-000000000.md",
    "# Prefer IO\n\nThe user said to prefer IO for concurrency.\nWhy: safety.",
  );
  seed(
    "lesson-clean-2026-06-01-000000000.md",
    "# Await writes\n\nAwait async write calls.\nWhy: race.",
  );
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    leaf_id: attrId,
    action: "rewrite",
    body: "# Prefer IO\n\nPrefer IO for concurrency.\nWhy: safety.",
  });
  const r = await remediate({ dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(
    r.flagged,
    1,
    "only the attribution leaf is flagged (clean one skipped by pre-filter)",
  );
  assert.equal(r.rewritten, 1);
  assert.match(
    store.readLeafForConsolidate({ documentId: attrId }).text,
    /user said/,
    "dry-run wrote nothing",
  );
});

test("apply rewrites the flagged leaf in place (attribution removed, technical kept)", async () => {
  purge();
  resetLlm();
  const attrId = seed(
    "lesson-attr2-2026-06-01-000000000.md",
    "# Prefer IO\n\nThe user said to prefer IO for concurrency.\nWhy: safety.",
  );
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    leaf_id: attrId,
    action: "rewrite",
    body: "# Prefer IO\n\nPrefer IO for concurrency.\nWhy: safety.",
  });
  const r = await remediate({ dryRun: false });
  assert.equal(r.rewritten, 1);
  const leaf = store.readLeafForConsolidate({ documentId: attrId });
  assert.doesNotMatch(leaf.text, /user said/, "attribution removed from the leaf body");
  assert.match(leaf.text, /Prefer IO for concurrency/, "technical content kept");
});

test("apply preserves the leaf's focus even when the rewritten body drops its heading", async () => {
  purge();
  resetLlm();
  const attrId = seed(
    "lesson-focus-2026-06-01-000000000.md",
    "# Verify PR merge before tagging\n\nThe user said 'I merged' but the PR was open.\nWhy: state lags.",
  );
  const before = store.readLeafForConsolidate({ documentId: attrId }).frontmatter.focus;
  assert.equal(before, "Verify PR merge before tagging", "seed focus derives from the heading");
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    leaf_id: attrId,
    action: "rewrite",
    body: "Confirm the PR is merged on origin before tagging; state can lag.\nWhy: state lags.",
  });
  const r = await remediate({ dryRun: false });
  assert.equal(r.rewritten, 1);
  const after = store.readLeafForConsolidate({ documentId: attrId });
  assert.equal(
    after.frontmatter.focus,
    "Verify PR merge before tagging",
    "focus preserved via metadata.title, not degraded to the filename slug",
  );
  assert.doesNotMatch(after.text, /user said/, "attribution still removed");
});

test("a full/absorbed leaf is skipped even with attribution (verbatim by contract)", async () => {
  purge();
  resetLlm();
  const r0 = store.saveDocument({
    name: "lesson-full-2026-06-01-000000000.md",
    text: "# Absorbed\n\nThe user said to prefer IO for concurrency.\nWhy: safety.",
    datasetId: "self_improvement",
    metadata: { area: "infra", task_type: "refactor", error_pattern: "attr-test", full: true },
  });
  if (!r0.ok) throw new Error(`seed failed: ${JSON.stringify(r0)}`);
  const fullId = r0.created.document.id;
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    leaf_id: fullId,
    action: "rewrite",
    body: "# Absorbed\n\nPrefer IO for concurrency.\nWhy: safety.",
  });
  const r = await remediate({ dryRun: false });
  assert.ok(r.skippedFull >= 1, "the full leaf is counted as skipped");
  assert.equal(r.flagged, 0, "a full leaf never reaches the flag/rewrite stage");
  assert.match(
    store.readLeafForConsolidate({ documentId: fullId }).text,
    /user said/,
    "full leaf left verbatim",
  );
});

test("no LLM available -> no-op (skipped)", async () => {
  resetLlm();
  const r = await remediate({ dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, "llm-unavailable");
});

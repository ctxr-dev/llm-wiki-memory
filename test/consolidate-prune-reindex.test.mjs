import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

// The consolidate `prune-empty-ancestors` pass must rebuild the surviving
// ancestor after it removes an emptied subtree, so it never leaves a stale
// parent->pruned-child index ref. Runs ONLY that pass (deterministic, no LLM).

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));
const store = await import("../scripts/lib/wiki-store.mjs");
const { doctor } = await import("../scripts/lib/doctor.mjs");

test("consolidate prune-empty-ancestors rebuilds the survivor (no stale ref left)", () => {
  // Keep one leaf so `knowledge` stays meaningful (survivor = knowledge, not root).
  const keep = store.writeMemory({
    name: "Keep.md",
    text: "# Keep\n\nbody marker Keep, long enough to pass content checks.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "keep" },
  });
  assert.ok(keep.ok, JSON.stringify(keep));
  const k = store.writeMemory({
    name: "Z.md",
    text: "# Z\n\nbody marker Z, long enough to pass content checks.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "zone" },
  });
  assert.ok(k.ok, JSON.stringify(k));
  const id = k.created.document.id;
  assert.match(id, /knowledge\/zone\//, `seeded under zone; got ${id}`);

  // Out-of-band drift: remove the leaf, leaving empty index-only dirs and a
  // stale index ref to the gone leaf (what a manual rm / cloud-sync scramble does).
  fs.rmSync(path.join(wiki, id));
  assert.ok(doctor(wiki).summary.brokenRefs > 0, "a stale ref exists before consolidate");

  const r = runScript("scripts/cli.mjs", [
    "consolidate",
    "--force",
    "--no-llm",
    "--passes=prune-empty-ancestors",
  ]);
  assert.equal(r.status, 0, `consolidate ok; got ${r.status}: ${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(wiki, "knowledge/zone")), "empty zone subtree pruned");
  assert.ok(fs.existsSync(path.join(wiki, path.dirname(path.dirname(keep.created.document.id)))), "kept area untouched");
  // Defense-in-depth beyond doctor(): the survivor index.md itself drops `zone`.
  assert.doesNotMatch(
    fs.readFileSync(path.join(wiki, "knowledge/index.md"), "utf8"),
    /zone\//,
    "survivor knowledge/index.md no longer references the pruned zone",
  );
  assert.equal(
    doctor(wiki).summary.brokenRefs,
    0,
    `survivor rebuilt, no stale ref; got ${JSON.stringify(doctor(wiki).brokenRefs)}`,
  );
});

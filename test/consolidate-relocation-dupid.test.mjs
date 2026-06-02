// Regression coverage for the consolidate relocation DUP-ID bug.
//
// Repro (observed in the field): consolidate's llm-merge pass rewrote a keeper
// pinned to its current dir via saveDocument, then stamped `consolidated_at`
// with an UNPINNED updateDocMetadata. For a keeper sitting at a legacy,
// off-canonical path (e.g. a pre-subject-axis location without the `general/`
// subject segment), that second call recomputed the canonical placement and
// relocated the leaf as a side effect. When the canonical destination already
// held a copy of the same leaf (a within-run double-merge), updateDocMetadata
// silently fell back to an in-place rewrite and LEFT BOTH files on disk: two
// leaves sharing one id -> DUP-ID (which `validate` and `heal` then flag, but
// consolidate reported errors:0).
//
// The fix has two layers:
//   1. wiki-store.updateDocMetadata accepts a `placementOverride` to pin a leaf
//      in place, and on a relocation collision (the canonical destination is
//      already occupied by a same-basename leaf) it REFUSES rather than touching
//      it, mirroring saveDocument's guard. (The old code silently fell back to
//      an in-place rewrite and LEFT BOTH files = DUP-ID.)
//   2. consolidate routes every metadata stamp through stampLeafMetadata, which
//      pins to the leaf's own dir so a merge keeper / soon-to-be-archived loser
//      is never relocated mid-pass. This is the layer that actually fixes the
//      bug: consolidate never relocates, so it never reaches the collision branch.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const { consolidateMemory } = await import("../scripts/consolidate.mjs");
const cli = await import("../scripts/lib/wiki-cli.mjs");

after(() => {
  delete process.env.MEMORY_LLM_PROVIDER;
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function absFor(documentId) {
  return path.join(wiki, String(documentId).split("/").join(path.sep));
}

function exists(documentId) {
  return fs.existsSync(absFor(documentId));
}

function stampUpdated(documentId, updated) {
  const abs = absFor(documentId);
  const parsed = matter(fs.readFileSync(abs, "utf8"));
  parsed.data.updated = updated;
  fs.writeFileSync(
    abs,
    matter.stringify(`\n${parsed.content.trim()}\n`, parsed.data, { lineWidth: -1 }),
  );
}

// Walk the content categories and return every leaf `id` that appears at more
// than one path — i.e. the exact DUP-ID condition the bug produced.
function findDuplicateIds(root) {
  const seen = new Map();
  const dups = new Set();
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!ent.name.endsWith(".md") || ent.name === "index.md") continue;
      const id = matter(fs.readFileSync(p, "utf8")).data?.id;
      if (!id) continue;
      if (seen.has(id)) dups.add(id);
      seen.set(id, p);
    }
  };
  for (const cat of ["knowledge", "self_improvement", "plans", "investigations", "daily", "issues"]) {
    walk(path.join(root, cat));
  }
  return [...dups];
}

// ─── wiki-store.updateDocMetadata (the layer-1 fix) ──────────────────────────

test("updateDocMetadata refuses a relocation collision instead of clobbering a different leaf", () => {
  const seed = store.saveDocument({
    name: "dupcheck-collide-2026-06-01-000000000.md",
    text: "CANONICAL BODY — the leaf already living at the canonical general/ path.",
    datasetId: "knowledge",
    metadata: { atom_type: "pattern-gotcha", area: "backend", project_module: "testproj" },
  });
  const canonicalId = seed.created.document.id;
  assert.ok(canonicalId.includes("/general/"), `seeded at canonical general/ path (got ${canonicalId})`);
  const legacyId = canonicalId.replace("/general/", "/");

  // A DIFFERENT leaf that happens to share the basename (ids derive from the
  // basename, so the two share an id) sits at the legacy parent path. Give it a
  // distinct body so a clobber would be observable as data loss.
  fs.copyFileSync(absFor(canonicalId), absFor(legacyId));
  const legacyAbs = absFor(legacyId);
  const legacyData = matter(fs.readFileSync(legacyAbs, "utf8")).data;
  fs.writeFileSync(
    legacyAbs,
    matter.stringify("\nLEGACY BODY — a different leaf that must not be destroyed.\n", legacyData, { lineWidth: -1 }),
  );

  const canonicalBefore = fs.readFileSync(absFor(canonicalId), "utf8");
  const legacyBefore = fs.readFileSync(legacyAbs, "utf8");

  // Stamping the legacy leaf recomputes its canonical placement (general/),
  // which is occupied. It must REFUSE, not clobber, and not half-apply.
  const r = store.updateDocMetadata({
    documentId: legacyId,
    metadata: { consolidated_at: "2026-06-03T00:00:00Z" },
  });
  assert.equal(r.ok, false, "refused the colliding relocation");
  assert.match(r.reason || "", /occupied by a different leaf/);
  assert.equal(fs.readFileSync(absFor(canonicalId), "utf8"), canonicalBefore, "canonical destination leaf untouched");
  assert.equal(fs.readFileSync(legacyAbs, "utf8"), legacyBefore, "legacy source leaf untouched (no half-applied write)");

  // Clean up the staged duplicate so the shared wiki stays single-id for later tests.
  fs.rmSync(legacyAbs);
});

test("updateDocMetadata with placementOverride pins the leaf in place (no relocation)", () => {
  const seed = store.saveDocument({
    name: "dupcheck-pin-2026-06-01-000000000.md",
    text: "# Pin\n\nA leaf that must stay at its legacy parent path when only bookkeeping is stamped.",
    datasetId: "knowledge",
    metadata: { atom_type: "pattern-gotcha", area: "frontend", project_module: "testproj" },
  });
  const canonicalId = seed.created.document.id;
  const legacyId = canonicalId.replace("/general/", "/");
  // Relocate the leaf to a legacy parent path (no subject segment).
  fs.renameSync(absFor(canonicalId), absFor(legacyId));
  assert.ok(exists(legacyId) && !exists(canonicalId), "leaf seeded at a legacy parent path");

  const r = store.updateDocMetadata({
    documentId: legacyId,
    metadata: { consolidated_at: "2026-06-03T00:00:00Z" },
    placementOverride: path.posix.dirname(legacyId),
  });
  assert.equal(r.ok, true);
  assert.ok(!r.relocated, "no relocation reported when pinned");
  assert.equal(exists(legacyId), true, "leaf stays at its pinned legacy path");
  assert.equal(exists(canonicalId), false, "leaf was NOT relocated to canonical general/");
});

// ─── consolidate end-to-end (the layer-2 fix) ────────────────────────────────

test("consolidate 3A merge keeps a legacy-path keeper in place (stable id, no DUP-ID)", async () => {
  process.env.MEMORY_LLM_PROVIDER = "mock";
  const SAME = "# Cache invalidation\n\nInvalidate caches on writes carefully to avoid stale reads.";

  // Loser at its canonical general/ path.
  const loser = store.saveDocument({
    name: "merge-loser-2026-06-01-000000000.md",
    text: SAME,
    datasetId: "knowledge",
    metadata: { atom_type: "pattern-gotcha", area: "data", project_module: "testproj" },
  });
  const loserId = loser.created.document.id;
  const legacyDir = path.posix.dirname(loserId).replace(/\/general$/, "");

  // Keeper seeded NATIVELY at the legacy parent path (placementOverride), so its
  // on-disk dir differs from its canonical (general/) placement — the exact
  // pre-subject-axis shape that triggered the relocation bug.
  const keeper = store.saveDocument({
    name: "merge-keeper-2026-06-02-000000000.md",
    text: SAME,
    datasetId: "knowledge",
    metadata: { atom_type: "pattern-gotcha", area: "data", project_module: "testproj" },
    placementOverride: legacyDir,
  });
  const keeperId = keeper.created.document.id;
  assert.ok(!keeperId.includes("/general/"), `keeper seeded at a legacy path (got ${keeperId})`);

  // Newer `updated` => pickKeeper selects the legacy-path leaf as keeper.
  stampUpdated(keeperId, "2026-06-02");
  stampUpdated(loserId, "2026-06-01");

  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "merge",
    merged_body: "MERGED cache-invalidation guidance",
    keeper_id: keeperId,
    loser_id: loserId,
    reason: "fold duplicate into keeper",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-03T00:00:00Z"),
    passes: ["dedupe-by-sha256", "llm-merge-near-duplicates", "index-rebuild"],
  });
  assert.equal(r.ok, true);
  assert.ok(r.totals.merged >= 1, `merged at least one pair (got ${r.totals.merged})`);

  const keeperLeaf = store.readLeafForConsolidate({ documentId: keeperId });
  const loserLeaf = store.readLeafForConsolidate({ documentId: loserId });

  assert.ok(keeperLeaf && keeperLeaf.active, "keeper still active at its ORIGINAL legacy documentId (not relocated)");
  assert.match(keeperLeaf.text, /MERGED cache-invalidation guidance/, "keeper body rewritten with merged content");
  assert.ok(loserLeaf && loserLeaf.active === false, "loser archived");
  assert.equal(loserLeaf.memory.supersedes_id, keeperId, "loser supersedes_id points at the still-present keeper");
  assert.deepEqual(findDuplicateIds(wiki), [], "no duplicate ids after consolidate");
  assert.equal(cli.validate(wiki).ok, true, "wiki validates clean after consolidate");
});

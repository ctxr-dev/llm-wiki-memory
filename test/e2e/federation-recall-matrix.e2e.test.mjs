// B6 (recall / depth-boost matrix, §6g) — the BOOST KNOB, which federation-read.e2e
// does not exercise (it uses only the default depthBoostPerLevel=1). Same 3-level
// tree with identical-body leaves (so cosine is equal across levels and ONLY the
// boost moves the ranking), searched at boost 0 / 1 / 2 via withSettingsOverride.
// Real in-process seams (resolveWikiContext + withToolScopes + searchMemoryFiltered),
// lexical backend, realpath'd /tmp — no bootstrap, no git, no network.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup } from "../harness.mjs";
import { realTmp, rmAll, mkdirp, writeMountLayout } from "./federation-helpers.mjs";

const { dataDir } = setupWorkspace();
const { resolveWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { withToolScopes } = await import("../../mcp-server/mcp-scopes.mjs");
const { withWikiRoot } = await import("../../scripts/lib/env.mjs");
const { withSettingsOverride } = await import("../../scripts/lib/settings.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");

const MOUNT_LAYOUT = "layout:\n  - path: knowledge\n  - path: daily\n";
const TOKEN = "quokkaboost";

/** @type {string[]} */
const tmps = [];
/** @type {string | undefined} */
let savedHome;
/** @type {string} */
let deepCwd;

before(() => {
  savedHome = process.env.HOME;
  const home = realTmp("recall-boost");
  tmps.push(home);
  process.env.HOME = home;
  const repoWiki = writeMountLayout(mkdirp(home, "repo"), MOUNT_LAYOUT);
  const subWiki = writeMountLayout(mkdirp(home, "repo/sub"), MOUNT_LAYOUT);
  deepCwd = mkdirp(home, "repo/sub/x/y");
  const seed = () =>
    store.saveDocument({
      name: "same.md",
      text: `# Doc\n\nThe ${TOKEN} identical body across every level.\n`,
      datasetId: "knowledge",
      metadata: { atom_type: "reference" },
      placementOverride: "knowledge/shared",
    });
  seed(); // brain (default root)
  withWikiRoot(repoWiki, seed);
  withWikiRoot(subWiki, seed);
  // brain(0) + repo(1) + sub(2), shallowest-first
  assert.deepEqual(
    resolveWikiContext([deepCwd]).levels.map((l) => l.depth),
    [0, 1, 2],
    "three-level scope chain",
  );
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  cleanup(dataDir);
  rmAll(tmps);
});

/**
 * @param {number} boost
 * @returns {Promise<import("../../scripts/lib/types.mjs").SearchHit[]>}
 */
async function searchAtBoost(boost) {
  const { records } =
    /** @type {{ records: import("../../scripts/lib/types.mjs").SearchHit[] }} */ (
      await withToolScopes({ scopes: [deepCwd] }, () =>
        withSettingsOverride({ recall: { depthBoostPerLevel: boost } }, () =>
          store.searchMemoryFiltered({
            query: TOKEN,
            datasetId: "knowledge",
            filters: {},
            limit: 10,
          }),
        ),
      )
    );
  return records;
}

test("recall boost=0: pure cosine — depth contributes nothing (adjustedConfidence === cosine)", async () => {
  const records = await searchAtBoost(0);
  assert.equal(records.length, 3, "all three same-path leaves survive");
  const cos = records[0].cosine;
  for (const r of records) {
    assert.equal(r.cosine, cos, "identical bodies → identical cosine");
    assert.equal(r.depthBoost, 0, "boost=0 → depthBoost 0 at every depth");
    assert.equal(r.adjustedConfidence, r.cosine, "adjustedConfidence collapses to pure cosine");
  }
  // With equal cosine and zero boost, no level out-ranks another: the deepest and
  // shallowest share the SAME adjustedConfidence (depth no longer separates them).
  const scores = new Set(records.map((r) => r.adjustedConfidence));
  assert.equal(scores.size, 1, "boost=0 → every level ties (depth does not rank)");
});

test("recall boost=2: depthBoost === depth*2 and the ranking is doubled-DESC by depth", async () => {
  const records = await searchAtBoost(2);
  assert.deepEqual(
    records.map((r) => r.depth),
    [2, 1, 0],
    "still deepest-first",
  );
  for (const r of records) {
    assert.equal(r.depthBoost, r.depth * 2, "depthBoost = depth * 2");
    assert.equal(
      r.adjustedConfidence,
      r.cosine + r.depth * 2,
      "adjustedConfidence = cosine + depth*2",
    );
  }
  const spread = records[0].adjustedConfidence - records[2].adjustedConfidence;
  assert.ok(
    Math.abs(spread - 4) < 1e-9,
    `sub(depth2) - brain(depth0) separation ≈ (2-0)*2 = 4 (got ${spread})`,
  );
});

test("recall boost knob contrast: boost=1 separates by depth, boost=0 collapses that", async () => {
  const b1 = await searchAtBoost(1);
  const b0 = await searchAtBoost(0);
  const sepB1 = b1[0].adjustedConfidence - b1[b1.length - 1].adjustedConfidence;
  const sepB0 = b0[0].adjustedConfidence - b0[b0.length - 1].adjustedConfidence;
  assert.ok(
    Math.abs(sepB1 - 2) < 1e-9,
    `boost=1 → deepest-vs-shallowest separation ≈ depth spread (2) (got ${sepB1})`,
  );
  assert.equal(sepB0, 0, "boost=0 → no separation (pure cosine)");
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildFakeHome, rmAll } from "./federation-helpers.mjs";
import { MOCK_DOCS, EXPECTED_PLACEMENT, isThrow, isAbsentCategory } from "./federation-corpus.mjs";

// B5 (placement matrix, §6f) — PURE facet placement: for each mock doc, under each
// layout kind (DEF=default, REPO=knowledge-only subject-first, TRK=tracker-issues),
// `placementDirForMeta` must yield the exact dir, THROW for an out-of-vocab subject,
// or the category must be ABSENT from that layout. Store-seam only (placementDirForMeta
// under withWikiRoot + resetLayoutCache) — no bootstrap, no git, no network.
// Topology paths (T1/T2) + the write-door / local.yaml rows are separate increments.

/** @type {string[]} */
const tmps = [];
/** @type {{ DEF: string, REPO: string, TRK: string }} */
let LAYOUTS;
/** @type {{ withWikiRoot: Function, resetLayoutCache: Function, placementDirForMeta: Function }} */
let engine;
/** @type {(() => void) | undefined} */
let restore;

// Engine modules are imported LAZILY (B1 convention): a top-level import perturbs
// shared layout-cache state enough to change sibling e2e files.
before(async () => {
  const built = await buildFakeHome({
    prefix: "b5-place",
    brainTemplate: "default",
    mounts: [
      { rel: "repo-mount", template: "repo" },
      { rel: "trk-mount", template: "tracker-issues" },
    ],
  });
  restore = built.restore;
  tmps.push(built.home);
  LAYOUTS = { DEF: built.brainWiki, REPO: built.mounts[0].wikiRoot, TRK: built.mounts[1].wikiRoot };
  const env = await import("../../scripts/lib/env.mjs");
  const state = await import("../../scripts/lib/wiki-layout-state.mjs");
  const place = await import("../../scripts/lib/wiki-placement.mjs");
  engine = {
    withWikiRoot: env.withWikiRoot,
    resetLayoutCache: state.resetLayoutCache,
    placementDirForMeta: place.placementDirForMeta,
  };
});

after(() => {
  if (restore) restore();
  rmAll(tmps);
});

function categoryDeclared(wikiRoot, category) {
  const layout = fs.readFileSync(path.join(wikiRoot, ".layout", "layout.yaml"), "utf8");
  return new RegExp(`- path: ${category}\\b`).test(layout);
}

for (const [id, byLayout] of Object.entries(EXPECTED_PLACEMENT)) {
  for (const kind of /** @type {("DEF"|"REPO"|"TRK")[]} */ (["DEF", "REPO", "TRK"])) {
    test(`placement matrix: ${id} (${MOCK_DOCS[id].edge}) on the ${kind} layout`, () => {
      const doc = MOCK_DOCS[id];
      const outcome = byLayout[kind];
      const wiki = LAYOUTS[kind];
      engine.withWikiRoot(wiki, () => {
        engine.resetLayoutCache();
        if (isThrow(outcome)) {
          assert.throws(
            () => engine.placementDirForMeta(doc.datasetId, doc.metadata),
            /** @type {{ throws: RegExp }} */ (outcome).throws,
            `${id} on ${kind} must throw`,
          );
        } else if (isAbsentCategory(outcome)) {
          assert.ok(
            !categoryDeclared(wiki, doc.datasetId),
            `${doc.datasetId} must be ABSENT from the ${kind} layout`,
          );
        } else {
          assert.equal(
            engine.placementDirForMeta(doc.datasetId, doc.metadata),
            outcome,
            `${id} on ${kind} placement dir`,
          );
        }
      });
    });
  }
}

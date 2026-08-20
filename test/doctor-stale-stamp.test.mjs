// A settings change to embed.model or embed.dtype makes loadCache discard a whole category's
// vectors. Until a warm completes, every search is bounded by embed.maxColdPerRead and quietly
// returns an incomplete result set, and nothing re-embeds inside the MCP server. doctor could
// already see this — readCacheStamps parses model/backend/dtype/dim for every category — it just
// never looked at anything but the backend.
//
// It is reported WITHOUT failing `ok`. The precedent is explicit in doctor-cache-scan.mjs: the
// backend check is backend-only because "a model swap transiently mismatches every cache
// mid-migration, so flagging model/dim here would cry wolf". A dtype swap is that same class —
// every cache legitimately mismatches for the duration of the warm — so failing `doctor` (exit 3)
// would break any script that gates on it during an expected, healthy transition.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const { doctor, findStaleStampCaches } = await import("../scripts/lib/doctor.mjs");
const { embedBackend, embedModel, embedDtype } = await import("../scripts/lib/settings.mjs");
const { defaultDtypeFor } = await import("../scripts/lib/embed-inference.mjs");

// The fixture must be stamped with the workspace's LIVE signature, or a "healthy" cache is
// legitimately reported as changed and the no-false-positive tests are meaningless.
const LIVE_MODEL = embedModel() || "";
const LIVE_DTYPE = embedDtype() || defaultDtypeFor(LIVE_MODEL);

/** @param {string} category @param {Record<string, unknown>} stamp */
function writeCache(category, stamp) {
  const dir = path.join(wiki, category, ".embeddings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "embeddings.json"),
    JSON.stringify({
      backend: embedBackend(),
      model: LIVE_MODEL,
      dtype: LIVE_DTYPE,
      dim: 3,
      entries: { a: { hash: "h1", vector: [1, 0, 0] }, b: { hash: "h2", vector: [0, 1, 0] } },
      ...stamp,
    }),
  );
}

test("a cache whose dtype no longer matches the live config is reported", async () => {
  writeCache("knowledge", { dtype: `${LIVE_DTYPE}-changed` });
  const stale = findStaleStampCaches(wiki);
  const hit = stale.find((s) => s.cache.includes("knowledge"));
  assert.ok(hit, "the dtype-mismatched cache must be found");
  assert.equal(
    hit.changed.some((c) => c.name === "dtype"),
    true,
    "naming dtype as the field",
  );
  assert.equal(hit.entries, 2, "and how many vectors are about to be discarded");
});

test("a cache whose model no longer matches is reported, naming model", async () => {
  writeCache("plans", { model: "test/some-other-model" });
  const stale = findStaleStampCaches(wiki);
  const hit = stale.find((s) => s.cache.includes("plans"));
  assert.ok(hit);
  assert.equal(
    hit.changed.some((c) => c.name === "model"),
    true,
  );
});

test("a matching cache is NOT reported — no false positives", async () => {
  writeCache("investigations", {});
  const stale = findStaleStampCaches(wiki);
  assert.equal(
    stale.some((s) => s.cache.includes("investigations")),
    false,
    "an unchanged signature is healthy",
  );
});

// An absent field makes no claim, exactly as loadCache's `valid` treats it.
test("a legacy cache with no dtype stamp is not reported as stale", async () => {
  const dir = path.join(wiki, "daily", ".embeddings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "embeddings.json"),
    JSON.stringify({
      backend: embedBackend(),
      model: LIVE_MODEL,
      dim: 3,
      entries: { a: { hash: "h", vector: [1, 0, 0] } },
    }),
  );
  const stale = findStaleStampCaches(wiki);
  assert.equal(
    stale.some((s) => s.cache.includes("daily")),
    false,
    "an unstamped dtype matches any dtype",
  );
});

test("doctor reports staleStamps in the body and summary but stays ok:true", async () => {
  writeCache("knowledge", { dtype: `${LIVE_DTYPE}-changed` });
  const report = doctor(wiki);

  assert.ok(Array.isArray(report.staleStamps), "the body carries the detail");
  assert.ok(report.staleStamps.length >= 1, "and the stale cache is in it");
  assert.equal(typeof report.summary.staleStamps, "number", "the summary carries the count");
  assert.ok(report.summary.staleStamps >= 1);
  assert.equal(
    report.ok,
    true,
    "a stale stamp is an expected mid-warm state, not a health failure — it must not exit 3",
  );
});

// The exclusion must be narrow: everything else in summary still governs `ok`.
test("a genuine failure still flips ok, with a stale stamp also present", async () => {
  writeCache("knowledge", { dtype: `${LIVE_DTYPE}-changed` });
  fs.writeFileSync(path.join(wiki, "knowledge", "orphan-no-index-ref.md"), "# orphan\n");
  const report = doctor(wiki);
  assert.ok(report.summary.staleStamps >= 1, "still reports the stale stamp");
  const others = Object.entries(report.summary).filter(([k]) => k !== "staleStamps");
  const anyOther = others.some(([, n]) => n > 0);
  assert.equal(
    report.ok,
    !anyOther,
    "ok must track every counter EXCEPT staleStamps, so a real problem still fails",
  );
});

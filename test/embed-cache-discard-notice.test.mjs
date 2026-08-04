// loadCache DISCARDS a whole category's vectors when the cache's stamp no longer matches live
// settings, and it discards on any of four fields (model, backend, dtype, dim). Only a BACKEND
// change ever said so: the warning early-returned unless `raw.backend !== backend`, so editing
// `embed.dtype` or `embed.model` silently threw away the corpus.
//
// The consequence is not just a lost cache. Nothing re-embeds inside the MCP server, and every
// search until a warm completes is bounded by embed.maxColdPerRead, so recall quietly
// under-answers for as long as it takes someone to notice. The discard is CORRECT — vectors from
// different signatures are not comparable — but it must be legible.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCache } from "../scripts/lib/embed-cache-io.mjs";
import { __resetForTest } from "../scripts/lib/embed-backend-state.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";
import { __resetDiscardNotices } from "../scripts/lib/embed-cache-guards.mjs";

const MODEL = "test/discard-model";
const OTHER_MODEL = "test/discard-model-v2";

/** @param {{model?:string, backend?:string, dtype?:string}} embed */
const settingsFor = (embed) => ({
  embed: { backend: "transformers", model: MODEL, dtype: "q4", ...embed },
});

/** @param {{model?:string, backend?:string, dtype?:string}} stamp @returns {string} */
function writeCache(stamp) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-discard-"));
  const cachePath = path.join(dir, "embeddings.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      model: MODEL,
      backend: "transformers",
      dtype: "q4",
      dim: 3,
      entries: {
        a: { hash: "h1", vector: [1, 0, 0] },
        b: { hash: "h2", vector: [0, 1, 0] },
        c: { hash: "h3", vector: [0, 0, 1] },
      },
      ...stamp,
    }),
  );
  return cachePath;
}

// Loads `cachePath` under `embed` settings and returns the cache plus whatever reached stderr.
/**
 * @param {string} cachePath @param {{model?:string, backend?:string, dtype?:string}} embed
 * @returns {Promise<{ entries: string[], stderr: string }>}
 */
async function loadUnder(cachePath, embed) {
  __resetForTest();
  __resetDiscardNotices();
  /** @type {string[]} */
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const cache = await withSettingsOverride(settingsFor(embed), async () => loadCache(cachePath));
    return { entries: Object.keys(cache.entries), stderr: lines.join("") };
  } finally {
    process.stderr.write = write;
  }
}

test("a dtype change discards the cache AND says so, naming dtype", async () => {
  const cachePath = writeCache({ dtype: "q4" });
  const { entries, stderr } = await loadUnder(cachePath, { dtype: "q8" });

  assert.deepEqual(entries, [], "the q4 cache is rejected under q8 (existing, correct behaviour)");
  assert.match(stderr, /dtype/i, "the discard must name the field that changed");
  assert.match(stderr, /q4/, "and the value it was built with");
  assert.match(stderr, /q8/, "and the value now configured");
  assert.match(stderr, /3/, "and how many vectors were discarded");
});

test("a model change discards the cache AND says so, naming model", async () => {
  const cachePath = writeCache({ model: MODEL });
  const { entries, stderr } = await loadUnder(cachePath, { model: OTHER_MODEL });

  assert.deepEqual(entries, [], "a cache from another model is rejected");
  assert.match(stderr, /model/i, "the discard must name the field that changed");
  assert.match(stderr, new RegExp(OTHER_MODEL.replace(/\//g, "\\/")), "naming the live model");
});

test("model AND dtype changing together names both fields", async () => {
  const cachePath = writeCache({});
  const { stderr } = await loadUnder(cachePath, { model: OTHER_MODEL, dtype: "q8" });
  assert.match(stderr, /model/i);
  assert.match(stderr, /dtype/i);
});

// The pre-existing backend wording is load-bearing: it distinguishes a real discard from a
// TRANSIENT lexical fallback, where the on-disk cache is deliberately left intact. Generalising
// the notice must not flatten that distinction.
test("the backend-change wording is preserved, not replaced", async () => {
  const cachePath = writeCache({ backend: "lexical" });
  const { entries, stderr } = await loadUnder(cachePath, { backend: "transformers" });

  assert.deepEqual(entries, [], "a lexical cache is rejected under transformers");
  assert.match(stderr, /backend/i, "still names the backend");
  assert.match(stderr, /not comparable/i, "and keeps the explanation of why");
});

test("a matching stamp loads silently — no false positives on the healthy path", async () => {
  const cachePath = writeCache({});
  const { entries, stderr } = await loadUnder(cachePath, {});
  assert.deepEqual(entries, ["a", "b", "c"], "an unchanged signature loads every vector");
  assert.equal(stderr, "", "and must produce no diagnostic at all");
});

// An absent field makes no claim, exactly as loadCache's `valid` treats it. A legacy cache written
// before dtype stamping must not be reported as a dtype change.
test("a legacy cache with no dtype stamp is not reported as a dtype discard", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-discard-legacy-"));
  const cachePath = path.join(dir, "embeddings.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      model: MODEL,
      backend: "transformers",
      dim: 3,
      entries: { a: { hash: "h", vector: [1, 0, 0] } },
    }),
  );
  const { entries, stderr } = await loadUnder(cachePath, { dtype: "q4" });
  assert.deepEqual(entries, ["a"], "an unstamped dtype matches any dtype");
  assert.equal(stderr, "", "so there is nothing to report");
});

test("the notice is latched per cache path — a repeated load does not repeat it", async () => {
  const cachePath = writeCache({ dtype: "q4" });
  __resetForTest();
  __resetDiscardNotices();
  /** @type {string[]} */
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await withSettingsOverride(settingsFor({ dtype: "q8" }), async () => {
      loadCache(cachePath);
      loadCache(cachePath);
      loadCache(cachePath);
    });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(lines.length, 1, "three loads, one diagnostic");
});

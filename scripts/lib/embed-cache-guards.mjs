// Cache INTEGRITY: what makes a persist unsafe, and what to tell the operator when
// vectors are discarded. Split from embed-cache-io.mjs because the two answer
// different questions — this module decides whether a write may proceed and why,
// the other knows how the file is read and written. Runtime dependency is one-way
// (io imports guards, never the reverse); the EmbedCache type import below is
// erased at compile time, so the module graph stays acyclic.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  activeBackend,
  resolvedBackend,
  configuredBackend,
  persistSuspended,
} from "./embed-backend-state.mjs";

/** @typedef {import("./embed-cache-io.mjs").EmbedCache} EmbedCache */

// A backend flip discards every vector in the file: the mismatched cache is
// rejected here, and the first save then writes back only whatever that one call
// happened to embed. That is CORRECT — vectors from two backends are not
// comparable and cannot share a file — but it is expensive and was previously
// silent, so an operator toggling `embed.backend` for a debug session lost the
// whole corpus without being told, and the flip back cost a second full re-embed.
//
// Warned HERE rather than at save time because loadCache has already read and
// parsed the file: the diagnostic is free. Checking it in saveCache would mean
// re-reading the entire cache on every write — a ~19ms stall per save on a 10MB
// cache, which is exactly the cost this module used to pay for a guard that only
// ever fired when it was wrong.
/** @type {Set<string>} */
const warnedBackendDiscard = new Set();

/**
 * @param {string} cachePath @param {EmbedCache} raw @param {string} backend
 * @returns {void}
 */
export function warnBackendDiscard(cachePath, raw, backend) {
  const had = raw && typeof raw === "object" ? Object.keys(raw.entries || {}).length : 0;
  if (!had || !raw.backend || raw.backend === backend) return;
  if (warnedBackendDiscard.has(cachePath)) return;
  // A TRANSIENT fallback is the common trigger and the one the persist guard exists to make
  // harmless: the on-disk cache is left intact and reused when the model returns. Saying
  // "discarded, and switching back needs another full re-embed" there is simply false, and it
  // tells the user a model blip cost them their corpus.
  if (persistBlockReason(cachePath)) {
    process.stderr.write(
      `embed: ${cachePath} holds ${had} vectors built by the "${raw.backend}" backend; this process resolved "${backend}" (a fallback, not your configuration), so it is scoring in memory only and the on-disk cache is left intact for when the model returns.\n`,
    );
    warnedBackendDiscard.add(cachePath);
    return;
  }
  // Write BEFORE arming: a throwing stderr then leaves the latch unarmed and the diagnostic
  // is retried, matching warnDowngradeOnce.
  process.stderr.write(
    `embed: ${cachePath} holds ${had} vectors built by the "${raw.backend}" backend, but this process resolved "${backend}". Vectors from different backends are not comparable, so those are discarded and will be re-embedded; switching back will require another full re-embed.\n`,
  );
  warnedBackendDiscard.add(cachePath);
}

// Whether the stamp recorded ON a cache object still describes the live config.
// Per-field tolerance, mirroring loadCache's `valid`: an ABSENT field makes no claim
// and so cannot be contradicted. That covers both a legacy file written before dtype
// stamping and a caller-constructed `{ entries }` map that was never stamped at all —
// neither is drift. Every cache loadCache hands out carries all three fields, so the
// real drift case (a config edit while a warm holds its cache open) still trips this.
/**
 * @param {EmbedCache} cache
 * @param {{ model: string, backend: string, dtype: string }} live
 * @returns {boolean}
 */
export function stampStillDescribes(cache, live) {
  return (
    (cache.model === undefined || cache.model === live.model) &&
    (cache.backend === undefined || cache.backend === live.backend) &&
    (cache.dtype === undefined || cache.dtype === live.dtype)
  );
}

/** @type {Set<string>} */
const warnedStampDrift = new Set();
/**
 * @param {string} cachePath
 * @param {EmbedCache} cache
 * @param {{ model: string, backend: string, dtype: string }} live
 * @returns {void}
 */
export function warnStampDrift(cachePath, cache, live) {
  const dropped = Object.keys(cache.entries || {}).length;
  if (!dropped || warnedStampDrift.has(cachePath)) return;
  const was = `${cache.backend ?? "?"}/${cache.model}/${cache.dtype ?? "?"}`;
  const now = `${live.backend}/${live.model}/${live.dtype}`;
  process.stderr.write(
    `embed: embedding signature changed while ${cachePath} was open (backend/model/dtype ${was} -> ${now}); ${dropped} vectors built under the previous signature are NOT persisted rather than being re-labelled, and the on-disk cache is left authoritative. They will be re-embedded on the next warm.\n`,
  );
  warnedStampDrift.add(cachePath);
}

// The backend recorded in an on-disk cache, or "" when unreadable.
/**
 * @param {string} cachePath
 * @returns {string}
 */
function existingCacheBackend(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return typeof raw?.backend === "string" ? raw.backend.toLowerCase() : "";
  } catch {
    return "";
  }
}

// The embed backend the OWNING install declares, read from its settings file and
// memoised on mtime so a save costs one stat. "" when unknown — which is the safe
// answer, because unknown then means "not chosen", leaving both guards armed.
//
// A cache path is <dataDir>/wiki/<category>/.embeddings/embeddings.json, so the data
// dir is three levels above the file's directory.
/** @type {Map<string, { mtimeMs: number, backend: string }>} */
const ownerBackendMemo = new Map();
/**
 * @param {string} cachePath
 * @returns {string}
 */
function ownerConfiguredBackend(cachePath) {
  const settingsFile = path.join(
    path.resolve(path.dirname(cachePath), "..", "..", ".."),
    "settings",
    "settings.yaml",
  );
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(settingsFile).mtimeMs;
  } catch {
    return "";
  }
  const memo = ownerBackendMemo.get(settingsFile);
  if (memo && memo.mtimeMs === mtimeMs) return memo.backend;
  let backend = "";
  try {
    const parsed = parseYaml(fs.readFileSync(settingsFile, "utf8"));
    const declared = parsed?.embed?.backend;
    backend = typeof declared === "string" ? declared.trim().toLowerCase() : "";
  } catch {
    backend = "";
  }
  ownerBackendMemo.set(settingsFile, { mtimeMs, backend });
  return backend;
}

// Why persisting would corrupt the cache at `cachePath`, or "" when safe.
/**
 * @param {string} cachePath
 * @returns {string}
 */
export function persistBlockReason(cachePath) {
  // The authority on "was lexical CHOSEN for this wiki" is the settings file of the
  // install that OWNS the cache — never the writing process's own settings().
  //
  // This distinction is the whole guard. settings() is process-local and
  // override-merged, so ANY process running under a lexical override — a test using
  // withSettingsOverride, a temp workspace whose settings.yaml says lexical — used to
  // present itself as "a deliberately lexical wiki" and was allowed to overwrite a
  // 768-dim transformers cache belonging to a wiki whose own file says transformers.
  // That is not a hypothesis: a live brain lost three categories of vectors to it
  // twice in ten minutes, and the earlier version of this tripwire could not fire
  // because its own condition read the same overridden value.
  // When the owning install DECLARES a backend, that declaration is authoritative and an
  // overriding process cannot contradict it. When it declares nothing, fall back to the
  // process value — a SHARED repo wiki has no settings file of its own (its settings live
  // in the consuming brain), so treating silence as "not chosen" would leave every shared
  // wiki permanently unable to cache vectors. Silence is not the incident case: the brain
  // that lost its vectors declares `transformers`, and now wins.
  // The authority: the owning install's declaration when it has one, else this process's
  // configured value.
  const declared = ownerConfiguredBackend(cachePath);
  const authority = declared !== "" ? declared : configuredBackend();
  const chosenForThisWiki = authority === "lexical";

  // A run that WANTED a model backend but fell back to lexical must never overwrite
  // good vectors. Reads the RAW resolved backend: "not yet resolved" is not
  // "transformers".
  // Through persistSuspended so the predicate keeps ONE definition — an inlined copy left it
  // exported with only unit tests as callers, i.e. testing itself rather than production.
  if (persistSuspended(authority, resolvedBackend())) return "degraded-fallback";

  // TRIPWIRE on the bytes: about to stamp lexical over a transformers cache that this
  // wiki never asked to be lexical. The file read sits behind both conditions above,
  // so a healthy run never pays for it.
  if (
    !chosenForThisWiki &&
    activeBackend() === "lexical" &&
    existingCacheBackend(cachePath) === "transformers"
  ) {
    return "lexical-over-transformers";
  }
  return "";
}

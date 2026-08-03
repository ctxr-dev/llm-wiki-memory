import { Worker } from "node:worker_threads";
import { envValue, envBool } from "./env.mjs";
import { embedModel, embedDtype, embedThreads, DEFAULT_EMBED_MODEL } from "./settings.mjs";
import { createEmbedder } from "./embed-inference.mjs";
import { keyedMemo, inferenceKey } from "./keyed-memo.mjs";

// Turning texts into vectors: the single worker thread, and the in-process path it falls
// back to when the worker is opted out.
//
// Both strategies live here because they are one job with one shared config —
// splitting them would put the "worker or in-process" decision in one file and the
// thing it decides between in another. This module owns the worker handle
// lifecycle and the cached in-process embedder; it knows nothing about the
// fallback-to-lexical POLICY, which is the caller's (embed.mjs) decision.

// KEYED on the resolved inference config, for the same reason as the worker's:
// settings hot-reload, so an unkeyed latch serves an embedder built from config
// that no longer applies while the cache stamp has already moved on.
/** @typedef {import("./embed-inference.mjs").Embedder} Embedder */
const _inProcessEmbedder = keyedMemo(
  /** @param {{ model: string, dtype?: string, threads?: number, cacheDir?: string }} cfg */
  (cfg) => createEmbedder(cfg),
  { onEvict: (embedder) => embedder.dispose?.() },
);

// Inference runs in a worker thread (opt out: LWM_EMBED_NO_WORKER=1) because the
// onnxruntime forward pass is a synchronous native call that would otherwise block
// the event loop. A worker failure routes to the same lexical-fallback window as a
// model failure — retrying in-process here would reintroduce the block.
/** @typedef {{ postMessage: (m: unknown) => void, on: (e: string, cb: (arg: any) => void) => void, ref?: () => void, unref?: () => void, terminate?: () => void }} EmbedWorker */
/** @typedef {{ worker: EmbedWorker, pending: Map<number, { resolve: (v: number[][]) => void, reject: (e: Error) => void }> }} WorkerHandle */
/** @type {WorkerHandle | null} */
let _workerHandle = null;
let _workerSeq = 0;
let _warnedWorkerFallback = false;

/** @returns {EmbedWorker} */
function defaultWorkerFactory() {
  // execArgv: [] — inherited parent flags (--test, --input-type, --import guards)
  // are meaningless or fatal for the worker's plain file entry.
  return /** @type {EmbedWorker} */ (
    /** @type {unknown} */ (
      new Worker(new URL("./embed-worker.mjs", import.meta.url), { execArgv: [] })
    )
  );
}
/** @type {() => EmbedWorker} */
let _workerFactory = defaultWorkerFactory;

/** @param {WorkerHandle | null} handle @param {Error} error */
function rejectAllPending(handle, error) {
  if (!handle) return;
  for (const pending of handle.pending.values()) pending.reject(error);
  handle.pending.clear();
}

// `__` prefix deliberate: a TEST-HARNESS mutator, not part of the runner's contract.
/**
 * @param {(() => EmbedWorker) | null} [factory]
 * @returns {void}
 */
export function __setWorkerFactoryForTest(factory) {
  const old = _workerHandle;
  _workerHandle = null;
  rejectAllPending(old, new Error("embed worker replaced for test"));
  if (old && typeof old.worker.terminate === "function") {
    try {
      old.worker.terminate();
    } catch {
      /* best effort */
    }
  }
  _warnedWorkerFallback = false;
  _workerFactory = factory || defaultWorkerFactory;
}

// envBool, not a `!== "1"` compare: it reads `settings/.env` (so the documented
// opt-out actually applies there) AND accepts every spelling an operator plausibly
// writes. A strict compare turned `LWM_EMBED_NO_WORKER=true` into a silent no-op,
// indistinguishable from the opt-out working.
function workerEnabled() {
  return !envBool("LWM_EMBED_NO_WORKER", false);
}

/** @returns {WorkerHandle} */
function getWorkerHandle() {
  if (_workerHandle) return _workerHandle;
  /** @type {WorkerHandle} */
  const handle = { worker: _workerFactory(), pending: new Map() };
  // Per-handle pending map: a dead worker fires both `error` and `exit`, and must
  // never reject a successor worker's requests.
  const failAll = (/** @type {unknown} */ err) => {
    if (_workerHandle === handle) _workerHandle = null;
    rejectAllPending(handle, err instanceof Error ? err : new Error(String(err)));
  };
  handle.worker.on("message", (m) => {
    const pending = handle.pending.get(m?.id);
    if (!pending) return;
    handle.pending.delete(m.id);
    syncWorkerRef(handle);
    if (m.ok) pending.resolve(m.vectors);
    else pending.reject(new Error(m.error || "embed worker error"));
  });
  handle.worker.on("error", failAll);
  handle.worker.on("exit", (code) => failAll(new Error(`embed worker exited (code ${code})`)));
  syncWorkerRef(handle);
  _workerHandle = handle;
  return handle;
}

// An unref'd worker cannot hold the process open, and a pending promise alone
// never does — so a one-shot CLI would exit mid-inference without the ref.
/** @param {WorkerHandle} handle */
function syncWorkerRef(handle) {
  if (handle.pending.size > 0) handle.worker.ref?.();
  else handle.worker.unref?.();
}

/**
 * @param {string[]} texts @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
function runInWorker(texts, batchSize) {
  const handle = getWorkerHandle();
  const id = (_workerSeq += 1);
  const { model, dtype, threads, cacheDir } = inferenceConfig();
  return new Promise((resolve, reject) => {
    handle.pending.set(id, { resolve, reject });
    syncWorkerRef(handle);
    try {
      handle.worker.postMessage({ id, texts, batchSize, model, dtype, threads, cacheDir });
    } catch (err) {
      handle.pending.delete(id);
      syncWorkerRef(handle);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * @param {string[]} list @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(list, batchSize) {
  if (!workerEnabled()) return embedManyInProcess(list, batchSize);
  try {
    return await runInWorker(list, batchSize);
  } catch (err) {
    if (!_warnedWorkerFallback) {
      process.stderr.write(
        `embed.mjs: inference worker unavailable (${err instanceof Error ? err.message : err})\n`,
      );
      _warnedWorkerFallback = true;
    }
    throw err;
  }
}

// Shared config for the worker message AND the in-process fallback, so both
// construct the identical embedder. MEMORY_EMBED_CACHE_DIR is read via envValue
// (not process.env) so a value set only in settings/.env is still honoured.
/**
 * @returns {{ model: string, dtype: string | undefined, threads: number, cacheDir: string | undefined }}
 */
function inferenceConfig() {
  return {
    model: embedModel() || DEFAULT_EMBED_MODEL,
    dtype: embedDtype() || undefined,
    threads: embedThreads(),
    cacheDir: envValue("MEMORY_EMBED_CACHE_DIR") || undefined,
  };
}

/**
 * @param {string[]} list @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
async function embedManyInProcess(list, batchSize) {
  const cfg = inferenceConfig();
  return await _inProcessEmbedder.use(inferenceKey(cfg), cfg, async (embedder) => {
    const size = batchSize > 0 ? batchSize : list.length;
    /** @type {number[][]} */
    const vectors = [];
    for (let i = 0; i < list.length; i += size) {
      vectors.push(...(await embedder(list.slice(i, i + size))));
    }
    return vectors;
  });
}

// Drop the cached in-process embedder so a retry re-loads the model. Called by the
// orchestrator when inference failed — the rejected promise must not be reused.
/** @returns {void} */
export function dropInProcessEmbedder() {
  // Key-scoped: an unconditional reset also released an embedder built for a different
  // config that another caller was still using.
  _inProcessEmbedder.resetKey(inferenceKey(inferenceConfig()));
}

// Re-arm the one-shot worker-unavailable warning after the backend recovers, so a
// LATER outage is reported rather than swallowed.
/** @returns {void} */
export function resetWorkerWarning() {
  _warnedWorkerFallback = false;
}

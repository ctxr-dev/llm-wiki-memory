import { parentPort } from "node:worker_threads";
import { createEmbedder } from "./embed-inference.mjs";
import { keyedMemo, inferenceKey } from "./keyed-memo.mjs";
import { installFatalGuard } from "./fatal-guard.mjs";
import { makeDownloadReporter } from "./model-download-progress.mjs";

// onnxruntime's forward pass is a synchronous native call; this worker keeps it
// off the main event loop. Texts arrive already prompt-prefixed by the caller.

// KEYED on the config every message carries. The caller re-reads settings per
// batch and ships them each time; before this was keyed, only the FIRST message's
// config was ever honoured, so a live `embed.model`/`embed.dtype` change kept
// producing vectors from the old model while the cache stamped them as the new one.
/** @typedef {import("./embed-inference.mjs").Embedder} Embedder */
const embedderMemo = keyedMemo(
  /** @param {{ model: string, dtype?: string, threads?: number, cacheDir?: string }} opts */
  (opts) => createEmbedder(opts),
  // The replaced embedder holds a native ONNX session; dropping the JS reference
  // frees it only at GC's discretion, so release it explicitly.
  { onEvict: (embedder) => embedder.dispose?.() },
);

// A worker's stderr is INHERITED by the parent (no stdio option is passed to `new Worker`), so
// writing here needs no protocol frame. Adding one would be hazardous: the parent deletes a
// request's pending entry on the FIRST message bearing its id, so a progress frame reusing that id
// would resolve the request early with no vectors.
const reportDownload = makeDownloadReporter({ label: "embedding model" });

const port = parentPort;
if (port) {
  // Rejections only. Keeping the thread alive for those matters more here than anywhere: its
  // death rejects every in-flight embed and drops the whole process to lexical for 30s. An
  // EXCEPTION is deliberately left to propagate — handling it in-thread would consume it, so
  // the parent's worker.on("error") would never fire and the real cause would be replaced by a
  // synthetic exit code.
  installFatalGuard("embed-worker", { catchExceptions: false });
  port.on("message", async (msg) => {
    const { id, texts, batchSize, model, dtype, threads, cacheDir } = msg || {};
    const opts = { model, dtype, threads, cacheDir, onProgress: reportDownload };
    try {
      const list = Array.isArray(texts) ? texts.map((t) => String(t || "")) : [];
      // Leased: this handler runs concurrently for several messages, and the catch below
      // drops the memo entry. Without a borrow, one message's failure released the session
      // the others were mid-batch on.
      const vectors = await embedderMemo.use(inferenceKey(opts), opts, async (embedder) => {
        const size = batchSize > 0 ? batchSize : list.length || 1;
        /** @type {number[][]} */
        const out = [];
        for (let i = 0; i < list.length; i += size) {
          out.push(...(await embedder(list.slice(i, i + size))));
        }
        return out;
      });
      port.postMessage({ id, ok: true, vectors });
    } catch (err) {
      embedderMemo.resetKey(inferenceKey(opts));
      port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

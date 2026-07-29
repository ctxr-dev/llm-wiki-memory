import { parentPort } from "node:worker_threads";
import { createEmbedder } from "./embed-inference.mjs";

// onnxruntime's forward pass is a synchronous native call; this worker keeps it
// off the main event loop. Texts arrive already prompt-prefixed by the caller.

/** @type {Promise<(texts: string[]) => Promise<number[][]>> | null} */
let embedderPromise = null;

/**
 * @param {{ model: string, dtype?: string, threads?: number, cacheDir?: string }} opts
 * @returns {Promise<(texts: string[]) => Promise<number[][]>>}
 */
function getEmbedder(opts) {
  if (!embedderPromise) embedderPromise = createEmbedder(opts);
  return embedderPromise;
}

const port = parentPort;
if (port) {
  port.on("message", async (msg) => {
    const { id, texts, batchSize, model, dtype, threads, cacheDir } = msg || {};
    try {
      const list = Array.isArray(texts) ? texts.map((t) => String(t || "")) : [];
      const embedder = await getEmbedder({ model, dtype, threads, cacheDir });
      const size = batchSize > 0 ? batchSize : list.length || 1;
      /** @type {number[][]} */
      const vectors = [];
      for (let i = 0; i < list.length; i += size) {
        vectors.push(...(await embedder(list.slice(i, i + size))));
      }
      port.postMessage({ id, ok: true, vectors });
    } catch (err) {
      embedderPromise = null;
      port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

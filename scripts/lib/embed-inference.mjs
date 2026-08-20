import { tensorRows } from "./embed-lexical.mjs";

// Model-family-aware inference, shared by the embed worker and the in-process
// fallback so both produce byte-identical vectors.

/** @typedef {{ query: string, document: string }} PromptPair */

const GEMMA_PROMPTS = Object.freeze({
  query: "task: search result | query: ",
  document: "title: none | text: ",
});

// Keyed by the env object, NOT a module-level single value: one global latched whatever the
// FIRST env ever passed, so a second env in the same process would have "clear" restore the
// other one's default. Production only ever has one transformers env per thread, but the
// global also made the behaviour untestable across scenarios, which is its own defect.
//
// `null` is transformers' own "unset" value and is distinct from "not yet captured", which is
// why presence is tracked by the map rather than by comparing to undefined.
/** @type {WeakMap<object, string | null | undefined>} */
const builtinCacheDir = new WeakMap();
/**
 * @param {{ cacheDir?: string | null }} env
 * @param {string | undefined} cacheDir
 * @returns {void}
 */
export function applyCacheDir(env, cacheDir) {
  if (!builtinCacheDir.has(env)) builtinCacheDir.set(env, env.cacheDir);
  env.cacheDir = cacheDir || builtinCacheDir.get(env);
}

/**
 * Texts in, one vector per text out. `dispose` releases the backing runtime's
 * NATIVE memory (an ONNX session), which the JS garbage collector does not manage;
 * it is optional because a stubbed embedder in a test has nothing to release.
 * @typedef {((texts: string[]) => Promise<number[][]>) & { dispose?: () => void }} Embedder
 */

/** @param {string} model @returns {boolean} */
function isGemmaFamily(model) {
  return /embeddinggemma/i.test(String(model || ""));
}

/** @param {string} model @returns {PromptPair | null} */
function promptsFor(model) {
  return isGemmaFamily(model) ? GEMMA_PROMPTS : null;
}

/** @param {string} model @returns {string} */
export function defaultDtypeFor(model) {
  return isGemmaFamily(model) ? "q4" : "q8";
}

// The model's usable input window: EmbeddingGemma reads 2048 tokens, the classic
// BERT-family retrievers 512. Drives chunking, so a wrong value silently truncates.
/** @param {string} model @returns {number} */
export function embedWindowFor(model) {
  return isGemmaFamily(model) ? 2048 : 512;
}

/**
 * @param {string} model @param {"query" | "document"} kind @param {string[]} texts
 * @returns {string[]}
 */
export function applyPrompt(model, kind, texts) {
  const prompts = promptsFor(model);
  if (!prompts) return texts;
  const prefix = kind === "query" ? prompts.query : prompts.document;
  return texts.map((t) => prefix + t);
}

// Attaches a SAFE disposal seam to an embedder closure.
//
// Two hazards make the naive `dispose = () => model.dispose?.()` wrong, and both were
// measured, not theorised:
//   1. USE-AFTER-RELEASE. The worker's message handler admits concurrent requests, so
//      one request's failure used to release the native session another request was
//      mid-forward-pass on — failing every concurrent embed instead of just its own,
//      and with onnxruntime-node a release during an active run can abort the thread
//      rather than throw. So disposal is DEFERRED until nothing is in flight.
//   2. ASYNC REJECTION. `dispose()` is async upstream (it awaits `session.release()`),
//      so a returned rejected promise escaped every synchronous try/catch and took the
//      worker thread (or the MCP server) down with it. So it is always adapted.
// Before the memo was keyed a rebuild was impossible, so neither path existed.
/**
 * @template {(texts: string[]) => Promise<number[][]>} F
 * @param {F} run
 * @param {() => unknown} release
 * @returns {Embedder}
 */
export function withDisposal(run, release) {
  let inFlight = 0;
  let disposeRequested = false;
  const releaseIfIdle = () => {
    if (!disposeRequested || inFlight > 0) return;
    disposeRequested = false;
    Promise.resolve()
      .then(release)
      .catch(() => {
        // A failed release leaks native memory; it must never surface as a failed embed.
        // keyed-memo reports the one-shot diagnostic for the eviction path.
      });
  };
  /** @param {string[]} texts @returns {Promise<number[][]>} */
  const embed = async (texts) => {
    inFlight += 1;
    try {
      return await run(texts);
    } finally {
      inFlight -= 1;
      releaseIfIdle();
    }
  };
  embed.dispose = () => {
    disposeRequested = true;
    releaseIfIdle();
  };
  return embed;
}

// `onProgress` is deliberately NOT part of the artefact's identity: inferenceKey hashes only
// [model, dtype, cacheDir], so passing a fresh callback per message cannot cause a rebuild of a
// ~200MB session. It is forwarded as transformers' `progress_callback`, which also switches Node
// off its `arrayBuffer()` shortcut onto the streaming read path — same bytes, reported as they land.
/**
 * @param {{ model: string, dtype?: string, threads?: number, cacheDir?: string, onProgress?: (info: unknown) => void }} opts
 * @returns {Promise<Embedder>}
 */
export async function createEmbedder({ model, dtype, threads, cacheDir, onProgress }) {
  const transformers = await import("@huggingface/transformers");
  applyCacheDir(transformers.env, cacheDir);
  const resolvedDtype = /** @type {import("@huggingface/transformers").DataType} */ (
    /** @type {unknown} */ (dtype || defaultDtypeFor(model))
  );
  const sessionOptions = threads && threads > 0 ? { intraOpNumThreads: threads } : undefined;
  const progress = onProgress ? { progress_callback: onProgress } : {};
  if (isGemmaFamily(model)) {
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(model, { ...progress });
    const gemma = await transformers.AutoModel.from_pretrained(model, {
      dtype: resolvedDtype,
      ...progress,
      ...(sessionOptions ? { session_options: sessionOptions } : {}),
    });
    return withDisposal(
      async (texts) => {
        const inputs = tokenizer(texts, { padding: true, truncation: true });
        const out = await gemma(inputs);
        return tensorRows(out.sentence_embedding, texts.length);
      },
      () => gemma.dispose?.(),
    );
  }
  const pipe = await transformers.pipeline("feature-extraction", model, {
    dtype: resolvedDtype,
    ...progress,
    ...(sessionOptions ? { session_options: sessionOptions } : {}),
  });
  return withDisposal(
    async (texts) => {
      const out = await pipe(texts, { pooling: "mean", normalize: true });
      return tensorRows(out, texts.length);
    },
    () => pipe.dispose?.(),
  );
}

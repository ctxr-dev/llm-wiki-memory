import { tensorRows } from "./embed-lexical.mjs";

// Model-family-aware inference, shared by the embed worker and the in-process
// fallback so both produce byte-identical vectors.

/** @typedef {{ query: string, document: string }} PromptPair */

const GEMMA_PROMPTS = Object.freeze({
  query: "task: search result | query: ",
  document: "title: none | text: ",
});

/** @param {string} model @returns {boolean} */
export function isGemmaFamily(model) {
  return /embeddinggemma/i.test(String(model || ""));
}

/** @param {string} model @returns {PromptPair | null} */
export function promptsFor(model) {
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

/**
 * @param {{ model: string, dtype?: string, threads?: number, cacheDir?: string }} opts
 * @returns {Promise<(texts: string[]) => Promise<number[][]>>}
 */
export async function createEmbedder({ model, dtype, threads, cacheDir }) {
  const transformers = await import("@huggingface/transformers");
  if (cacheDir) transformers.env.cacheDir = cacheDir;
  const resolvedDtype = /** @type {import("@huggingface/transformers").DataType} */ (
    /** @type {unknown} */ (dtype || defaultDtypeFor(model))
  );
  const sessionOptions = threads && threads > 0 ? { intraOpNumThreads: threads } : undefined;
  if (isGemmaFamily(model)) {
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(model);
    const gemma = await transformers.AutoModel.from_pretrained(model, {
      dtype: resolvedDtype,
      ...(sessionOptions ? { session_options: sessionOptions } : {}),
    });
    return async (texts) => {
      const inputs = tokenizer(texts, { padding: true, truncation: true });
      const out = await gemma(inputs);
      return tensorRows(out.sentence_embedding, texts.length);
    };
  }
  const pipe = await transformers.pipeline("feature-extraction", model, {
    dtype: resolvedDtype,
    ...(sessionOptions ? { session_options: sessionOptions } : {}),
  });
  return async (texts) => {
    const out = await pipe(texts, { pooling: "mean", normalize: true });
    return tensorRows(out, texts.length);
  };
}

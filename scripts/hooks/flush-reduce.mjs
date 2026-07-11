import {
  settings,
  KNOWN_PROVIDERS,
  flushReduceMaxChars,
  pickStrongerModel,
} from "../lib/settings.mjs";
import { callLLMChain } from "../lib/llm.mjs";
import { validateAtoms } from "./flush-validate.mjs";
import { logBreadcrumb } from "./flush-state.mjs";

/** @typedef {import("../lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./flush-distill.mjs").LLMProvenance} LLMProvenance */
/** @typedef {import("../lib/settings-defaults.mjs").Settings} Settings */
/** @typedef {import("../lib/settings-defaults.mjs").ProviderModels} ProviderModels */

/**
 * Arguments to the recursive reduce-merge.
 * @typedef {Object} ReduceArgs
 * @property {DistilledAtom[]} atoms
 * @property {string} tag
 * @property {number} attempts
 * @property {number} retryMs
 * @property {string} systemPrompt
 * @property {string} baseHeader
 * @property {LLMProvenance[]} sourceProvenances
 * @property {number} [depth]
 */

/**
 * Shared context threaded into the final merge/dedup step.
 * @typedef {Object} ReduceCtx
 * @property {string} tag
 * @property {number} attempts
 * @property {number} retryMs
 * @property {string} systemPrompt
 * @property {string} baseHeader
 * @property {unknown} overrideConfig
 */

// Reduce merge: ask the LLM to de-duplicate the per-chunk atom lists into a
// single coherent set. When the joined payload exceeds the reduce cap, split
// the atom list into sub-batches, merge each batch, then merge the merged —
// tree-reduce, so a runaway dedup pass can't time out. Uses a one-tier-
// stronger model than chunk distillation when reduce_model_promote is on
// and the head provider has a fallback list (no-ops otherwise).
// Belt-and-suspenders against unbounded recursion in the LLM-driven reduce
// step. The algorithmic invariant ("each recursion halves the atom count")
// SHOULD already terminate, but an adversarial / mock LLM that returns
// inputs unchanged can repopulate the post-merge call. A hard depth cap
// turns "infinite recursion fills the disk in minutes" into a graceful
// fall-through to deterministic dedup. log2(reasonable atom count) is well
// under 16, so a real workload never trips this.
export const REDUCE_MAX_DEPTH = 16;

/**
 * @param {ReduceArgs} args
 * @returns {Promise<DistilledAtom[]>}
 */
export async function reduceMerge({
  atoms,
  tag,
  attempts,
  retryMs,
  systemPrompt,
  baseHeader,
  sourceProvenances,
  depth = 0,
}) {
  if (!Array.isArray(atoms) || atoms.length === 0) return [];
  if (atoms.length === 1) return atoms;

  const cap = flushReduceMaxChars();
  const overrideConfig = pickReduceOverride(sourceProvenances);
  const ctx = { tag, attempts, retryMs, systemPrompt, baseHeader, overrideConfig };

  // Depth-cap escape hatch: an LLM that hallucinates inputs back to us
  // unchanged would defeat the input-shrinks-each-level invariant. Beyond
  // this point, do deterministic dedup and stop — never throw or drop
  // atoms; preserve the work we already collected.
  if (depth >= REDUCE_MAX_DEPTH) {
    logBreadcrumb(
      `${tag}: reduce depth ${depth} >= cap ${REDUCE_MAX_DEPTH}; deterministic dedupe fallthrough`,
    );
    return deterministicDedup(atoms);
  }

  const serialized = serializeAtomsForReduce(atoms);
  if (serialized.length > cap && atoms.length > 1) {
    logBreadcrumb(
      `${tag}: reduce input ${serialized.length} > cap ${cap}; tree-recursing (depth=${depth})`,
    );
    const half = Math.ceil(atoms.length / 2);
    const left = await reduceMerge({
      atoms: atoms.slice(0, half),
      tag: `${tag}/L`,
      attempts,
      retryMs,
      systemPrompt,
      baseHeader,
      sourceProvenances,
      depth: depth + 1,
    });
    const right = await reduceMerge({
      atoms: atoms.slice(half),
      tag: `${tag}/R`,
      attempts,
      retryMs,
      systemPrompt,
      baseHeader,
      sourceProvenances,
      depth: depth + 1,
    });
    // Sanity check: if left+right did not shrink the input (LLM returned
    // the same atoms back unchanged), the post-recursion merge could feed
    // the original payload back in. Skip the LLM round-trip and dedup
    // deterministically instead of risking another wasted pass.
    const joined = [...left, ...right];
    if (joined.length >= atoms.length) {
      logBreadcrumb(
        `${tag}: reduce did not shrink (${atoms.length} -> ${joined.length}); deterministic dedupe`,
      );
      return deterministicDedup(joined);
    }
    return finalMergeOrDedup({ atoms: joined, ctx });
  }

  return finalMergeOrDedup({ atoms, ctx });
}

/**
 * @param {{ atoms: DistilledAtom[], ctx: ReduceCtx }} args
 * @returns {Promise<DistilledAtom[]>}
 */
async function finalMergeOrDedup({ atoms, ctx }) {
  if (atoms.length <= 1) return atoms;
  const serialized = serializeAtomsForReduce(atoms);
  const userPrompt =
    `${ctx.baseHeader}This is the REDUCE step of a map-reduce distillation. ` +
    `Each entry below is an atom already extracted from a chunk of the session. ` +
    `Merge near-duplicates, drop redundancies, and return a single coherent atoms[] list ` +
    `in the SAME JSON schema you were given. Preserve every distinct insight.\n\n` +
    `--- MERGE INPUT ---\n\n${serialized}`;
  try {
    const { result } = await callLLMChain(
      /** @type {{ systemPrompt: string, userPrompt: string, maxTokens: number, configOverride?: Settings }} */
      ({
        systemPrompt: ctx.systemPrompt,
        userPrompt,
        maxTokens: 1500,
        configOverride: /** @type {Settings | undefined} */ (ctx.overrideConfig || undefined),
      }),
    );
    const merged = validateAtoms(result);
    // An empty LLM response (provider hallucinated empty or refused) would
    // drop every atom we collected; fall back to deterministic dedup over
    // the input to keep the distilled work.
    return merged.length > 0 ? deterministicDedup(merged) : deterministicDedup(atoms);
  } catch (err) {
    logBreadcrumb(
      `${ctx.tag}: final merge failed (${/** @type {Error} */ (err)?.message || err}); deterministic dedupe`,
    );
    return deterministicDedup(atoms);
  }
}

/** @param {LLMProvenance[]} sourceProvenances */
export function pickReduceOverride(sourceProvenances) {
  const config = settings();
  if (config.flush?.reduceModelPromote === false) return null;
  const headProvider = config.providers.chain[0];
  const headModels = headProvider
    ? /** @type {ProviderModels} */ (config.providers[headProvider])?.models || []
    : [];
  const sampledFinal = sourceProvenances.find((p) => p?.final_provider)?.final_provider || null;
  const sampledModel =
    sampledFinal && sampledFinal.includes(":") ? sampledFinal.split(":")[1] : null;
  if (!sampledModel) return null;
  const promoted = pickStrongerModel(sampledModel, headModels);
  if (promoted === sampledModel) return null;
  return overrideHeadModel(config, headProvider, promoted);
}

/** @param {DistilledAtom[]} atoms @returns {string} */
function serializeAtomsForReduce(atoms) {
  return atoms.map((a, i) => `Atom ${i + 1}:\n${JSON.stringify(a, null, 2)}`).join("\n\n");
}

/** @param {DistilledAtom[]} atoms @returns {DistilledAtom[]} */
export function deterministicDedup(atoms) {
  /** @type {Map<string, DistilledAtom>} */
  const seen = new Map();
  for (const a of atoms) {
    const key = `${a.type}|${a.title}|${a?.metadata?.error_pattern || ""}`;
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()];
}

/**
 * @param {ReturnType<typeof settings>} config
 * @param {string} providerName
 * @param {string} model
 */
function overrideHeadModel(config, providerName, model) {
  // Re-emit a frozen config with the head provider's first model replaced.
  // Used by the reduce step to ask one-tier-stronger without mutating the
  // shared cache.
  /** @type {{ chain: string[], [provider: string]: string[] | { models: string[] } }} */
  const providers = { chain: config.providers.chain.slice() };
  for (const p of KNOWN_PROVIDERS) {
    const entry = /** @type {{ models?: string[] }} */ (config.providers[p]);
    const list = (entry?.models || []).slice();
    providers[p] = {
      models: p === providerName ? [model, ...list.filter((m) => m !== model)] : list,
    };
  }
  return Object.freeze({
    providers: Object.freeze({
      chain: Object.freeze(providers.chain),
      ...Object.fromEntries(
        KNOWN_PROVIDERS.map((p) => [
          p,
          Object.freeze({
            models: Object.freeze(/** @type {{ models: string[] }} */ (providers[p]).models),
          }),
        ]),
      ),
    }),
    flush: config.flush,
  });
}

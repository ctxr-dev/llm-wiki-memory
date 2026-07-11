import { envValue } from "./env.mjs";
import { KNOWN_PROVIDERS, STRUCTURAL_PROVIDER_ORDER } from "./settings.mjs";
import { normaliseModels, normaliseChain } from "./settings-coerce.mjs";
import { detectAvailableProviders } from "./settings-providers.mjs";

/** @typedef {import("./settings-defaults.mjs").Settings} Settings */
/** @typedef {import("./settings-defaults.mjs").ProviderModels} ProviderModels */
/** @typedef {import("./settings-providers.mjs").CmdProbe} CmdProbe */

/** A raw (uncoerced) settings sub-section as parsed from user YAML. @typedef {Record<string, unknown>} RawSection */
/**
 * The raw settings tree parsed from the user's settings.yaml, before any
 * coercion. Every section is optional and its values are unknown until coerced.
 * @typedef {Object} RawSettings
 * @property {RawSection} [consolidate]
 * @property {RawSection} [flush]
 * @property {RawSection} [hook]
 * @property {RawSection} [embed]
 * @property {RawSection} [recall]
 * @property {RawSection} [compile]
 * @property {RawSection} [gc]
 * @property {RawSection} [gate]
 * @property {RawSection} [wiki]
 * @property {Record<string, unknown>} [providers]
 * @property {string[] | string} [crossCuttingAreas]
 */

// Apply YAML values on top of structural defaults. Mutates the section objects
// in `sections` in place (they are the fresh defaults from structuralDefaults()).
/**
 * @param {Settings} sections
 * @param {RawSettings} raw
 * @returns {void}
 */
export function applyYamlOverlay(sections, raw) {
  const { providers } = sections;
  const { consolidate, flush, hook, embed, recall, compile, gc, gate, wiki } =
    /** @type {Record<string, Record<string, unknown>>} */ (/** @type {unknown} */ (sections));

  if (raw.consolidate) {
    for (const k of Object.keys(consolidate)) {
      if (raw.consolidate[k] !== undefined) consolidate[k] = raw.consolidate[k];
    }
  }
  if (raw.flush) {
    for (const k of Object.keys(flush)) {
      if (raw.flush[k] !== undefined) flush[k] = raw.flush[k];
    }
  }
  if (raw.hook) {
    for (const k of Object.keys(hook)) {
      if (raw.hook[k] !== undefined) hook[k] = raw.hook[k];
    }
  }
  if (raw.embed) {
    for (const k of Object.keys(embed)) {
      if (raw.embed[k] !== undefined) embed[k] = raw.embed[k];
    }
  }
  if (raw.recall) {
    for (const k of Object.keys(recall)) {
      if (raw.recall[k] !== undefined) recall[k] = raw.recall[k];
    }
  }
  if (raw.compile) {
    for (const k of Object.keys(compile)) {
      if (raw.compile[k] !== undefined) compile[k] = raw.compile[k];
    }
  }
  if (raw.gc && raw.gc.intervalDays !== undefined) gc.intervalDays = raw.gc.intervalDays;
  if (raw.gate && raw.gate.selfImprovementEnabled !== undefined) {
    // Copy the raw value through UNCOERCED and let coerceBool(..., true) below
    // finalise it. Do NOT Boolean()-coerce here: Boolean(null) is a real
    // `false` that coerceBool then accepts, so an empty / commented-out /
    // null `selfImprovementEnabled:` in settings.yaml would silently DISABLE
    // the write-gate (fail-open). Passing null through makes coerceBool fall
    // back to the safe default (true), while an explicit `false` still
    // disables. The write-gate must fail CLOSED.
    gate.selfImprovementEnabled = raw.gate.selfImprovementEnabled;
  }
  if (raw.gate && raw.gate.claudeHookEnabled !== undefined) {
    // Same fail-closed rule as selfImprovementEnabled above: pass the raw
    // value through uncoerced so null/empty falls back to the safe default
    // (true) in the coerceBool below, while an explicit false still disables.
    gate.claudeHookEnabled = raw.gate.claudeHookEnabled;
  }
  if (raw.gate && raw.gate.auditTrailEnabled !== undefined) {
    // Fail-closed like the gate flags above: pass the raw value uncoerced so a
    // null/empty value falls back to the safe default (true) in coerceBool below.
    gate.auditTrailEnabled = raw.gate.auditTrailEnabled;
  }
  if (raw.gate && raw.gate.perLessonConsent !== undefined) {
    // Same fail-closed rule: a null/empty value keeps per-lesson consent ON.
    gate.perLessonConsent = raw.gate.perLessonConsent;
  }
  if (raw.gate && raw.gate.auditKeep !== undefined) {
    gate.auditKeep = raw.gate.auditKeep;
  }
  if (raw.wiki && raw.wiki.autoCommit !== undefined) {
    wiki.autoCommit = raw.wiki.autoCommit;
  }
  if (raw.providers && typeof raw.providers === "object") {
    const rp = raw.providers;
    for (const name of KNOWN_PROVIDERS) {
      const entry = /** @type {{ models?: unknown } | undefined} */ (rp[name]);
      if (entry && Array.isArray(entry.models)) {
        providers[name] = { models: normaliseModels(entry.models) };
      }
    }
    if (Array.isArray(rp.chain)) providers.chain = normaliseChain(rp.chain);
  }
  if (Array.isArray(raw.crossCuttingAreas)) {
    sections.crossCuttingAreas = raw.crossCuttingAreas
      .map((s) => String(s || "").trim())
      .filter(Boolean);
  } else if (typeof raw.crossCuttingAreas === "string") {
    sections.crossCuttingAreas = raw.crossCuttingAreas
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

// Auto-detect the provider chain when the YAML supplies an empty (or missing)
// list, then apply the strict-subset env overlay (provider + model). Mutates
// `sections.providers` in place.
/**
 * @param {Settings} sections
 * @param {{ cmdProbe?: CmdProbe }} [opts]
 * @returns {void}
 */
export function applyProviderChainAndEnv(sections, { cmdProbe } = {}) {
  const { providers } = sections;

  // Auto-detect providers chain when YAML supplies an empty (or missing) list.
  if (!providers.chain.length) {
    const available = detectAvailableProviders({ cmdProbe });
    providers.chain = STRUCTURAL_PROVIDER_ORDER.filter((p) => available.has(p));
  }

  // Strict-subset env overlay (provider + model). MEMORY_LLM_PROVIDER
  // collapses the chain; MEMORY_LLM_MODEL prepends to the head provider's
  // model list.
  const envProvider = envValue("MEMORY_LLM_PROVIDER", "").trim().toLowerCase();
  if (envProvider && KNOWN_PROVIDERS.includes(envProvider)) {
    providers.chain = [envProvider];
  }
  const envModel = envValue("MEMORY_LLM_MODEL", "").trim();
  if (envModel) {
    const head = providers.chain[0];
    if (head) {
      const existing = /** @type {ProviderModels | undefined} */ (providers[head])?.models || [];
      providers[head] = { models: [envModel, ...existing.filter((m) => m !== envModel)] };
    }
  }
}

// Self-throttle state IO and pass-selection resolution for the consolidate
// orchestrator. The ConsolidateState typedef lives in consolidate-report.mjs
// (the types hub) and is imported here type-only.

import fs from "node:fs";
import path from "node:path";
import { CONSOLIDATE_STATE_PATH } from "./lib/env.mjs";
import { consolidatePassesEnv } from "./lib/settings.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { ALL_PASS_NAMES } from "./consolidate-constants.mjs";

/** @typedef {import("./consolidate-report.mjs").ConsolidateState} ConsolidateState */

/**
 * @returns {ConsolidateState | null}
 */
export function readState() {
  try {
    const raw = fs.readFileSync(CONSOLIDATE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? /** @type {ConsolidateState} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * @param {ConsolidateState} state
 */
export function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(CONSOLIDATE_STATE_PATH), { recursive: true });
    // Atomic (unique temp + fsync + rename) so a crash mid-write can't leave a
    // truncated throttle file in place — readState would then treat it as
    // "never run" and reset the interval. Matches the durable JSON-state
    // writers (compile state, GC state), which all route through writeFileAtomic.
    writeFileAtomic(CONSOLIDATE_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    const e = /** @type {Error} */ (err);
    process.stderr.write(`[consolidate] state write failed: ${e?.message || e}\n`);
  }
}

/**
 * @param {string | string[] | null | undefined} passesArg
 * @returns {Set<string>}
 */
export function resolveAllowedPasses(passesArg) {
  // Resolution order: explicit arg from CLI/MCP > env > "all".
  //
  // Distinguish three cases:
  //   - passesArg === undefined / null  -> consult env (default "all")
  //   - passesArg === [] (empty array)  -> caller explicitly disabled ALL passes
  //     (orchestrator returns immediately with totals zero — useful as a
  //     dry-run / no-op probe)
  //   - passesArg === "" (empty string) -> same as []: no passes
  //   - non-empty CSV / array            -> exactly those passes
  //   - "all" / contains "all"           -> every pass
  if (passesArg == null) {
    const raw = consolidatePassesEnv();
    if (!raw || raw === "all") return new Set(ALL_PASS_NAMES);
    const parts = String(raw)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0 || parts.includes("all")) return new Set(ALL_PASS_NAMES);
    return new Set(parts);
  }
  // Explicit value: array OR string (from CLI --passes=).
  if (Array.isArray(passesArg)) {
    const parts = passesArg.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (parts.includes("all")) return new Set(ALL_PASS_NAMES);
    return new Set(parts);
  }
  const str = String(passesArg).trim();
  if (str === "") return new Set();
  if (str === "all") return new Set(ALL_PASS_NAMES);
  const parts = str
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes("all")) return new Set(ALL_PASS_NAMES);
  return new Set(parts);
}

/**
 * @param {string} name
 * @param {Set<string>} allowed
 * @returns {boolean}
 */
export function passEnabled(name, allowed) {
  return allowed.has(name);
}

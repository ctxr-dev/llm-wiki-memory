import fs from "node:fs";
import { CONSOLIDATE_ENTITIES_PATH } from "./lib/env.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { normalizeErrorSignature } from "./lib/error-signature.mjs";
import { retentionDaysSafe, escalateAfterSafe } from "./cron-shared.mjs";

/**
 * One entry in an entity's failure/success history.
 * @typedef {Object} HistoryEntry
 * @property {string} ts
 * @property {boolean} ok
 * @property {string} [signature]
 * @property {string} [excerpt]
 * @property {string | null} [logPath]
 */

/**
 * Per-entity attempt record tracked across cron runs.
 * @typedef {Object} EntityRecord
 * @property {string} kind
 * @property {string[]} ids
 * @property {number} consecutiveFailures
 * @property {string} firstFailedTs
 * @property {HistoryEntry[]} history
 * @property {string} [pass]
 * @property {string} [lastFailedTs]
 * @property {string} [lastSignature]
 */

/**
 * The persisted entity-state file (state/.consolidate-entities.json).
 * @typedef {Object} EntityState
 * @property {number} version
 * @property {Record<string, EntityRecord>} entities
 * @property {string} [updatedAt]
 */

/**
 * A single entity result inside one consolidate pass (success or failure).
 * @typedef {Object} PassEntity
 * @property {string} [id]
 * @property {string} [kind]
 * @property {string} [action]
 * @property {boolean} [ok]
 * @property {string} [excerpt]
 */

/**
 * One consolidate pass's per-entity results.
 * @typedef {Object} PassResult
 * @property {string} [name]
 * @property {PassEntity[]} [entities]
 * @property {PassEntity[]} [failures]
 */

/**
 * The subset of a consolidate report the cron path reads.
 * @typedef {Object} ConsolidateReport
 * @property {string | boolean} [skipped]
 * @property {boolean} [dryRun]
 * @property {boolean} [llmRequested]
 * @property {boolean} [llm]
 * @property {Record<string, PassResult>} [passes]
 * @property {Record<string, unknown>} [totals]
 * @property {number} [workingSetSize]
 */

/**
 * An escalation episode emitted by evaluateEscalations.
 * @typedef {Object} Escalation
 * @property {string} signature
 * @property {string} reason
 * @property {string | null} sinceTs
 * @property {string | null} lastTs
 * @property {number} attempts
 * @property {string[]} entityIds
 * @property {number} entityCount
 * @property {string[]} logPaths
 * @property {string[]} excerpts
 */

// The provider-availability synthesis (EX_UNAVAILABLE + synthesizeProviderEntities)
// lives in a sibling module; re-exported here so the public surface is unchanged.
export { EX_UNAVAILABLE, synthesizeProviderEntities } from "./cron-entity-state-synth.mjs";

// Same error signature across this many DISTINCT entities looks like a code
// bug (not a per-leaf accident) and escalates even when individual entities
// resolved. Internal heuristic, deliberately not a knob.
const BUG_FANOUT = 3;
// Hard sanity bound on tracked failing entities (pathological corpora only).
const MAX_TRACKED_ENTITIES = 5000;

// ─── per-entity attempt history ────────────────────────────────────────────

/** @returns {EntityState} */
export function readEntityState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONSOLIDATE_ENTITIES_PATH, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.entities &&
      typeof parsed.entities === "object"
    ) {
      return parsed;
    }
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e?.code !== "ENOENT") {
      process.stderr.write(
        `[cron-job] entity state unreadable (${e?.message || e}); rebuilding from the next run\n`,
      );
    }
  }
  return { version: 1, entities: {} };
}

/** @param {EntityState} state */
export function writeEntityState(state) {
  try {
    state.updatedAt = new Date().toISOString();
    writeFileAtomic(CONSOLIDATE_ENTITIES_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `[cron-job] failed to write entity state: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

// Fold one consolidate report into the entity history:
//   - every per-entity FAILURE increments its consecutive counter (capped
//     history, newest last);
//   - every per-entity SUCCESS deletes the key (resolved);
//   - an entity absent from both is left untouched (e.g. a stale leaf beyond
//     this run's refresh cap — not attempted, so its streak must not reset),
//     but entries idle past the full-log retention window are dropped.
/**
 * @param {EntityState} state
 * @param {ConsolidateReport} report
 * @param {{ ts: string, logPath: string | null, escalateAfter: number }} opts
 */
export function updateEntityState(state, report, { ts, logPath, escalateAfter }) {
  const passes = report?.passes || {};
  const historyCap = Math.max(escalateAfter + 2, 5);
  // Two-phase fold so the failure-beats-success rule is independent of pass
  // ordering: collect everything first, then apply. One increment per entity
  // per RUN, even when several passes failed on the same entity.
  /** @type {Set<string>} */
  const succeeded = new Set();
  /** @type {Map<string, { pass: string, kind?: string, excerpt?: string }>} */
  const failedNow = new Map();
  for (const [passName, pass] of Object.entries(passes)) {
    for (const e of pass?.entities || []) {
      if (e?.id) succeeded.add(e.id);
    }
    for (const f of pass?.failures || []) {
      if (f?.id) failedNow.set(f.id, { pass: passName, kind: f.kind, excerpt: f.excerpt });
    }
  }
  for (const [id, f] of failedNow) {
    const signature = normalizeErrorSignature(f.excerpt, { pass: f.pass, kind: f.kind });
    const cur = state.entities[id] || {
      kind: f.kind || "leaf",
      ids: id.startsWith("pair:") ? id.slice(5).split("|") : [id.replace(/^leaf:/, "")],
      consecutiveFailures: 0,
      firstFailedTs: ts,
      history: [],
    };
    cur.pass = f.pass;
    cur.consecutiveFailures += 1;
    cur.lastFailedTs = ts;
    cur.lastSignature = signature;
    cur.history.push({ ts, ok: false, signature, excerpt: f.excerpt, logPath });
    if (cur.history.length > historyCap) cur.history = cur.history.slice(-historyCap);
    state.entities[id] = cur;
  }
  for (const id of succeeded) {
    if (!failedNow.has(id)) delete state.entities[id];
  }

  // Age out entities that stopped being attempted entirely (deleted leaves,
  // retired pairs) so the map cannot grow without bound.
  const idleCutoff = Date.now() - retentionDaysSafe() * 86_400_000;
  for (const [id, ent] of Object.entries(state.entities)) {
    const lastMs = Date.parse(ent.lastFailedTs || "") || 0;
    if (lastMs < idleCutoff) delete state.entities[id];
  }
  const keys = Object.keys(state.entities);
  if (keys.length > MAX_TRACKED_ENTITIES) {
    keys
      .sort(
        (a, b) =>
          (Date.parse(state.entities[a].lastFailedTs || "") || 0) -
          (Date.parse(state.entities[b].lastFailedTs || "") || 0),
      )
      .slice(0, keys.length - MAX_TRACKED_ENTITIES)
      .forEach((k) => delete state.entities[k]);
    process.stderr.write(
      `[cron-job] entity history exceeded ${MAX_TRACKED_ENTITIES}; oldest entries dropped\n`,
    );
  }
  return state;
}

// Escalate when (a) an entity is still pending after N consecutive failures,
// or (b) one signature spans >= BUG_FANOUT distinct entities (recurring code
// bug, even if individual entities resolved). Counter-based — wall-clock skew
// cannot suppress an escalation.
/**
 * @param {EntityState} state
 * @param {{ escalateAfter?: number }} [opts]
 * @returns {Escalation[]}
 */
export function evaluateEscalations(state, { escalateAfter = escalateAfterSafe() } = {}) {
  /** @type {Map<string, Array<EntityRecord & { key: string }>>} */
  const bySig = new Map();
  for (const [key, ent] of Object.entries(state.entities || {})) {
    if (!ent?.lastSignature || !(ent.consecutiveFailures >= 1)) continue;
    if (!bySig.has(ent.lastSignature)) bySig.set(ent.lastSignature, []);
    /** @type {Array<EntityRecord & { key: string }>} */ (bySig.get(ent.lastSignature)).push({
      key,
      ...ent,
    });
  }
  /** @type {Escalation[]} */
  const escalations = [];
  for (const [signature, ents] of bySig) {
    const pending = ents.filter((e) => e.consecutiveFailures >= escalateAfter);
    // Fan-out counts distinct ENTITIES (a dedup pair is ONE entity even
    // though it spans two leaves); the leaf-id list is kept for display.
    const distinctEntities = [...new Set(ents.map((e) => e.key))];
    const distinctLeafIds = [...new Set(ents.flatMap((e) => e.ids || []))].sort();
    const looksLikeBug = distinctEntities.length >= BUG_FANOUT;
    if (pending.length === 0 && !looksLikeBug) continue;
    const histories = ents.flatMap((e) => e.history || []);
    escalations.push({
      signature,
      reason: pending.length > 0 ? "pending-consecutive" : "recurring-bug",
      sinceTs: ents.map((e) => e.firstFailedTs).sort()[0] || null,
      lastTs:
        ents
          .map((e) => e.lastFailedTs)
          .sort()
          .at(-1) || null,
      attempts: Math.max(...ents.map((e) => e.consecutiveFailures)),
      entityIds: distinctLeafIds,
      entityCount: distinctEntities.length,
      logPaths: /** @type {string[]} */ (
        [...new Set(histories.map((h) => h.logPath).filter(Boolean))].sort()
      ),
      excerpts: /** @type {string[]} */ (
        [
          ...new Set(
            histories
              .filter((h) => !h.ok)
              .map((h) => h.excerpt)
              .filter(Boolean),
          ),
        ].slice(0, 5)
      ),
    });
  }
  return escalations.sort((a, b) =>
    a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0,
  );
}

// Write-gate audit trail, an append-only, redacted ledger of every decision
// the self_improvement write-gate makes. It exists because the gate is
// otherwise INVISIBLE after the fact: the L2 Claude Code hook auto-allows a turn
// on a loose save phrase and the L3 server only checks an agent-asserted
// `userRequested` boolean, so a session-end flush can persist many lessons under
// one bulk approval with no record of how/whether a human consented. This module
// records that consent evidence so it can be inspected later (`cli.mjs gate-audit`).
//
// Design constraints (see .agents/rules/dev-principles.md):
//   - REUSE the single sanctioned scrubber redact() on every free-text field; an
//     audit record must never persist a secret that appeared in a title/phrase.
//   - Append with appendFileSync (rename semantics would defeat an append); the
//     front-truncation REWRITE goes through writeFileAtomic, following cron-job's
//     appendAttempt. NOTE: unlike cron-job (a single writer), this ledger is
//     written from TWO processes (the L2 hook + the L3/compile server-or-cron),
//     so the unlocked read-modify-write truncation can RARELY drop a record: if
//     ONE process appends between another's readFileSync and its rename, that
//     append is overwritten by the stale snapshot (only one process need be
//     truncating). Acceptable for an observability ledger that never feeds a gate
//     decision; not worth a lock.
//   - BEST-EFFORT: recording is observability, never a gate. It must never throw
//     into the caller and never change a gate decision. A failed append emits to
//     stderr and returns. The gate's correctness does not depend on this file.
//   - LAZY: when auditing is disabled, write nothing and create no file (matches
//     the monitoring-dir "no empty artifacts" rule).
import fs from "node:fs";
import path from "node:path";
import { SAVE_GATE_AUDIT_PATH } from "./env.mjs";
import { redact } from "./redact.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { writeGateAuditTrailEnabled, writeGateAuditKeep } from "./settings.mjs";

/**
 * @typedef {Object} GateAuditFields
 * @property {string} [layer]
 * @property {string} [tool]
 * @property {string} [status]
 * @property {string} [target]
 * @property {string} [consent]
 * @property {string} [action]
 * @property {unknown} [title]
 * @property {unknown} [area]
 * @property {unknown} [error_pattern]
 * @property {unknown} [priority]
 * @property {boolean} [userRequested]
 * @property {unknown} [trigger]
 * @property {Date} [now]
 */

/**
 * @typedef {Object} GateAuditRecord
 * @property {string} ts
 * @property {string} [layer]
 * @property {string} [tool]
 * @property {string} [status]
 * @property {string} [target]
 * @property {string} [consent]
 * @property {string} [action]
 * @property {string} [title]
 * @property {string} [area]
 * @property {string} [error_pattern]
 * @property {string} [priority]
 * @property {boolean} [userRequested]
 * @property {string} [trigger]
 */

// Redact a free-text value, then collapse newline runs to a single space for
// readability of the raw log. The one-record-one-line JSONL invariant itself is
// guaranteed by JSON.stringify (it escapes any embedded control char, so a record
// never splits); this collapse is a cosmetic normalisation of the redacted value,
// not the guarantee.
/**
 * @param {unknown} s
 * @returns {string}
 */
function rd(s) {
  return redact(String(s ?? ""))
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

// Persisted-length caps, applied AFTER redaction (see field()/buildRecord) so a
// secret straddling a cap can never leave a non-redacted fragment on disk — the
// scrubber always sees the full text first. The trigger (a whole user turn) gets
// a tighter cap than the structured fields, which bounds a pathological
// area/error_pattern (no zod .max() upstream) so no single append line is unbounded.
const TRIGGER_MAX = 200;
const FIELD_MAX = 500;

// Redact a free-text field, cap its length, and return null when it is
// absent/empty so the caller omits it (one uniform rule for title / area /
// error_pattern / trigger, instead of three slightly different inline guards).
/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
function field(value, max) {
  if (value === undefined || value === null) return null;
  const s = rd(value);
  return s === "" ? null : s.slice(0, max);
}

// The consent basis the L3 gate recorded for an ACCEPTED self_improvement write,
// derived from the SAME inputs the gate used. Exported so it is unit-testable;
// the server's auditGatedL3 calls it.
/**
 * @param {boolean} [userRequested]
 * @param {unknown} [isMaintenance]
 * @returns {string}
 */
export function consentBasis(userRequested, isMaintenance) {
  if (userRequested === true) return "user-flag";
  if (isMaintenance) return "system-maintenance";
  return "gate-disabled";
}

// Build the canonical record. Only known fields are emitted (no raw bodies), and
// every free-text field is redacted. `now` is injectable for deterministic tests.
/**
 * @param {GateAuditFields} [fields]
 * @returns {GateAuditRecord}
 */
function buildRecord(fields = {}) {
  const {
    layer, // "L2" | "L3" | "compile"
    tool, // save_lesson | save_to_dataset | write_memory | pretooluse | compile
    status, // accepted | refused | allow | ask
    target = "self_improvement",
    consent, // user-flag | system-maintenance | gate-disabled | compile-distilled (optional)
    action, // create | update (optional; compile promotions)
    title,
    area,
    error_pattern,
    priority, // apply-strength of the saved atom (P0/P1/P2), optional
    userRequested,
    trigger, // the matched user phrase (L2), redacted
    now = new Date(),
  } = fields;
  /** @type {GateAuditRecord} */
  const rec = { ts: now.toISOString() };
  if (layer) rec.layer = layer;
  if (tool) rec.tool = tool;
  if (status) rec.status = status;
  if (target) rec.target = target;
  if (consent) rec.consent = consent;
  if (action) rec.action = action;
  const t = field(title, FIELD_MAX);
  if (t !== null) rec.title = t;
  const a = field(area, FIELD_MAX);
  if (a !== null) rec.area = a;
  const ep = field(error_pattern, FIELD_MAX);
  if (ep !== null) rec.error_pattern = ep;
  if (priority) rec.priority = String(priority).trim().toUpperCase();
  if (userRequested !== undefined) rec.userRequested = userRequested === true;
  const tr = field(trigger, TRIGGER_MAX);
  if (tr !== null) rec.trigger = tr;
  return rec;
}

// Append ONE gate decision to the ledger. No-op when auditing is disabled.
// Returns the record written (for tests) or null when skipped/failed.
/**
 * @param {GateAuditFields} [fields]
 * @param {{ path?: string }} [opts]
 * @returns {GateAuditRecord | null}
 */
export function recordGatedWrite(fields = {}, { path: auditPath = SAVE_GATE_AUDIT_PATH } = {}) {
  try {
    if (!writeGateAuditTrailEnabled()) return null;
  } catch {
    // settings unreadable: stay silent rather than risk throwing into a gate path.
    return null;
  }
  let rec;
  try {
    // buildRecord is INSIDE the guard so a malformed injected field (e.g. a
    // non-Date `now`) can never throw into the gate/compile path this best-effort
    // logger runs in.
    rec = buildRecord(fields);
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(rec) + "\n");
  } catch (err) {
    process.stderr.write(
      `[save-gate-audit] failed to append audit log: ${/** @type {string} */ (/** @type {Error} */ (err)?.message || err)}\n`,
    );
    return null;
  }
  // Front-truncate to the configured cap (best-effort; a rewrite via atomic write).
  try {
    let keepN = 1000;
    try {
      keepN = writeGateAuditKeep();
    } catch {
      /* use the structural fallback */
    }
    const lines = fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean);
    if (lines.length > keepN) {
      writeFileAtomic(auditPath, lines.slice(-keepN).join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
  return rec;
}

// Read the most recent `limit` audit records (newest last). Corrupt lines are
// skipped, never thrown. Returns [] when the ledger does not exist yet.
/**
 * @param {{ limit?: number, path?: string }} [opts]
 * @returns {GateAuditRecord[]}
 */
export function readAudit({ limit = 50, path: auditPath = SAVE_GATE_AUDIT_PATH } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(auditPath, "utf8");
  } catch {
    return [];
  }
  /** @type {GateAuditRecord[]} */
  const recs = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      recs.push(JSON.parse(t));
    } catch {
      /* skip a torn / partial line */
    }
  }
  const n = Number.isFinite(limit) && limit > 0 ? limit : recs.length;
  return recs.slice(-n);
}

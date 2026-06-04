// Cron-driven daily compile + consolidate runner.
//
// The cron entry (installed by bootstrap.sh --schedule daily) invokes this
// HOURLY, but the actual work is bounded by:
//   - compile.mjs's own per-UTC-day state file
//     (state/.compile-state.json — already in place)
//   - consolidate.mjs's `--if-due` throttle keyed off
//     `consolidate.intervalDays` in settings.yaml (default 1, once per day)
// So an hourly cron + per-step throttling means: the system attempts up to
// 24× per day, but does the heavy lifting at most once.
//
// Logging is two-tier:
//   - state/.consolidate-attempts.log keeps the last `consolidate.attemptsKeep`
//     SLIM entries (one JSON line per run: ok/exit/totals + a logPath pointer;
//     no embedded stderr).
//   - state/logs/<yyyy>/<mm>/cron-<epochMs>.json holds the FULL record of every
//     run (redacted stdout/stderr + the complete consolidate report including
//     per-entity entities[]/failures[]), pruned after
//     `consolidate.fullLogRetentionDays`.
//
// Self-healing is judged per ENTITY, not per run: state/.consolidate-entities.json
// tracks consecutive per-entity failures across runs. An entity still failing
// after `consolidate.escalateAfterAttempts` consecutive attempts — or one error
// signature recurring across BUG_FANOUT distinct entities — escalates into a
// skeleton issue report at issues/<yyyy>/<mm>/<dd>/<signature>.<version>.md
// (whole document redacted; episodes version on recurrence after resolution).
// A transient failure that later succeeds resolves silently: its report flips
// to status: resolved and the entity history is dropped.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  MEMORY_DATA_DIR,
  MEMORY_DIR,
  CONSOLIDATE_ENTITIES_PATH,
  CRON_LOGS_DIR,
  ISSUES_DIR,
  ISSUES_INDEX_PATH,
} from "./lib/env.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { redact } from "./lib/redact.mjs";
import { dailyDatePath } from "./lib/slug.mjs";
import { normalizeErrorSignature } from "./lib/error-signature.mjs";
import { maybeGcWikiRepo } from "./lib/wiki-commit.mjs";
import {
  consolidateAttemptsKeep,
  consolidateFullLogRetentionDays,
  consolidateEscalateAfterAttempts,
} from "./lib/settings.mjs";

export const ATTEMPTS_LOG_PATH = path.join(
  MEMORY_DATA_DIR,
  "state",
  ".consolidate-attempts.log",
);

// Same error signature across this many DISTINCT entities looks like a code
// bug (not a per-leaf accident) and escalates even when individual entities
// resolved. Internal heuristic, deliberately not a knob.
const BUG_FANOUT = 3;
// Hard sanity bound on tracked failing entities (pathological corpora only).
const MAX_TRACKED_ENTITIES = 5000;
// Full compile stdout is preserved in the full log, but bounded.
const STDOUT_CAP_BYTES = 64 * 1024;
// compile.mjs exits 69 (BSD EX_UNAVAILABLE) when daily docs are pending but
// no LLM/bridge provider is reachable. The tick still runs consolidate (its
// deterministic passes don't need a provider), but counts as a FAILED
// attempt and feeds the synthetic escalation entity below.
const EX_UNAVAILABLE = 69;
// Synthetic self-healing entities for provider availability. They ride the
// SAME updateEntityState/evaluateEscalations/writeIssueReports machinery as
// dedup-pair/leaf entities: consecutive provider-unavailable ticks escalate
// into an issue report after consolidate.escalateAfterAttempts, and the
// first healthy tick records a success that resolves the episode.
const SYNTH_COMPILE_ENTITY = "system:compile-llm-providers";
const SYNTH_CONSOLIDATE_ENTITY = "system:consolidate-llm-providers";
const SYNTH_COMPILE_PASS = "compile-promote";
const SYNTH_CONSOLIDATE_PASS = "consolidate-llm";
const CRON_LOG_RE = /^cron-(\d+)\.json$/;

// Settings readers that can never fail the cron path.
function attemptsKeepSafe() {
  try { return consolidateAttemptsKeep(); } catch { return 50; }
}
function retentionDaysSafe() {
  try { return consolidateFullLogRetentionDays(); } catch { return 90; }
}
function escalateAfterSafe() {
  try { return consolidateEscalateAfterAttempts(); } catch { return 3; }
}

const collapse = (v) => String(v || "").replace(/\s+/g, " ").trim();

// ─── slim attempt log ──────────────────────────────────────────────────────

function appendAttempt(entry) {
  try {
    fs.mkdirSync(path.dirname(ATTEMPTS_LOG_PATH), { recursive: true });
    fs.appendFileSync(ATTEMPTS_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Logging itself must not fail the cron job; emit to stderr and move on.
    process.stderr.write(
      `[cron-job] failed to append attempt log: ${err?.message || err}\n`,
    );
    return;
  }
  // Front-truncate to the configured number of runs (best-effort).
  try {
    const keepN = attemptsKeepSafe();
    const lines = fs
      .readFileSync(ATTEMPTS_LOG_PATH, "utf8")
      .split("\n")
      .filter(Boolean);
    if (lines.length > keepN) {
      const keep = lines.slice(-keepN);
      writeFileAtomic(ATTEMPTS_LOG_PATH, keep.join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
}

// Tolerant of both the slim format and pre-redesign "fat" entries (which
// embedded stderr + a consolidate.summary object): only ok/ts/error are read
// by health logic, and those exist in every format.
export function readAttempts({ limit = 50 } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(ATTEMPTS_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return out.slice(-limit);
}

// ─── sharded full run logs ─────────────────────────────────────────────────

export function fullLogPathFor(date = new Date()) {
  const shard = dailyDatePath(date).split("/").slice(0, 2).join(path.sep); // yyyy/mm
  return path.join(CRON_LOGS_DIR, shard, `cron-${date.getTime()}.json`);
}

function relToDataDir(abs) {
  return path.relative(MEMORY_DATA_DIR, abs);
}

function writeFullLog(absPath, fullEntry) {
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileAtomic(absPath, JSON.stringify(fullEntry, null, 2) + "\n");
    return relToDataDir(absPath);
  } catch (err) {
    process.stderr.write(
      `[cron-job] failed to write full run log: ${err?.message || err}\n`,
    );
    return null;
  }
}

// Delete full logs older than the retention window. Age is parsed from the
// FILENAME epoch (never mtime — clock skew / touch must not resurrect or
// expire a log). Best-effort throughout: pruning can never fail the run.
export function pruneFullLogs(now = new Date(), retentionDays = retentionDaysSafe()) {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  let years;
  try {
    years = fs.readdirSync(CRON_LOGS_DIR);
  } catch {
    return { removed };
  }
  for (const yyyy of years) {
    const yearDir = path.join(CRON_LOGS_DIR, yyyy);
    let months;
    try {
      months = fs.readdirSync(yearDir);
    } catch {
      continue;
    }
    for (const mm of months) {
      const monthDir = path.join(yearDir, mm);
      let files;
      try {
        files = fs.readdirSync(monthDir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = CRON_LOG_RE.exec(f);
        if (!m) continue;
        if (Number(m[1]) >= cutoff) continue;
        try {
          fs.rmSync(path.join(monthDir, f), { force: true });
          removed++;
        } catch {
          /* race / permissions — skip */
        }
      }
      try {
        if (fs.readdirSync(monthDir).length === 0) fs.rmdirSync(monthDir);
      } catch { /* best effort */ }
    }
    try {
      if (fs.readdirSync(yearDir).length === 0) fs.rmdirSync(yearDir);
    } catch { /* best effort */ }
  }
  return { removed };
}

// ─── per-entity attempt history ────────────────────────────────────────────

export function readEntityState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONSOLIDATE_ENTITIES_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entities && typeof parsed.entities === "object") {
      return parsed;
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      process.stderr.write(
        `[cron-job] entity state unreadable (${err?.message || err}); rebuilding from the next run\n`,
      );
    }
  }
  return { version: 1, entities: {} };
}

export function writeEntityState(state) {
  try {
    state.updatedAt = new Date().toISOString();
    writeFileAtomic(CONSOLIDATE_ENTITIES_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `[cron-job] failed to write entity state: ${err?.message || err}\n`,
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
export function updateEntityState(state, report, { ts, logPath, escalateAfter }) {
  const passes = report?.passes || {};
  const historyCap = Math.max(escalateAfter + 2, 5);
  // Two-phase fold so the failure-beats-success rule is independent of pass
  // ordering: collect everything first, then apply. One increment per entity
  // per RUN, even when several passes failed on the same entity.
  const succeeded = new Set();
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
      .sort((a, b) => (Date.parse(state.entities[a].lastFailedTs || "") || 0) - (Date.parse(state.entities[b].lastFailedTs || "") || 0))
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
export function evaluateEscalations(state, { escalateAfter = escalateAfterSafe() } = {}) {
  const bySig = new Map();
  for (const [key, ent] of Object.entries(state.entities || {})) {
    if (!ent?.lastSignature || !(ent.consecutiveFailures >= 1)) continue;
    if (!bySig.has(ent.lastSignature)) bySig.set(ent.lastSignature, []);
    bySig.get(ent.lastSignature).push({ key, ...ent });
  }
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
      lastTs: ents.map((e) => e.lastFailedTs).sort().at(-1) || null,
      attempts: Math.max(...ents.map((e) => e.consecutiveFailures)),
      entityIds: distinctLeafIds,
      entityCount: distinctEntities.length,
      logPaths: [...new Set(histories.map((h) => h.logPath).filter(Boolean))].sort(),
      excerpts: [...new Set(histories.filter((h) => !h.ok).map((h) => h.excerpt).filter(Boolean))].slice(0, 5),
    });
  }
  return escalations.sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}

// Fold provider availability into synthetic entity passes. Pure: returns a
// passes map shaped exactly like a consolidate report's `passes`, so
// updateEntityState consumes it unchanged.
//   - compile exit 69  -> compile-promote failure (excerpt = the redacted
//     abort line, so ENOENT vs timeout vs auth produce DIFFERENT signatures
//     and therefore different episodes — they are different root causes
//     with different operator fixes);
//   - compile ok       -> compile-promote success (resolves the episode);
//   - real consolidate report with llmRequested && !llm -> consolidate-llm
//     failure (LLM passes silently skipped); llmRequested && llm -> success.
// A skipped/dry-run consolidate — or one with llmRequested=false (--no-llm)
// — contributes nothing: its LLM half was never supposed to run, so there
// is no signal either way (recording success there would wrongly resolve
// an open episode without any provider attempt).
export function synthesizeProviderEntities({ compileExit = null, compileOk = null, compileError = "", report = null } = {}) {
  const passes = {};
  if (compileExit === EX_UNAVAILABLE) {
    // Tail-first excerpt: the chain error reads "...exhausted (<providers>);
    // last: <the actual cause>". normalizeErrorSignature slugs only the
    // first 80 chars, and the shared prefix is longer than that — without
    // the reorder, ENOENT and timeout aborts would collapse into ONE
    // episode despite needing different operator fixes.
    const raw = collapse(compileError) || `compile providers unavailable (exit ${EX_UNAVAILABLE})`;
    const lastIdx = raw.indexOf("; last: ");
    const excerpt = lastIdx >= 0 ? `${raw.slice(lastIdx + "; last: ".length)} <= ${raw.slice(0, lastIdx)}` : raw;
    passes[SYNTH_COMPILE_PASS] = {
      name: SYNTH_COMPILE_PASS,
      entities: [],
      failures: [{
        id: SYNTH_COMPILE_ENTITY,
        kind: "system-provider",
        action: "promote",
        ok: false,
        excerpt,
      }],
    };
  } else if (compileOk === true) {
    passes[SYNTH_COMPILE_PASS] = {
      name: SYNTH_COMPILE_PASS,
      entities: [{ id: SYNTH_COMPILE_ENTITY, kind: "system-provider", action: "promote", ok: true }],
      failures: [],
    };
  }
  const realConsolidate = Boolean(report && !report.skipped && !report.dryRun);
  if (realConsolidate && report.llmRequested === true) {
    const llmSkipped = report.llm === false;
    passes[SYNTH_CONSOLIDATE_PASS] = llmSkipped
      ? {
          name: SYNTH_CONSOLIDATE_PASS,
          entities: [],
          failures: [{
            id: SYNTH_CONSOLIDATE_ENTITY,
            kind: "system-provider",
            action: "llm-pass",
            ok: false,
            excerpt: "consolidate: LLM passes skipped (provider unavailable) llmRequested=true llm=false",
          }],
        }
      : {
          name: SYNTH_CONSOLIDATE_PASS,
          entities: [{ id: SYNTH_CONSOLIDATE_ENTITY, kind: "system-provider", action: "llm-pass", ok: true }],
          failures: [],
        };
  }
  return passes;
}

// ─── issue reports (deterministic skeletons) ───────────────────────────────

export function readIssuesIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ISSUES_INDEX_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.signatures && typeof parsed.signatures === "object") {
      return parsed;
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      process.stderr.write(
        `[cron-job] issues index unreadable (${err?.message || err}); rebuilding from issues/ tree\n`,
      );
      return rebuildIssuesIndex();
    }
  }
  return { version: 1, signatures: {} };
}

// Best-effort recovery from a corrupt index: walk issues/**.md frontmatter
// for signature/version/status. Occurrence detail is not recoverable (the
// index owns it), but dedupe + status survive, which is what matters.
function rebuildIssuesIndex() {
  const idx = { version: 1, signatures: {} };
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const head = fs.readFileSync(p, "utf8").slice(0, 2_000);
          const sig = /^signature:\s*(.+)$/m.exec(head)?.[1]?.trim();
          const version = Number(/^version:\s*(\d+)$/m.exec(head)?.[1] || 1);
          const status = /^status:\s*(\w+)/m.exec(head)?.[1] || "open";
          if (!sig) continue;
          const cur = idx.signatures[sig];
          if (!cur || version > cur.version) {
            idx.signatures[sig] = { version, path: relToDataDir(p), status, occurrences: [] };
          }
        } catch {
          /* skip unreadable report */
        }
      }
    }
  };
  walk(ISSUES_DIR);
  return idx;
}

function writeIssuesIndex(idx) {
  try {
    writeFileAtomic(ISSUES_INDEX_PATH, JSON.stringify(idx, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `[cron-job] failed to write issues index: ${err?.message || err}\n`,
    );
  }
}

// The .md report is a pure RENDER of index-held state: every write regenerates
// the whole file (no markdown parsing on the read side), then the WHOLE
// document passes redact() — these reports are meant to be copied upstream
// and must never carry a secret.
function renderIssueReport(rec) {
  const e = rec.escalation;
  const lines = [
    "---",
    `status: ${rec.status}`,
    `signature: ${rec.signature}`,
    `version: ${rec.version}`,
    `reason: ${e.reason}`,
    `firstSeen: ${e.sinceTs || "unknown"}`,
    `lastSeen: ${e.lastTs || "unknown"}`,
    `attempts: ${e.attempts}`,
    ...(rec.resolvedAt ? [`resolvedAt: ${rec.resolvedAt}`] : []),
    "affectedEntityIds:",
    ...e.entityIds.map((id) => `  - ${collapse(id)}`),
    "logPaths:",
    ...e.logPaths.map((p) => `  - ${collapse(p)}`),
    "---",
    "",
    `# Consolidate escalation: ${collapse(rec.signature)}`,
    "",
    "Auto-generated skeleton: a consolidation action kept failing for the same",
    `entity across ${e.attempts} consecutive cron attempt(s)` +
      (e.reason === "recurring-bug" ? ` and the same error signature spans ${e.entityCount} distinct entities (likely a code bug)` : "") +
      ". Copy this report to the llm-wiki-memory issue tracker, or use it to draft a fix PR; an agent can deepen the analysis from the linked full logs on request.",
    "",
    "## Error excerpts (redacted)",
    ...(e.excerpts.length ? e.excerpts.map((x) => `- ${collapse(x)}`) : ["- (no excerpt captured)"]),
    "",
    "## Occurrences",
    ...rec.occurrences.map((o) => `- ${o.ts} — attempts=${o.attempts} entities=${o.entityCount} — ${o.logPath || "(no log)"}`),
    "",
    "## Affected entities",
    ...e.entityIds.map((id) => `- ${collapse(id)}`),
    "",
    "<!-- agent: deepen this analysis only on explicit user request; start from the logPaths above -->",
    "",
  ];
  return redact(lines.join("\n"));
}

export function writeIssueReports(escalations, state, now = new Date()) {
  const idx = readIssuesIndex();
  const ts = now.toISOString();
  const touched = [];

  for (const esc of escalations) {
    let rec = idx.signatures[esc.signature];
    if (!rec || rec.status !== "open") {
      const version = (rec?.version || 0) + 1;
      const abs = path.join(
        ISSUES_DIR,
        dailyDatePath(now).split("/").join(path.sep),
        `${esc.signature}.${version}.md`,
      );
      rec = {
        version,
        path: relToDataDir(abs),
        status: "open",
        occurrences: [],
      };
      idx.signatures[esc.signature] = rec;
    }
    rec.signature = esc.signature;
    rec.escalation = esc;
    rec.occurrences.push({ ts, attempts: esc.attempts, entityCount: esc.entityCount, logPath: esc.logPaths.at(-1) || null });
    if (rec.occurrences.length > 50) rec.occurrences = rec.occurrences.slice(-50);
    const abs = path.join(MEMORY_DATA_DIR, rec.path);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeFileAtomic(abs, renderIssueReport(rec));
      delete rec.unrendered;
      touched.push(rec.path);
    } catch (err) {
      // The episode must stay in the index (dedupe would otherwise mint a new
      // version every run), but flag it so health surfaces an honest path.
      rec.unrendered = true;
      process.stderr.write(
        `[cron-job] failed to write issue report ${rec.path}: ${err?.message || err}\n`,
      );
    }
  }

  // Resolution: an open episode whose signature no longer has ANY tracked
  // failing entity flips to resolved in place (file kept, never pruned).
  const liveSignatures = new Set(
    Object.values(state.entities || {}).map((e) => e.lastSignature).filter(Boolean),
  );
  for (const [sig, rec] of Object.entries(idx.signatures)) {
    if (rec.status !== "open" || liveSignatures.has(sig)) continue;
    rec.status = "resolved";
    rec.resolvedAt = ts;
    if (rec.escalation) {
      const abs = path.join(MEMORY_DATA_DIR, rec.path);
      try {
        writeFileAtomic(abs, renderIssueReport(rec));
      } catch {
        /* file may have been hand-moved; index still records the resolution */
      }
    }
    touched.push(rec.path);
  }

  writeIssuesIndex(idx);
  return { touched, openCount: Object.values(idx.signatures).filter((r) => r.status === "open").length };
}

function openEscalationsFromIndex() {
  const idx = readIssuesIndex();
  return Object.entries(idx.signatures)
    .filter(([, rec]) => rec.status === "open")
    .map(([signature, rec]) => ({
      signature,
      sinceTs: rec.escalation?.sinceTs || null,
      attempts: rec.escalation?.attempts ?? null,
      entityCount: rec.escalation?.entityCount ?? null,
      issuePath: rec.path,
      ...(rec.unrendered ? { unrendered: true } : {}),
    }))
    .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}

// ─── runner ───────────────────────────────────────────────────────────────

function runStep(cli, args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
  });
  return {
    ok: r.status === 0,
    exit: typeof r.status === "number" ? r.status : -1,
    stderr: String(r.stderr || ""),
    stdout: String(r.stdout || ""),
  };
}

// Run compile + consolidate sequentially. Returns the SLIM log entry that was
// appended; the full record (redacted stdout/stderr + complete consolidate
// report) lands in the sharded full log either way. Throws nothing.
export async function runCronJob() {
  const start = new Date();
  const ts = start.toISOString();
  const cli = path.join(MEMORY_DIR, "scripts", "cli.mjs");
  const fullLogAbs = fullLogPathFor(start);
  const logPathRel = relToDataDir(fullLogAbs);

  const entry = {
    ts,
    kind: "cron-job",
    ok: false,
    durationMs: 0,
    compile: null,
    consolidate: null,
    error: null,
    logPath: logPathRel,
    escalations: 0,
  };
  const full = {
    ts,
    kind: "cron-job",
    ok: false,
    durationMs: 0,
    compile: null,
    consolidate: null,
    escalations: [],
    error: null,
  };

  let compileProvidersUnavailable = false;
  let compileErrorFull = "";
  let report = null;

  // Entity-level self-healing, recorded on EVERY finished tick (also the
  // early-return paths: a consolidate hard-failure on a provider-unavailable
  // tick must not lose the compile failure streak). Consolidate's per-entity
  // results only count on a REAL run (a not-due or dry run must not mutate
  // their streaks), but the synthetic provider entities are judged whenever
  // compile produced a result — compile runs hourly, so its availability
  // signal (failure streaks AND the success that resolves an episode) must
  // not wait for consolidate's daily cadence.
  const recordSelfHealing = () => {
    try {
      const realConsolidate = Boolean(report && !report.skipped && !report.dryRun);
      const synthetic = synthesizeProviderEntities({
        compileExit: entry.compile?.exit,
        compileOk: entry.compile?.ok,
        compileError: compileErrorFull,
        report,
      });
      const passes = { ...(realConsolidate ? report.passes || {} : {}), ...synthetic };
      if (Object.keys(passes).length === 0) return;
      const escalateAfter = escalateAfterSafe();
      const state = readEntityState();
      updateEntityState(state, { passes }, { ts, logPath: logPathRel, escalateAfter });
      let escalations = evaluateEscalations(state, { escalateAfter });
      if (!realConsolidate) {
        // Off-cycle tick: only the synthetic entities were attempted. Limit
        // occurrence appends to THEIR signatures so a pending consolidate
        // episode doesn't accrue an hourly "still pending" occurrence for
        // runs that never attempted it (24x noise would churn the capped
        // occurrence window). Resolution below still sees the full state.
        const syntheticPasses = new Set(Object.keys(synthetic));
        const touchedSigs = new Set(
          Object.values(state.entities || {})
            .filter((e) => syntheticPasses.has(e.pass))
            .map((e) => e.lastSignature)
            .filter(Boolean),
        );
        escalations = escalations.filter((e) => touchedSigs.has(e.signature));
      }
      const issues = writeIssueReports(escalations, state, start);
      writeEntityState(state);
      entry.escalations = issues.openCount;
      full.escalations = escalations;
    } catch (err) {
      // Healing bookkeeping must never fail the cron run itself.
      process.stderr.write(
        `[cron-job] self-healing bookkeeping failed: ${err?.message || err}\n`,
      );
    }
  };

  const finish = () => {
    recordSelfHealing();
    entry.durationMs = Date.now() - start.getTime();
    full.ok = entry.ok;
    full.error = entry.error;
    full.durationMs = entry.durationMs;
    writeFullLog(fullLogAbs, full);
    appendAttempt(entry);
    pruneFullLogs(start);
    // Compact the wiki repo's object store (auto-commit churn); git's own
    // --auto threshold makes this a cheap no-op on most ticks.
    maybeGcWikiRepo();
    return entry;
  };

  // 1. compile. Per-UTC-day state makes repeat attempts cheap no-ops.
  // Exit 69 (EX_UNAVAILABLE) = daily docs pending but no provider reachable:
  // the tick is a FAILED attempt (entry.ok stays false, cron-health flips
  // unhealthy until the next good tick), but consolidate still runs — its
  // deterministic passes don't need a provider.
  try {
    const r = runStep(cli, ["compile"]);
    entry.compile = { ok: r.ok, exit: r.exit };
    full.compile = {
      ok: r.ok,
      exit: r.exit,
      stderr: redact(r.stderr),
      stdout: redact(r.stdout).slice(0, STDOUT_CAP_BYTES),
    };
    if (!r.ok) {
      compileProvidersUnavailable = r.exit === EX_UNAVAILABLE;
      // Uncapped (collapsed + redacted) for the synthetic-entity excerpt:
      // the 200-char slim-log cap can cut off the "last: ..." tail that
      // differentiates abort signatures.
      compileErrorFull = collapse(redact(r.stderr));
      entry.error = compileErrorFull.slice(0, 200) || `compile exit ${r.exit}`;
      if (!compileProvidersUnavailable) return finish();
    }
  } catch (err) {
    entry.error = `compile dispatch threw: ${collapse(redact(err?.message || err)).slice(0, 200)}`;
    return finish();
  }

  // 2. consolidate --if-due --json (self-throttled by consolidate.intervalDays).
  try {
    const r = runStep(cli, ["consolidate", "--if-due", "--json"]);
    entry.consolidate = { ok: r.ok, exit: r.exit };
    full.consolidate = { ok: r.ok, exit: r.exit, stderr: redact(r.stderr), report: null };
    if (!r.ok) {
      entry.error = collapse(redact(r.stderr)).slice(0, 200) || `consolidate exit ${r.exit}`;
      return finish();
    }
    try {
      report = JSON.parse(r.stdout);
    } catch {
      /* unparseable stdout — step still OK if exit was 0 */
    }
    if (report) {
      full.consolidate.report = report;
      entry.consolidate.totals = report.totals || null;
      entry.consolidate.workingSetSize = report.workingSetSize ?? null;
      entry.consolidate.skipped = report.skipped || null;
      entry.consolidate.dryRun = Boolean(report.dryRun);
      entry.consolidate.llm = report.llm ?? null;
      entry.consolidate.llmRequested = report.llmRequested ?? null;
    }
  } catch (err) {
    entry.error = `consolidate dispatch threw: ${collapse(redact(err?.message || err)).slice(0, 200)}`;
    return finish();
  }

  // 3. Self-healing bookkeeping runs inside finish() so it covers the
  //    early-return paths too.
  entry.ok = !compileProvidersUnavailable;
  return finish();
}

// ─── health ───────────────────────────────────────────────────────────────

// Inspect the attempt log + open escalations to decide whether the cron
// pipeline is healthy. Two-tier output:
//   - `summary` (≤200 chars) is a single-line deterministic signal safe to
//     embed in SessionStart's additionalContext. NO JSON, NO stderr dump.
//   - `lastAttempt` / `recent` / `escalations` carry the detail for callers
//     that explicitly want it (the CLI prints them; the hook does NOT).
//
// Unhealthy ⟺ the most-recent attempt errored with no later success, OR at
// least one escalation episode is still open (entity-level: the same entity
// kept failing across runs, or one signature spans many entities). A failure
// that later resolved stays silent.
export function cronHealth({ limit = 20 } = {}) {
  const all = readAttempts({ limit: Math.max(attemptsKeepSafe(), 200) });
  const escalations = openEscalationsFromIndex();
  const lastAttempt = all.length ? all[all.length - 1] : null;

  if (!lastAttempt && escalations.length === 0) {
    return {
      ok: true,
      healthy: true,
      summary: "no cron-job attempts logged yet (system fresh or cron not yet scheduled)",
      lastAttempt: null,
      escalations,
    };
  }

  const shortError = collapse(lastAttempt?.error || "<no detail>").slice(0, 120);

  if (escalations.length > 0) {
    const newest = escalations.reduce((a, b) => ((a.sinceTs || "") >= (b.sinceTs || "") ? a : b));
    const where = newest.unrendered
      ? `report write FAILED (signature ${newest.signature}; see cron stderr)`
      : `newest report ${newest.issuePath}`;
    return {
      ok: true,
      healthy: false,
      summary: `UNRESOLVED: ${escalations.length} open consolidation escalation(s); ${where}`.slice(0, 200),
      lastAttempt,
      escalations,
    };
  }

  if (lastAttempt.ok === false) {
    return {
      ok: true,
      healthy: false,
      summary: `UNRESOLVED FAILURE at ${lastAttempt.ts}: ${shortError}`,
      lastAttempt,
      escalations,
    };
  }

  let lastFailureAt = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].ok === false) {
      lastFailureAt = all[i].ts;
      break;
    }
  }
  return {
    ok: true,
    healthy: true,
    summary: `healthy; last cron-job ok at ${lastAttempt.ts}`,
    lastAttempt,
    lastSuccessAt: lastAttempt.ts,
    ...(lastFailureAt ? { lastFailureAt } : {}),
    recent: all.slice(-limit),
    escalations,
  };
}

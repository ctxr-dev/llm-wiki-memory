import fs from "node:fs";
import path from "node:path";
import { MEMORY_DATA_DIR, ISSUES_DIR, ISSUES_INDEX_PATH } from "./lib/env.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { redact } from "./lib/redact.mjs";
import { dailyDatePath } from "./lib/slug.mjs";
import { collapse, relToDataDir } from "./cron-shared.mjs";

/** @typedef {import("./cron-entity-state.mjs").Escalation} Escalation */
/** @typedef {import("./cron-entity-state.mjs").EntityState} EntityState */

/**
 * One recorded occurrence of an escalation episode.
 * @typedef {Object} IssueOccurrence
 * @property {string} ts
 * @property {number} attempts
 * @property {number} entityCount
 * @property {string | null} logPath
 */

/**
 * One escalation episode tracked in the issues index (and rendered to a report).
 * @typedef {Object} IssueRecord
 * @property {number} version
 * @property {string} path
 * @property {string} status
 * @property {IssueOccurrence[]} occurrences
 * @property {string} [signature]
 * @property {Escalation} [escalation]
 * @property {string} [resolvedAt]
 * @property {boolean} [unrendered]
 */

/**
 * The persisted issues index (state/.issues-index.json).
 * @typedef {Object} IssuesIndex
 * @property {number} version
 * @property {Record<string, IssueRecord>} signatures
 */

// ─── issue reports (deterministic skeletons) ───────────────────────────────

/** @returns {IssuesIndex} */
export function readIssuesIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ISSUES_INDEX_PATH, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.signatures &&
      typeof parsed.signatures === "object"
    ) {
      return parsed;
    }
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e?.code !== "ENOENT") {
      process.stderr.write(
        `[cron-job] issues index unreadable (${e?.message || e}); rebuilding from issues/ tree\n`,
      );
      return rebuildIssuesIndex();
    }
  }
  return { version: 1, signatures: {} };
}

// Best-effort recovery from a corrupt index: walk issues/**.md frontmatter
// for signature/version/status. Occurrence detail is not recoverable (the
// index owns it), but dedupe + status survive, which is what matters.
/** @returns {IssuesIndex} */
function rebuildIssuesIndex() {
  /** @type {IssuesIndex} */
  const idx = { version: 1, signatures: {} };
  /** @param {string} dir */
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

/** @param {IssuesIndex} idx */
function writeIssuesIndex(idx) {
  try {
    writeFileAtomic(ISSUES_INDEX_PATH, JSON.stringify(idx, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `[cron-job] failed to write issues index: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

// The .md report is a pure RENDER of index-held state: every write regenerates
// the whole file (no markdown parsing on the read side), then the WHOLE
// document passes redact() — these reports are meant to be copied upstream
// and must never carry a secret.
/** @param {IssueRecord} rec */
function renderIssueReport(rec) {
  const e = /** @type {Escalation} */ (rec.escalation);
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
      (e.reason === "recurring-bug"
        ? ` and the same error signature spans ${e.entityCount} distinct entities (likely a code bug)`
        : "") +
      ". Copy this report to the llm-wiki-memory issue tracker, or use it to draft a fix PR; an agent can deepen the analysis from the linked full logs on request.",
    "",
    "## Error excerpts (redacted)",
    ...(e.excerpts.length
      ? e.excerpts.map((x) => `- ${collapse(x)}`)
      : ["- (no excerpt captured)"]),
    "",
    "## Occurrences",
    ...rec.occurrences.map(
      (o) =>
        `- ${o.ts} — attempts=${o.attempts} entities=${o.entityCount} — ${o.logPath || "(no log)"}`,
    ),
    "",
    "## Affected entities",
    ...e.entityIds.map((id) => `- ${collapse(id)}`),
    "",
    "<!-- agent: deepen this analysis only on explicit user request; start from the logPaths above -->",
    "",
  ];
  return redact(lines.join("\n"));
}

/**
 * @param {Escalation[]} escalations
 * @param {EntityState} state
 * @param {Date} [now]
 */
export function writeIssueReports(escalations, state, now = new Date()) {
  const idx = readIssuesIndex();
  const ts = now.toISOString();
  /** @type {string[]} */
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
    rec.occurrences.push({
      ts,
      attempts: esc.attempts,
      entityCount: esc.entityCount,
      logPath: esc.logPaths.at(-1) || null,
    });
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
        `[cron-job] failed to write issue report ${rec.path}: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  // Resolution: an open episode whose signature no longer has ANY tracked
  // failing entity flips to resolved in place (file kept, never pruned).
  const liveSignatures = new Set(
    Object.values(state.entities || {})
      .map((e) => e.lastSignature)
      .filter(Boolean),
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
  return {
    touched,
    openCount: Object.values(idx.signatures).filter((r) => r.status === "open").length,
  };
}

export function openEscalationsFromIndex() {
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

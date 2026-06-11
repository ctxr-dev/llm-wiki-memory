// Self-observability captures — forensic records of anomalies an AGENT observes
// in llm-wiki-memory DURING interactive work. Distinct from the BACKGROUND cron
// self-healing path (compile/consolidate failures escalate to <data>/issues/…):
// this is the interactive layer. Captures live OUTSIDE the wiki, under
// <data>/monitoring/<yyyy>/<mm>/<dd>/, so they are gitignored, never indexed by
// search_memory, and NOT subject to the self_improvement write-gate.
//
// Two primitives are deliberately REUSED so a capture aligns with — rather than
// duplicates — the cron escalation system: redact() (the single sanctioned
// scrubber) and normalizeErrorSignature() (so an agent-observed anomaly dedupes
// to the SAME signature slug a cron escalation would mint, enabling a
// cross-reference without a shared writer).
import fs from "node:fs";
import path from "node:path";
import { MEMORY_DATA_DIR } from "./env.mjs";
import { redact } from "./redact.mjs";
import { normalizeErrorSignature } from "./error-signature.mjs";
import { dailyDatePath } from "./slug.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";

export const MONITORING_DIR = path.join(MEMORY_DATA_DIR, "monitoring");

export const SEVERITIES = ["suspicious", "likely-bug", "confirmed-bug"];

function rd(s) {
  return redact(String(s ?? "")).trim();
}

// Recursively list *.md capture files under MONITORING_DIR (newest path last).
function listCaptures(root = MONITORING_DIR) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(abs);
    }
  };
  walk(root);
  return out;
}

function readStatus(abs) {
  let txt;
  try {
    txt = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const m = txt.match(/^status:\s*([A-Za-z-]+)\s*$/m);
  return m ? m[1].toLowerCase() : "open"; // a capture with no status is treated as open
}

function sigFromName(abs) {
  // <signature>-<epochMs>.md  → strip the trailing -<digits>.md
  return path.basename(abs, ".md").replace(/-\d+$/, "");
}

function buildMarkdown(f) {
  const lines = [
    "---",
    "status: open",
    `severity: ${f.severity}`,
    `signature: ${f.signature}`,
    `observed: ${f.observedAt}`,
    f.surface ? `surface: ${rd(f.surface)}` : null,
    "---",
    "",
    `# ${rd(f.title)}`,
    "",
    `**Observed:** ${f.observedAt}`,
    `**Severity:** ${f.severity}`,
    f.surface ? `**Surface:** ${rd(f.surface)}` : null,
    f.cwd || f.branch ? `**Session:** ${rd(f.cwd)}${f.branch ? ` / ${rd(f.branch)}` : ""}` : null,
    "",
    "## What I observed",
    rd(f.observed) || rd(f.title),
    "",
    "## Evidence",
    rd(f.evidence) || "(none captured)",
    "",
    "## Suspected area in src/",
    (Array.isArray(f.suspectedFiles) ? f.suspectedFiles : [])
      .map((s) => `- ${rd(s)}`)
      .join("\n") || "(unknown)",
    "",
    "## Related",
    rd(f.related) || "none",
    "",
  ];
  return lines.filter((l) => l !== null).join("\n");
}

// Deep-redact every string value in a plain object (json sidecar).
function redactJson(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJson(v);
    return out;
  }
  return value;
}

// Write a forensic capture. The title is required; severity defaults to the
// floor the self-observability rule enforces (confirmed-bug). Every free-text
// field is redacted; the signature is derived from title+evidence so it matches
// the cron escalation vocabulary. Each observation is a NEW file (the trail
// accretes — never an upsert). Returns { ok, path, jsonPath, signature }.
export function writeMonitoringCapture({
  title,
  severity = "confirmed-bug",
  surface = "",
  observed = "",
  evidence = "",
  suspectedFiles = [],
  cwd = "",
  branch = "",
  related = "",
  json = null,
  now = new Date(),
} = {}) {
  const t = String(title ?? "").trim();
  if (!t) return { ok: false, error: "title-required" };
  const sev = SEVERITIES.includes(severity) ? severity : "confirmed-bug";
  // Signature from the TITLE only (no {pass,kind} prefix): a stable, clean dedupe
  // slug — two captures of the same bug group together, and an error CLASS named
  // in the title (e.g. LLMOutputInvalid) survives so it can match a cron signature.
  const signature = normalizeErrorSignature(t);
  const epochMs = now.getTime();
  const observedAt = now.toISOString();
  const dir = path.join(MONITORING_DIR, ...dailyDatePath(now).split("/"));
  const base = `${signature}-${epochMs}`;
  fs.mkdirSync(dir, { recursive: true });

  const mdPath = path.join(dir, `${base}.md`);
  writeFileAtomic(
    mdPath,
    buildMarkdown({ title: t, severity: sev, surface, observed, evidence, suspectedFiles, cwd, branch, related, signature, observedAt }),
  );

  let jsonPath = null;
  if (json && typeof json === "object") {
    jsonPath = path.join(dir, `${base}.json`);
    const safe = redactJson({ ...json, observedAt, epochMs, signature, severity: sev, status: "open" });
    writeFileAtomic(jsonPath, `${JSON.stringify(safe, null, 2)}\n`);
  }
  return { ok: true, path: mdPath, jsonPath, signature };
}

// Read-side health: count captures still `status: open`. summary is ONE line
// capped at 200 chars (mirrors cronHealth) so the SessionStart hook can surface
// it within the context budget.
export function monitoringHealth({ limit = 5 } = {}) {
  const open = listCaptures().filter((abs) => {
    const s = readStatus(abs);
    return s !== "triaged" && s !== "resolved";
  });
  const recent = open
    .slice(-limit)
    .map((abs) => ({ path: path.relative(MEMORY_DATA_DIR, abs), signature: sigFromName(abs) }));
  const sigs = [...new Set(recent.map((r) => r.signature))].slice(0, 3);
  const summary =
    open.length === 0
      ? "Monitoring: no unreviewed llm-wiki-memory anomalies."
      : `Monitoring: ${open.length} unreviewed llm-wiki-memory anomaly capture(s)${
          sigs.length ? ` (e.g. ${sigs.join(", ")})` : ""
        }; ask the user before triaging.`;
  return { healthy: open.length === 0, open: open.length, recent, summary: summary.slice(0, 200) };
}

// Flip a capture's status open → triaged after the user has reviewed it.
export function resolveCapture(fileRelOrAbs, status = "triaged") {
  const abs = path.isAbsolute(fileRelOrAbs) ? fileRelOrAbs : path.join(MEMORY_DATA_DIR, fileRelOrAbs);
  if (!fs.existsSync(abs)) return { ok: false, error: "not-found" };
  let txt = fs.readFileSync(abs, "utf8");
  if (/^status:\s*[A-Za-z-]+\s*$/m.test(txt)) {
    txt = txt.replace(/^status:\s*[A-Za-z-]+\s*$/m, `status: ${status}`);
  } else {
    return { ok: false, error: "no-status-field" };
  }
  writeFileAtomic(abs, txt);
  return { ok: true, path: abs, status };
}

// OPTIONAL cross-reference: if an open cron escalation shares this signature,
// return a one-line pointer for the capture's `Related` section. Lazy-imports
// cron-job so the capture hot path never pulls that module's graph. Best-effort:
// any failure yields "" (the capture still writes with Related: none).
export async function relatedEscalation(signature) {
  if (!signature) return "";
  try {
    const { cronHealth } = await import("../cron-job.mjs");
    const h = cronHealth({ limit: 0 });
    const hit = (h.escalations || []).find((e) => e && e.signature === signature);
    return hit ? `matches open cron escalation ${signature} at ${hit.path || "(see cron-health)"}` : "";
  } catch {
    return "";
  }
}

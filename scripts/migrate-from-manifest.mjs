#!/usr/bin/env node
// Apply a Phase-D-style migration manifest to the live wiki.
//
// Reads a dry-run-manifest.json (the schema produced by the Phase D
// inventory builder), then for every non-skip entry:
//   - reads the source file (or, when the source ends with `#<heading>`,
//     extracts that `## <heading>` H2 section's slice)
//   - derives metadata (area / atom_type / task_type / issue_key / status)
//     from the manifest entry + path segments
//   - calls saveDocument({ ..., placementOverride: <dir> }) — the SAME
//     function the `save_to_dataset` MCP tool wraps — so sha256, embedding,
//     index rebuild, and frontmatter normalisation all fire identically
//     to a normal MCP write.
//
// Usage:
//   node scripts/migrate-from-manifest.mjs <manifest.json> [--dry-run]
//
// Exit codes: 0 = all ok, 2 = at least one failure.

import fs from "node:fs";
import matter from "gray-matter";
import { saveDocument, normalizeLeafNamePreservingCase } from "./lib/wiki-store.mjs";

/** @typedef {import("./lib/types.mjs").WriteResult} WriteResult */

/**
 * A single non-skip row of the Phase-D dry-run manifest consumed here.
 * @typedef {Object} ManifestEntry
 * @property {string} classification - a CLASS_TO_DATASET key (or "skip", filtered out).
 * @property {string} target - wiki-relative target path (with a leading "wiki/").
 * @property {string} source - source file path, optionally suffixed with "#<heading>".
 * @property {string} [area]
 * @property {string} [issue_key]
 */

/**
 * The plan-only outcome returned by migrateEntry / reported when --dry-run.
 * @typedef {Object} DryRunResult
 * @property {true} dryRun
 * @property {string} datasetId
 * @property {string} dir
 * @property {string} name
 * @property {Record<string, unknown>} metadata
 * @property {number} bodyBytes
 * @property {boolean} [ok]
 */

/**
 * Per-entry record accumulated by migrateManifest and passed to onEntry.
 * @typedef {Object} EntryResult
 * @property {ManifestEntry} entry
 * @property {DryRunResult | WriteResult} [result]
 * @property {string} [error]
 * @property {boolean} ok
 */

/** @type {Record<string, string>} */
const CLASS_TO_DATASET = {
  knowledge: "knowledge",
  "issue-knowledge": "knowledge",
  lesson: "self_improvement",
  plan: "plans",
  investigation: "investigations",
  daily: "daily",
};

const LIFECYCLE_SEGMENTS = new Set(["pending", "in-progress", "done", "archived"]);

// Read the body of a section by `## heading` title from a markdown file.
// Headings are matched after stripping the leading `## ` (trimmed). The
// section ends at the next `## ` or EOF. Throws on a missing heading
// so the caller can record a per-entry failure rather than silently
// migrating a wrong slice.
/**
 * @param {string} filePath
 * @param {string} heading
 * @returns {{ body: string, data: Record<string, unknown> }}
 */
function extractSection(filePath, heading) {
  const raw = fs.readFileSync(filePath, "utf8");
  const fm = matter(raw);
  const lines = fm.content.split("\n");
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*)$/);
    if (m && m[1].trim() === heading.trim()) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) {
    throw new Error(`section heading '## ${heading}' not found in ${filePath}`);
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { body: lines.slice(startIdx, endIdx).join("\n").trim(), data: fm.data };
}

/**
 * @param {string} source
 * @returns {{ body: string, data: Record<string, unknown> }}
 */
function readSource(source) {
  const hashIdx = source.indexOf("#");
  if (hashIdx >= 0) {
    return extractSection(source.slice(0, hashIdx), source.slice(hashIdx + 1));
  }
  const raw = fs.readFileSync(source, "utf8");
  const fm = matter(raw);
  return { body: fm.content.trim(), data: fm.data || {} };
}

/**
 * @param {ManifestEntry} entry
 * @param {Record<string, unknown>} fmData
 * @param {string} targetRelToWiki
 * @returns {Record<string, unknown>}
 */
function deriveMetadata(entry, fmData, targetRelToWiki) {
  // targetRelToWiki is the path relative to the wiki root, e.g.
  //   "knowledge/meta/rule/bot-review-verification.md"
  //   "self_improvement/scala-toolkit/testing/read-model-sources-before-tests.md"
  //   "issues/JIRA/DEV/122/64/8/pending/DEV-122648-apisix-access-log-redaction.plan.md"
  // We strip the category prefix and the filename to get the subdir parts.
  const md = { ...(fmData || {}) };
  if (entry.area && !md.area) md.area = entry.area;
  if (entry.issue_key && !md.issue_key) md.issue_key = entry.issue_key;

  const parts = targetRelToWiki.split("/").filter(Boolean);
  parts.pop(); // drop filename

  switch (entry.classification) {
    case "knowledge":
    case "issue-knowledge": {
      // wiki/knowledge/<area>/<atom_type>/...
      const idx = parts.indexOf("knowledge");
      if (idx >= 0 && parts.length > idx + 2 && !md.atom_type) {
        md.atom_type = parts[idx + 2];
      }
      break;
    }
    case "lesson": {
      // wiki/self_improvement/<area>/<task_type>/...
      const idx = parts.indexOf("self_improvement");
      if (idx >= 0 && parts.length > idx + 2 && !md.task_type) {
        md.task_type = parts[idx + 2];
      }
      break;
    }
    case "plan": {
      // For Jira-tree plans: .../issues/JIRA/<PREFIX>/<a>/<b>/<c>/<lifecycle>/<file>
      // For non-Jira plans (e.g. plans/llm-wiki-memory/...): no lifecycle.
      const lifecycle = parts.find((p) => LIFECYCLE_SEGMENTS.has(p));
      if (lifecycle && !md.status) md.status = lifecycle;
      break;
    }
    case "daily":
    case "investigation":
    default:
      break;
  }
  return md;
}

/**
 * @param {ManifestEntry} entry
 * @returns {{ dir: string, filename: string, targetRel: string }}
 */
function planTarget(entry) {
  // Strip the leading "wiki/" prefix; saveDocument's placementOverride is
  // wiki-relative. Returns { dir, filename }.
  const targetRel = entry.target.replace(/^wiki\//, "");
  const lastSlash = targetRel.lastIndexOf("/");
  if (lastSlash < 0) {
    // A target must include a category dir + filename (e.g. "knowledge/x.md").
    // A slash-less target would otherwise yield dir="" and write at the wiki
    // root — refuse rather than place a leaf where no category owns it.
    throw new Error(
      `manifest target '${entry.target}' has no directory segment (expected "<category>/.../<file>.md")`,
    );
  }
  return {
    dir: targetRel.slice(0, lastSlash),
    filename: targetRel.slice(lastSlash + 1),
    targetRel,
  };
}

/**
 * @param {ManifestEntry} entry
 * @param {{ dryRun?: boolean }} [options]
 * @returns {Promise<DryRunResult | WriteResult>}
 */
export async function migrateEntry(entry, { dryRun = false } = {}) {
  const datasetId = CLASS_TO_DATASET[entry.classification];
  if (!datasetId) {
    throw new Error(`no dataset mapping for classification '${entry.classification}'`);
  }
  const { dir, filename, targetRel } = planTarget(entry);
  const { body, data } = readSource(entry.source);
  const metadata = deriveMetadata(entry, data, targetRel);

  if (dryRun) {
    return { dryRun: true, datasetId, dir, name: filename, metadata, bodyBytes: body.length };
  }
  return /** @type {WriteResult} */ (
    saveDocument({
      name: filename,
      text: body,
      datasetId,
      metadata,
      placementOverride: dir,
    })
  );
}

/**
 * @param {string} manifestPath
 * @param {{ dryRun?: boolean, onEntry?: (result: EntryResult) => void }} [options]
 * @returns {Promise<{ total: number, ok: number, fail: number, results: EntryResult[] }>}
 */
export async function migrateManifest(manifestPath, { dryRun = false, onEntry } = {}) {
  const m = /** @type {{ entries: ManifestEntry[] }} */ (
    JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  );
  const entries = m.entries.filter((e) => e.classification !== "skip");
  /** @type {EntryResult[]} */
  const results = [];
  /** @type {Map<string, string>} */
  const seenTargets = new Map(); // "dir/filename" -> source (collision guard)
  let ok = 0;
  let fail = 0;
  for (const e of entries) {
    /** @type {EntryResult} */
    let entryResult;
    try {
      // Two non-skip entries that compute the SAME target leaf would silently
      // overwrite each other — detect and fail the second rather than clobber.
      // Key on the NORMALISED filename (what saveDocument actually writes; it
      // lowercases the .md extension), so "X.MD" and "X.md" collide as they will
      // on disk.
      const { dir, filename } = planTarget(e);
      const key = `${dir}/${normalizeLeafNamePreservingCase(filename).name}`;
      if (seenTargets.has(key)) {
        throw new Error(`target collision: '${key}' already claimed by '${seenTargets.get(key)}'`);
      }
      seenTargets.set(key, e.source);

      const r = await migrateEntry(e, { dryRun });
      const success = r && r.ok !== false;
      entryResult = { entry: e, result: r, ok: success };
      if (success) ok++;
      else fail++;
    } catch (err) {
      entryResult = { entry: e, error: /** @type {Error} */ (err).message, ok: false };
      fail++;
    }
    results.push(entryResult);
    if (onEntry) onEntry(entryResult);
  }
  return { total: entries.length, ok, fail, results };
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  if (!manifestPath) {
    process.stderr.write("usage: migrate-from-manifest.mjs <manifest.json> [--dry-run]\n");
    process.exit(64);
  }
  const summary = await migrateManifest(manifestPath, {
    dryRun,
    onEntry: ({ entry, result, error, ok }) => {
      const tag = ok ? "OK  " : "FAIL";
      const why = ok
        ? ""
        : ` — ${error || (result && /** @type {{ reason?: string }} */ (result).reason) || "unknown"}`;
      process.stdout.write(`${tag} ${entry.classification.padEnd(18)} ${entry.target}${why}\n`);
    },
  });
  process.stdout.write(
    `\n${summary.ok}/${summary.total} ok, ${summary.fail} failed${dryRun ? " (dry-run)" : ""}\n`,
  );
  process.exit(summary.fail === 0 ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

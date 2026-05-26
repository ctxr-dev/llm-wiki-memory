#!/usr/bin/env node
// Apply a Phase-D-style migration manifest to the live wiki.
//
// Reads a dry-run-manifest.json (the schema produced by the Phase D
// inventory builder), then for every non-skip entry:
//   - reads the source file (or extracts a `#section heading` slice)
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
import path from "node:path";
import matter from "gray-matter";
import { saveDocument } from "./lib/wiki-store.mjs";

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

function readSource(source) {
  const hashIdx = source.indexOf("#");
  if (hashIdx >= 0) {
    return extractSection(source.slice(0, hashIdx), source.slice(hashIdx + 1));
  }
  const raw = fs.readFileSync(source, "utf8");
  const fm = matter(raw);
  return { body: fm.content.trim(), data: fm.data || {} };
}

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

function planTarget(entry) {
  // Strip the leading "wiki/" prefix; saveDocument's placementOverride is
  // wiki-relative. Returns { dir, filename }.
  const targetRel = entry.target.replace(/^wiki\//, "");
  const lastSlash = targetRel.lastIndexOf("/");
  return {
    dir: targetRel.slice(0, lastSlash),
    filename: targetRel.slice(lastSlash + 1),
    targetRel,
  };
}

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
  return saveDocument({
    name: filename,
    text: body,
    datasetId,
    metadata,
    placementOverride: dir,
  });
}

export async function migrateManifest(manifestPath, { dryRun = false, onEntry } = {}) {
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = m.entries.filter((e) => e.classification !== "skip");
  const results = [];
  let ok = 0;
  let fail = 0;
  for (const e of entries) {
    let entryResult;
    try {
      const r = await migrateEntry(e, { dryRun });
      const success = r && r.ok !== false;
      entryResult = { entry: e, result: r, ok: success };
      if (success) ok++;
      else fail++;
    } catch (err) {
      entryResult = { entry: e, error: err.message, ok: false };
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
      const why = ok ? "" : ` — ${error || (result && result.reason) || "unknown"}`;
      process.stdout.write(`${tag} ${entry.classification.padEnd(18)} ${entry.target}${why}\n`);
    },
  });
  process.stdout.write(`\n${summary.ok}/${summary.total} ok, ${summary.fail} failed${dryRun ? " (dry-run)" : ""}\n`);
  process.exit(summary.fail === 0 ? 0 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

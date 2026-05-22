#!/usr/bin/env node
// Merge a top-level key from a template JSON into a target JSON file,
// creating the target if absent. Used by bootstrap.sh to add our hooks to
// .claude/settings.json and our server to .mcp.json without clobbering the
// user's existing config.
//
//   node merge-config.mjs <targetFile> <templateFile> <topKey>
import fs from "node:fs";

const [targetFile, templateFile, topKey] = process.argv.slice(2);
if (!targetFile || !templateFile || !topKey) {
  console.error("usage: merge-config.mjs <targetFile> <templateFile> <topKey>");
  process.exit(1);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const target = readJson(targetFile, {});
const template = readJson(templateFile, {});
const incoming = template[topKey] || {};

target[topKey] = target[topKey] && typeof target[topKey] === "object" ? target[topKey] : {};
// Shallow-merge per server / per hook-event: our keys win, the user's other
// keys are preserved. We do NOT deep-merge hook arrays - a same-named event
// is replaced wholesale by ours (idempotent re-runs stay stable).
for (const [k, v] of Object.entries(incoming)) {
  target[topKey][k] = v;
}

fs.mkdirSync(targetFile.replace(/\/[^/]*$/, "") || ".", { recursive: true });
fs.writeFileSync(targetFile, `${JSON.stringify(target, null, 2)}\n`);
console.error(`merged ${topKey} into ${targetFile}`);

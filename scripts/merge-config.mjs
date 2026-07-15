#!/usr/bin/env node
// Merge a top-level key from a template JSON into a target JSON file,
// creating the target if absent. Used by bootstrap.sh to add our hooks to
// ~/.claude/settings.json and our server to the user-global MCP configs
// without clobbering the user's existing config.
//
//   node merge-config.mjs <targetFile> <templateFile> <topKey>
import { readJsonOrThrow, mergeIntoJsonFile } from "./lib/config-merge.mjs";

const [targetFile, templateFile, topKey] = process.argv.slice(2);
if (!targetFile || !templateFile || !topKey) {
  console.error("usage: merge-config.mjs <targetFile> <templateFile> <topKey>");
  process.exit(1);
}

// The template ships in the package; a parse failure is a packaging bug, so
// let it surface rather than silently merging nothing.
const templateRead = readJsonOrThrow(templateFile);
const template = /** @type {Record<string, unknown>} */ (templateRead ? templateRead.value : {});
const incoming = /** @type {Record<string, unknown>} */ (template[topKey] || {});

mergeIntoJsonFile(targetFile, incoming, topKey);
console.error(`merged ${topKey} into ${targetFile}`);

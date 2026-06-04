#!/usr/bin/env node
// Upsert a marker-fenced block into a text file, creating the file if absent.
// On re-run the content between the markers is replaced (never appended twice),
// so bootstrap.sh stays idempotent.
//
//   node merge-marker.mjs <file> <beginMarker> <endMarker> [contentFile]
//
// If <contentFile> is omitted or "-", the block content is read from stdin.
import fs from "node:fs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";

const [file, beginMarker, endMarker, contentFile] = process.argv.slice(2);
if (!file || !beginMarker || !endMarker) {
  console.error("usage: merge-marker.mjs <file> <beginMarker> <endMarker> [contentFile]");
  process.exit(1);
}

function readContent() {
  if (contentFile && contentFile !== "-") {
    return fs.readFileSync(contentFile, "utf8");
  }
  return fs.readFileSync(0, "utf8");
}

const inner = readContent().replace(/\s+$/, "");
const block = `${beginMarker}\n${inner}\n${endMarker}`;

let existing = "";
try {
  existing = fs.readFileSync(file, "utf8");
} catch {
  existing = "";
}

// Escape the markers for use in a RegExp (they contain HTML-comment chars).
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const fence = new RegExp(`${escapeRe(beginMarker)}[\\s\\S]*?${escapeRe(endMarker)}`);

let next;
if (fence.test(existing)) {
  next = existing.replace(fence, block);
} else if (existing.trim() === "") {
  next = `${block}\n`;
} else {
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  next = `${existing}${sep}${block}\n`;
}

fs.mkdirSync(file.replace(/\/[^/]*$/, "") || ".", { recursive: true });
writeFileAtomic(file, next);
console.error(`upserted block into ${file}`);

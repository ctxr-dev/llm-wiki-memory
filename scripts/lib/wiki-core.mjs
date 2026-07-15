import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { wikiRoot } from "./env.mjs";

/** @typedef {import("./types.mjs").LeafFrontmatter} LeafFrontmatter */
/** @typedef {import("./types.mjs").MemoryMetadata} MemoryMetadata */

// Drop-in replacement for the boilerplate's dify-write.mjs. Same exported
// function names/shapes, but every document is a leaf in the local hosted
// wiki and retrieval is local embeddings. Downstream code (flush, compile,
// exit-plan-mode, the MCP server) calls only these functions.

export class WikiStoreUnavailable extends Error {}

export function root() {
  return wikiRoot();
}

/**
 * @param {string} absPath
 * @returns {{ data: LeafFrontmatter, body: string }}
 */
export function readLeaf(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  const parsed = matter(raw);
  return { data: /** @type {LeafFrontmatter} */ (parsed.data || {}), body: parsed.content || "" };
}

/**
 * @param {{ memory?: unknown } | null | undefined} data
 * @returns {MemoryMetadata}
 */
export function leafMemory(data) {
  return /** @type {MemoryMetadata} */ (
    (data && typeof data.memory === "object" && data.memory) || {}
  );
}

/**
 * @param {{ memory?: unknown } | null | undefined} data
 * @returns {boolean}
 */
export function isActive(data) {
  const status = leafMemory(data).status;
  return status !== "archived";
}

/**
 * @param {LeafFrontmatter | null | undefined} data
 * @param {MemoryMetadata} mem
 * @returns {string[]}
 */
function leafTags(data, mem) {
  const raw = [
    ...(data && Array.isArray(data.tags) ? data.tags : []),
    ...String(mem.tags || "").split(","),
  ];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const t of raw) {
    const s = String(t).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

// The text we EMBED for a leaf: a curated `title · tags · subject` header
// (the semantically useful frontmatter) prepended to the body. Ids, timestamps,
// source hashes, parents and cover boilerplate are deliberately excluded. The
// consolidate cluster probe embeds a leaf AS its query, so it uses this too —
// both sides see the same shape; the user's free-text query does NOT.
/**
 * @param {LeafFrontmatter | null | undefined} data
 * @param {string} body
 * @returns {string}
 */
export function embedTextForLeaf(data, body) {
  const mem = leafMemory(data);
  /** @type {string[]} */
  const parts = [];
  const title = String((data && data.focus) || "")
    .replace(/\s+/g, " ")
    .trim();
  if (title) parts.push(title);
  const tags = leafTags(data, mem);
  if (tags.length) parts.push(tags.join(", "));
  const subject = Array.isArray(mem.subject)
    ? mem.subject.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (subject.length) parts.push(subject.join(" / "));
  const header = parts.join(" · ");
  const text = String(body || "");
  return header ? `${header}\n\n${text}` : text;
}

// Recursively collect leaf files (not index.md) under a directory. Entries
// are sorted lex-ascending so two runs over the same tree iterate in
// identical order regardless of filesystem (APFS preserves insertion order,
// ext4/btrfs don't). The consolidate orchestrator's determinism contract
// relies on this for byte-identical state across re-runs.
/**
 * @param {string} dirAbs
 * @returns {string[]}
 */
export function walkLeaves(dirAbs) {
  /** @type {string[]} */
  const out = [];
  if (!fs.existsSync(dirAbs)) return out;
  const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkLeaves(abs));
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md") {
      out.push(abs);
    }
  }
  return out;
}

/**
 * @param {string} categoryAbs
 * @param {string} name
 * @returns {string | null}
 */
export function findByName(categoryAbs, name) {
  for (const leaf of walkLeaves(categoryAbs)) {
    if (path.basename(leaf) === name) return leaf;
  }
  return null;
}

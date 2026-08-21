import fs from "node:fs";
import path from "node:path";
import { splitLeafFrontmatter } from "./leaf-frontmatter.mjs";

// doctor's existing brokenRefs detector covers index.md navigation links. It does
// NOT look at the canonical `brain:<id>` cross-references inside leaf BODIES, so a
// leaf that relocates (a facet change moves it and changes its documentId) leaves
// every inbound body reference dangling while doctor still reports a clean wiki.
// This scan closes that blind spot, and separately reports labels that have drifted
// from the title they name — a link whose label came from the target's own `focus:`
// keeps resolving after the target is retitled, so nothing else would notice.

// `daily` is the raw pre-distill capture layer and `absorb` imports verbatim; both
// are EXEMPT from the reference rules, so an example ref written in a daily note is
// not a defect and must not be reported.
const SKIP_DIRS = new Set(["node_modules", "index", ".git"]);
const EXEMPT_CATEGORIES = new Set(["daily", "absorb"]);
const FENCED = /```[\s\S]*?```/g;
const BRAIN_REF = /brain:([A-Za-z0-9._/-]+\.md)/g;
const LABELLED_REF = /\[([^\]\n]+)\]\(brain:([A-Za-z0-9._/-]+\.md)\)/g;
const FOCUS = /^focus:\s*'?"?(.+?)'?"?$/m;

/** @param {string} dir @returns {string[]} */
function leafFiles(dir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} current */
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.name.endsWith(".md") && entry.name !== "index.md") {
        found.push(abs);
      }
    }
  };
  walk(dir);
  return found;
}

/** @param {string} wikiRoot @param {string} docId @returns {string | undefined} */
function titleOf(wikiRoot, docId) {
  try {
    const raw = fs.readFileSync(path.join(wikiRoot, docId), "utf8");
    return FOCUS.exec(raw)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{ leaf: string, broken: string[] }} BrokenBodyRefEntry
 * @typedef {{ leaf: string, ref: string, label: string, title: string }} LabelDriftEntry
 */

// Fenced code is literal by contract, so a document demonstrating the id scheme
// inside a fence is not a reference and must not be reported.
/**
 * @param {string} wikiRoot
 * @returns {{ brokenBodyRefs: BrokenBodyRefEntry[], labelDrift: LabelDriftEntry[] }}
 */
export function scanBodyReferences(wikiRoot) {
  /** @type {BrokenBodyRefEntry[]} */
  const brokenBodyRefs = [];
  /** @type {LabelDriftEntry[]} */
  const labelDrift = [];
  for (const abs of leafFiles(wikiRoot)) {
    const leaf = path.relative(wikiRoot, abs).split(path.sep).join("/");
    if (EXEMPT_CATEGORIES.has(leaf.split("/")[0])) continue;
    let raw;
    try {
      raw = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const body = splitLeafFrontmatter(raw).body.replace(FENCED, "");

    const broken = [...new Set([...body.matchAll(BRAIN_REF)].map((m) => m[1]))].filter(
      (docId) => !fs.existsSync(path.join(wikiRoot, docId)),
    );
    if (broken.length > 0) brokenBodyRefs.push({ leaf, broken });

    for (const [, label, docId] of body.matchAll(LABELLED_REF)) {
      const title = titleOf(wikiRoot, docId);
      if (!title) continue;
      const shown = label.replace(/[`*_]/g, "").trim();
      if (shown.length === 0) continue;
      // Compare on letters and digits only: a label that differs from its title
      // solely by case, punctuation or a trailing word is the same label, and
      // reporting it would bury the real paraphrases in noise.
      const fold = (/** @type {string} */ v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (fold(title).includes(fold(shown)) || fold(shown).includes(fold(title))) continue;
      // A label may be a shortened form of the title (a long title cut at a clause
      // boundary), and an entity name may be a fragment of it. Only an outright
      // mismatch in both directions is drift.
      labelDrift.push({ leaf, ref: docId, label: shown, title });
    }
  }
  return { brokenBodyRefs, labelDrift };
}

import matter from "gray-matter";
import { truncateAtWordBoundary } from "./slug.mjs";
import { buildBrief } from "./brief.mjs";
import { contentHash } from "./embed.mjs";

/** @typedef {import("./types.mjs").MemoryMetadata} MemoryMetadata */
/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("./types.mjs").LeafFrontmatter} LeafFrontmatter */
/** @typedef {import("./types.mjs").GlanceFields} GlanceFields */

// Pull a human title from explicit metadata, a leading `# heading`, or the name.
/**
 * @param {{ metadata?: MetadataInput, text?: string, name?: string }} args
 * @returns {string}
 */
export function deriveTitle({ metadata, text, name }) {
  if (metadata && metadata.title) return String(metadata.title).trim();
  const h1 = String(text || "").match(/^#\s+(.+?)\s*$/m);
  // A separator-only ATX heading (`# ===…`, `# ---`, `# ***`) is decoration, not a
  // title — fall through to the basename so the leaf isn't named "===" / "---".
  if (h1 && !/^[=\-_*#>~\s]+$/.test(h1[1])) return h1[1].trim();
  return truncateAtWordBoundary(
    String(name || "untitled")
      .replace(/\.md$/, "")
      .replace(/[-_]/g, " "),
    80,
  );
}

/**
 * @param {unknown} s
 * @param {number} [max]
 * @returns {string}
 */
function oneLine(s, max = 160) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Build the >=3-bullet covers[] the validator requires on leaves. Covers are
// mined from the actual content (title, the structured Why:/How to apply: lines
// the capture prompt encourages, a representative body sentence, and tags) rather
// than boilerplate, so they carry real signal for shared_covers + browsing.
/**
 * @param {{ title?: string, tags?: string[], atomType?: string, body?: string }} args
 * @returns {string[]}
 */
function buildCovers({ title, tags, atomType, body }) {
  /** @type {string[]} */
  const out = [];
  if (title) out.push(oneLine(title, 120));
  const text = String(body || "");
  const why = text.match(/^\s*(?:[-*]\s*)?why\s*:\s*(.+)$/im);
  if (why) out.push(oneLine(`why: ${why[1]}`, 140));
  const how = text.match(/^\s*(?:[-*]\s*)?how\s*to\s*apply\s*:\s*(.+)$/im);
  if (how) out.push(oneLine(`how to apply: ${how[1]}`, 140));
  // First prose sentence that is not a heading or a "- key: value" metadata line.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^[-*]\s*\w[\w-]*\s*:/.test(line)) continue;
    if (/^(why|how to apply)\s*:/i.test(line)) continue;
    out.push(oneLine(line, 140));
    break;
  }
  for (const t of tags || []) out.push(oneLine(`covers ${t}`, 60));
  const seen = new Set();
  const deduped = out.filter((c) => c && !seen.has(c) && seen.add(c));
  // Floor: the validator requires >= 3 covers. Pad with deterministic, unique fillers.
  while (deduped.length < 3) {
    deduped.push(oneLine(`recall context for ${atomType || "memory"} (${deduped.length + 1})`, 80));
  }
  return deduped.slice(0, 15);
}

// gray-matter serialises frontmatter via js-yaml, whose default lineWidth (80)
// folds long scalars into block scalars (`>-`). skill-llm-wiki's index/validate
// parser reads frontmatter line-by-line; folded scalars made it drop the doc
// from its index. lineWidth -1 disables wrapping so scalars stay single-line.
/**
 * @param {string} body
 * @param {object} data
 * @returns {string}
 */
export function stringifyLeaf(body, data) {
  // `lineWidth` is a js-yaml passthrough option gray-matter forwards to its YAML
  // engine; gray-matter's typings do not model js-yaml options, so cast the
  // options bag to the declared option type (via an unknown-keyed record) to
  // satisfy the compiler without altering the value passed at runtime.
  /** @type {Record<string, unknown>} */
  const yamlOptions = { lineWidth: -1 };
  return matter.stringify(
    `\n${body.trim()}\n`,
    data,
    /** @type {import("gray-matter").GrayMatterOption<string, never>} */ (yamlOptions),
  );
}

// Compose the on-disk leaf (schema-valid frontmatter + body). `memory` carries
// our filterable metadata; the rest satisfies skill-llm-wiki's leaf schema.
/**
 * @param {{ id: string, title: string, tags: string[], body: string, memoryMeta: MemoryMetadata }} args
 * @returns {string}
 */
export function renderLeaf({ id, title, tags, body, memoryMeta }) {
  /** @type {Record<string, unknown>} */
  const frontmatter = {
    id,
    type: "primary",
    depth_role: "leaf",
    focus: oneLine(title) || oneLine(id) || "memory entry",
    parents: ["index.md"],
    covers: buildCovers({ title, tags, atomType: memoryMeta.atom_type, body }),
  };
  const brief = buildBrief({ body, memoryMeta });
  if (brief) frontmatter.brief = brief;
  if (Array.isArray(tags) && tags.length) frontmatter.tags = tags;
  frontmatter.source = { origin: "inline", hash: `sha256:${contentHash(body)}` };
  frontmatter.updated = new Date().toISOString().slice(0, 10);
  frontmatter.memory = memoryMeta;
  return stringifyLeaf(body, frontmatter);
}

// The compact "glance" fields for a leaf, used only when a caller opts in via
// `withGlance` (the `sections:["frontmatter"]` read path). `brief` prefers the
// stored frontmatter value and falls back to computing it on the fly for older
// leaves that predate the field. `status`/`progress` are top-level plan fields
// (absent on non-plan atoms). Never returns the raw internal frontmatter.
/**
 * @param {Partial<LeafFrontmatter>} [data]
 * @param {Partial<MemoryMetadata>} [mem]
 * @param {string} [body]
 * @returns {GlanceFields}
 */
export function glanceFields(data = {}, mem = {}, body = "") {
  /** @type {GlanceFields} */
  const out = {
    brief: data.brief || buildBrief({ body, memoryMeta: /** @type {MemoryMetadata} */ (mem) }),
  };
  if (mem.atom_type) out.type = mem.atom_type;
  if (data.status) out.status = data.status;
  if (data.progress) out.progress = data.progress;
  const tags = Array.isArray(data.tags)
    ? data.tags
    : mem.tags
      ? String(mem.tags)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
  if (tags.length) out.tags = tags;
  return out;
}

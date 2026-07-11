import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR } from "./lib/env.mjs";
import { atomBodyMaxChars } from "./lib/settings.mjs";
import { collectFacetVocab, renderVocabVars } from "./lib/facet-vocab.mjs";
import { ATOM_TYPES } from "./lib/datasets.mjs";

/** @typedef {import("./lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./lib/types.mjs").MetadataInput} MetadataInput */

/**
 * @param {string} text
 * @returns {DistilledAtom[]}
 */
export function parseAtomsFromMarkdown(text) {
  /** @type {DistilledAtom[]} */
  const atoms = [];
  const blocks = text.split(/\n(?=### Atom )/);
  for (const block of blocks) {
    if (!block.startsWith("### Atom")) continue;
    const lines = block.split(/\r?\n/);
    let type,
      title,
      /** @type {string[]} */ tags = [],
      body = "",
      evidence;
    let metadata = /** @type {MetadataInput} */ ({});
    let inBody = false;
    for (const line of lines) {
      if (inBody) {
        if (line.startsWith("    ")) {
          body += (body ? "\n" : "") + line.slice(4);
          continue;
        }
        if (line.trim() === "" || line.startsWith("- ")) {
          inBody = false;
        } else {
          continue;
        }
      }
      const m = line.match(/^- (\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, rest] = m;
      switch (key) {
        case "type":
          type = rest.trim();
          break;
        case "title":
          title = rest.trim();
          break;
        case "tags": {
          const inner = rest.trim().replace(/^\[|\]$/g, "");
          tags = inner
            ? inner
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean)
            : [];
          break;
        }
        case "metadata": {
          try {
            const parsed = JSON.parse(rest.trim());
            metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          } catch {
            metadata = {};
          }
          break;
        }
        case "body":
          if (rest.trim() === "|") inBody = true;
          else body = rest.trim();
          break;
        case "evidence": {
          // flush.mjs always JSON.stringifies the evidence string, so a
          // valid daily produces a JSON-encoded one-liner here (newlines
          // and embedded quotes are escape-encoded). Hand-edited dailies
          // may carry a raw string, so fall back to the trimmed literal
          // on parse failure. Guard the unusual case where parse succeeds
          // but yields a non-string (e.g. evidence: null) - coerce.
          const raw = rest.trim();
          try {
            const parsed = JSON.parse(raw);
            evidence = typeof parsed === "string" ? parsed : raw;
          } catch {
            evidence = raw;
          }
          break;
        }
        default:
          break;
      }
    }
    if (!type || !title || !body) continue;
    // Re-validate atom type against the central registry. A daily doc
    // produced by an older flush.mjs (or hand-edited) might carry a
    // typo'd type; promoting it would route to the wrong dataset.
    if (!ATOM_TYPES.has(type)) {
      console.error(
        `compile.mjs: skipping atom with unknown type '${type}' (title='${title.slice(0, 40)}')`,
      );
      continue;
    }
    atoms.push({ type, title, body, tags, metadata, evidence });
  }
  return atoms;
}

function loadPrompt() {
  const cap = atomBodyMaxChars();
  const vocab = renderVocabVars(collectFacetVocab());
  return fs
    .readFileSync(path.join(PROMPTS_DIR, "compile.md"), "utf8")
    .replace(/\{\{ATOM_BODY_MAX_CHARS\}\}/g, String(cap))
    .replace(/\{\{KNOWN_AREAS\}\}/g, vocab.KNOWN_AREAS)
    .replace(/\{\{KNOWN_ERROR_PATTERNS\}\}/g, vocab.KNOWN_ERROR_PATTERNS);
}
export { loadPrompt };
export const __loadPromptForTest = loadPrompt;

// Heuristic quality rubric for `create` actions. Cheap (no LLM, just
// inspections) signals that an atom is high-signal-density and worth
// persisting. Returns { ok: boolean, reasons: string[] }. Reasons are
// human-readable strings safe to log. Used by compile.mjs when
// settings.compile.qualityStrict is true to drop low-signal atoms before
// they pollute retrieval. Default lax mode (qualityStrict false) only
// surfaces the verdict for forensics; the atom is still promoted.
//
// Rubric (every rule must pass):
// 1. `body` length >= 80 chars - under that, the atom is usually a
//    one-liner that adds no context beyond the title.
// 2. At least one tag - recall surfaces atoms via tags and content; an
//    untagged atom only matches on the title/body embedding.
// 3. `evidence` present OR body contains a "Why:" or "How to apply:"
//    line - structured atoms ("Why" + "How to apply") are the
//    documented format in prompts/flush.md; an unstructured wall of
//    text is usually narrative leaking through.
// 4. For `self-improvement-lesson` and `bug-root-cause`:
//    `metadata.area` (the sub-module) is set - these atoms are the most
//    metadata-dependent in retrieval (recall scopes by area; project_module
//    is the workspace, stamped automatically). An atom without an area is not
//    facet-placed or area-scopable. (Legacy atoms' project_module is accepted
//    as the area fallback.)
/**
 * @param {DistilledAtom} atom
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function scoreAtomQuality(atom) {
  const reasons = [];
  const body = String(atom?.body || "");
  if (body.length < 80) reasons.push("body too short (<80 chars)");
  const tags = Array.isArray(atom?.tags) ? atom.tags.filter(Boolean) : [];
  if (tags.length === 0) reasons.push("no tags");
  const hasEvidence = Boolean(String(atom?.evidence || "").trim());
  const hasWhyOrHowTo = /(^|\n)\s*(why|how to apply)\s*:/i.test(body);
  if (!hasEvidence && !hasWhyOrHowTo)
    reasons.push("no evidence and no 'Why:' / 'How to apply:' lines");
  const metadataDependentTypes = new Set(["self-improvement-lesson", "bug-root-cause"]);
  if (
    metadataDependentTypes.has(atom?.type) &&
    !(atom?.metadata?.area || atom?.metadata?.project_module)
  ) {
    reasons.push(`type='${atom.type}' requires metadata.area (or legacy project_module)`);
  }
  return { ok: reasons.length === 0, reasons };
}

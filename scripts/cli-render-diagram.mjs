import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { out } from "./cli-io.mjs";
import { block, drawChecked, knownKinds } from "./lib/diagrams/index.mjs";
import { catalogueTable, kindCatalogue } from "./lib/diagrams/registry.mjs";
import { previewHtml } from "./lib/diagrams/preview.mjs";

/** @typedef {import("./lib/diagrams/types.mjs").DiagramSpec} DiagramSpec */

/**
 * Collect the specs a file provides: a JSON document, or an ES module whose
 * exports include one or more spec objects. Accepting several per file is
 * deliberate — a leaf usually carries a related set, and rendering them together
 * is what makes the preview page useful for comparing them.
 * @param {string} file
 * @returns {Promise<{ name: string, spec: DiagramSpec }[]>}
 */
async function loadSpecs(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`spec file not found: ${abs}`);
  /** @type {{ name: string, spec: DiagramSpec }[]} */
  const found = [];
  // Detection is REGISTRY-driven: a spec is anything whose `kind` the engine can
  // render. Sniffing for a `nodes[]`/`actors[]` array instead does not scale --
  // every kind names its content differently (steps, entities, columns, root, a
  // single nested tree) -- and it silently SKIPPED a valid diagram rather than
  // failing, which is how a four-diagram file reported success having drawn
  // three. The one special case is a kind-less spec, which `draw` defaults to
  // `flow`.
  const kinds = new Set(knownKinds());
  /** @param {string} name @param {unknown} value */
  const consider = (name, value) => {
    if (!value || typeof value !== "object") return;
    const v = /** @type {Record<string, unknown>} */ (value);
    const named = typeof v.kind === "string" && kinds.has(v.kind);
    const defaultFlow = v.kind === undefined && Array.isArray(v.nodes);
    if (named || defaultFlow) {
      found.push({ name, spec: /** @type {DiagramSpec} */ (value) });
    }
  };

  if (abs.endsWith(".json")) {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (Array.isArray(parsed)) parsed.forEach((s, i) => consider(`spec[${i}]`, s));
    else consider(path.basename(abs, ".json"), parsed);
  } else {
    const mod = await import(pathToFileURL(abs).href);
    for (const [key, value] of Object.entries(mod)) consider(key, value);
  }
  if (found.length === 0) {
    throw new Error(
      `no diagram specs in ${abs}: every export needs a \`kind\` the engine knows (${knownKinds().join(", ")}), or a bare \`nodes[]\` for the default flow`,
    );
  }
  return found;
}

/**
 * `render-diagram --list [--table] | --spec <file> [--out <file>] [--html] [--strict]`
 *
 * `--list` answers "what can this render, and when do I use each" in one cheap
 * call, so an agent never has to guess a kind or read a renderer to find out.
 * `--table` prints the same catalogue as the markdown the diagram rule embeds.
 *
 * Otherwise: default output is the markdown-embeddable `<div class="dd">` block.
 * `--html` writes a standalone review page instead, which is the surface to LOOK
 * at before saving a leaf. `--strict` turns geometric findings into a non-zero
 * exit, so a generator or a hook can refuse an illegible diagram.
 * @param {string[]} rest
 * @returns {Promise<void>}
 */
export async function handleRenderDiagram(rest) {
  const value = (/** @type {string} */ flag) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (rest.includes("--list")) {
    if (rest.includes("--table")) {
      process.stdout.write(`${catalogueTable()}\n`);
      return;
    }
    out({ kinds: kindCatalogue() });
    return;
  }
  const specFile = value("--spec");
  if (!specFile) throw new Error("render-diagram requires --spec <file> (or --list)");
  const outFile = value("--out");
  const asHtml = rest.includes("--html");
  const strict = rest.includes("--strict");

  const entries = await loadSpecs(specFile);
  /** @type {{ name: string, findings: import("./lib/diagrams/validate.mjs").Finding[] }[]} */
  const reports = [];
  for (const { name, spec } of entries) {
    const { findings } = drawChecked(spec);
    if (findings.length) reports.push({ name, findings });
  }

  const body = asHtml ? previewHtml(entries) : entries.map(({ spec }) => block(spec)).join("\n\n");

  if (outFile) {
    fs.writeFileSync(path.resolve(outFile), body);
  } else if (!asHtml) {
    process.stdout.write(`${body}\n`);
  } else {
    throw new Error("--html needs --out <file>");
  }

  // Findings go to stderr so `--out -` style piping of the markup stays clean.
  for (const r of reports) {
    for (const f of r.findings) process.stderr.write(`[${r.name}] ${f.kind}: ${f.detail}\n`);
  }
  if (outFile) {
    out({
      ok: reports.length === 0,
      wrote: path.resolve(outFile),
      diagrams: entries.map((e) => e.name),
      findings: reports,
    });
  }
  if (strict && reports.length > 0) {
    throw new Error(
      `${reports.length} diagram(s) have geometric findings; refusing under --strict`,
    );
  }
}

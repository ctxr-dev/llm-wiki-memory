import fs from "node:fs";
import path from "node:path";
import { COMPILE_STATE_PATH, wikiRoot, embedCachePath } from "./lib/env.mjs";
import { indexRebuildAll } from "./lib/wiki-cli.mjs";
import { installLayoutTemplate, DEFAULT_TEMPLATE } from "./lib/layout-template.mjs";
import { out } from "./cli-io.mjs";

// Parse `--template <name>` from the init argv tail. Unknown flags are ignored
// here (they fail-close later in installLayoutTemplate on an unknown name).
/**
 * @param {string[]} argv
 * @returns {string}
 */
function parseTemplate(argv) {
  const i = argv.indexOf("--template");
  const v = i !== -1 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : DEFAULT_TEMPLATE;
}

// Materialise the hosted wiki: install the chosen layout template (if absent)
// into the canonical <wiki>/.layout/ location, then regenerate the derived
// index.md tree. Idempotent. `--template <name>` selects examples/layouts/<name>/
// (default: "default"); an unknown name fails closed (clear error, exit 2).
/**
 * @param {string[]} [argv]
 * @returns {void}
 */
export function cmdInit(argv = []) {
  const template = parseTemplate(argv);
  const wiki = wikiRoot();
  fs.mkdirSync(wiki, { recursive: true });
  fs.mkdirSync(path.join(wiki, ".layout"), { recursive: true });
  fs.mkdirSync(path.dirname(embedCachePath()), { recursive: true });
  fs.mkdirSync(path.dirname(COMPILE_STATE_PATH), { recursive: true });

  const layoutDir = path.join(wiki, ".layout");
  // Symlink guard on layout/ — if someone planted a symlink there, refuse
  // rather than write through it (matches the skill's INIT-08 behaviour).
  if (fs.existsSync(layoutDir)) {
    const layoutStat = fs.lstatSync(layoutDir);
    if (layoutStat.isSymbolicLink()) {
      out({ ok: false, error: `refusing to write through symlink at ${layoutDir}` });
      process.exit(2);
    }
  }
  const contractPath = path.join(layoutDir, "layout.yaml");
  if (fs.existsSync(contractPath)) {
    const contractStat = fs.lstatSync(contractPath);
    if (contractStat.isSymbolicLink()) {
      out({ ok: false, error: `refusing to write through symlink at ${contractPath}` });
      process.exit(2);
    }
  } else {
    try {
      installLayoutTemplate(layoutDir, template);
    } catch (err) {
      out({ ok: false, error: err instanceof Error ? err.message : String(err) });
      process.exit(2);
    }
  }

  // A fresh clone of a shared wiki carries its tracked leaves but never its
  // gitignored index.md, so the root index is absent. Regenerate the derived
  // index tree LOCALLY — this only (re)writes index.md, it never moves,
  // re-clusters, or deletes leaves. The whole-tree `build` convergence would
  // clobber a freshly-cloned tree, so it must never run on this path.
  if (!fs.existsSync(path.join(wiki, "index.md"))) {
    indexRebuildAll(wiki);
  }
  out({ ok: true, wiki, contract: contractPath, template, embedCache: embedCachePath() });
}

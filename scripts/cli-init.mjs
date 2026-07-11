import fs from "node:fs";
import path from "node:path";
import {
  MEMORY_DIR,
  MEMORY_DATA_DIR,
  COMPILE_STATE_PATH,
  wikiRoot,
  embedCachePath,
} from "./lib/env.mjs";
import { buildHosted } from "./lib/wiki-cli.mjs";
import { out } from "./cli-io.mjs";

// Materialise the hosted wiki: write the contract from the template (if
// absent) into the canonical <wiki>/.layout/layout.yaml location, and run
// the skill build. Idempotent.
export function cmdInit() {
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
    const tmpl = path.join(MEMORY_DIR, "templates", "llmwiki.layout.yaml");
    if (!fs.existsSync(tmpl)) {
      out({ ok: false, error: `template not found at ${tmpl}` });
      process.exit(2);
    }
    fs.copyFileSync(tmpl, contractPath);
  }

  // Build needs a source folder; an empty one yields an empty wiki shell.
  const src = path.join(MEMORY_DATA_DIR, ".build-src");
  fs.mkdirSync(src, { recursive: true });

  if (!fs.existsSync(path.join(wiki, "index.md"))) {
    buildHosted({ wiki, source: src });
  }
  out({ ok: true, wiki, contract: contractPath, embedCache: embedCachePath() });
}

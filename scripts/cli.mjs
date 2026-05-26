#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MEMORY_DIR,
  MEMORY_DATA_DIR,
  COMPILE_STATE_PATH,
  wikiRoot,
  embedCachePath,
  defaultProjectModule,
} from "./lib/env.mjs";
import { buildHosted, validate, heal, where } from "./lib/wiki-cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function out(obj) {
  process.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)}\n`);
}

// Materialise the hosted wiki: write the contract from the template (if
// absent) and run the skill build. Idempotent - re-running on an existing
// wiki is a no-op build that leaves content intact.
function cmdInit() {
  const wiki = wikiRoot();
  fs.mkdirSync(wiki, { recursive: true });
  fs.mkdirSync(path.dirname(embedCachePath()), { recursive: true });
  fs.mkdirSync(path.dirname(COMPILE_STATE_PATH), { recursive: true });

  const contractPath = path.join(wiki, ".llmwiki.layout.yaml");
  if (!fs.existsSync(contractPath)) {
    const tmpl = path.join(MEMORY_DIR, "templates", "llmwiki.layout.yaml");
    fs.copyFileSync(tmpl, contractPath);
  }

  // Build needs a source folder; an empty one yields an empty wiki shell.
  const src = path.join(MEMORY_DATA_DIR, ".build-src");
  fs.mkdirSync(src, { recursive: true });

  // Only run a fresh build when the wiki has not been initialised yet
  // (no root index.md). Re-building a populated hosted wiki is handled by
  // the skill's own collision rules, so we skip it here.
  if (!fs.existsSync(path.join(wiki, "index.md"))) {
    buildHosted({ wiki, source: src });
  }
  out({ ok: true, wiki, contract: contractPath, embedCache: embedCachePath() });
}

function cmdCompile(args) {
  const r = spawnSync(process.execPath, [path.join(here, "compile.mjs"), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 0);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      return cmdInit();
    case "validate":
      return out(validate(wikiRoot()));
    case "validate-layout": {
      const { validateLayoutFile, formatValidationResult } = await import(
        "./lib/layout-validator.mjs"
      );
      const target =
        rest[0] || path.join(wikiRoot(), ".llmwiki.layout.yaml");
      const result = validateLayoutFile(target);
      process.stdout.write(formatValidationResult(result));
      process.exit(result.ok ? 0 : 2);
    }
    case "heal":
      return out(heal(wikiRoot()));
    case "where":
      return out({
        memoryDir: MEMORY_DIR,
        dataDir: MEMORY_DATA_DIR,
        wiki: wikiRoot(),
        embedCache: embedCachePath(),
        projectModule: defaultProjectModule(),
        skill: where(),
      });
    case "recall": {
      const { recallLessons } = await import("./lib/recall.mjs");
      return out(await recallLessons({ query: rest.join(" ") || "*" }));
    }
    case "search": {
      const { searchMemory } = await import("./lib/recall.mjs");
      return out(await searchMemory({ query: rest.join(" ") || "*" }));
    }
    case "compile":
      return cmdCompile(rest);
    case "nest": {
      const { migrateNest } = await import("./migrate-nest.mjs");
      const res = migrateNest({ dryRun: rest.includes("--dry-run"), check: rest.includes("--check") });
      out(res);
      if (res.mode === "check" && !res.ok) process.exit(3);
      if (res.mode === "migrate" && !res.ok) process.exit(2);
      return;
    }
    case "migrate": {
      const { migrate } = await import("./migrate.mjs");
      const res = migrate({ dryRun: rest.includes("--dry-run"), check: rest.includes("--check") });
      out(res);
      if (res.mode === "check" && !res.ok) process.exit(3);
      if (res.mode === "migrate" && !res.ok) process.exit(2);
      return;
    }
    default:
      out(
        "Usage: llm-wiki-memory <init|validate|validate-layout [path]|heal|where|compile|nest [--dry-run|--check]|migrate [--dry-run|--check]|recall <q>|search <q>>",
      );
      process.exit(cmd ? 1 : 0);
  }
}

await main();

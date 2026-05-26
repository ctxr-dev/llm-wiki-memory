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
// absent) into the canonical <wiki>/layout/layout.yaml location, and run
// the skill build. Idempotent. If a legacy contract already exists at
// <wiki>/.llmwiki.layout.yaml (or <wiki>/layout/.llmwiki.layout.yaml),
// we leave it where it is — the patched skill recognises all three
// locations, and we don't want to silently move user-edited files.
function cmdInit() {
  const wiki = wikiRoot();
  fs.mkdirSync(wiki, { recursive: true });
  fs.mkdirSync(path.dirname(embedCachePath()), { recursive: true });
  fs.mkdirSync(path.dirname(COMPILE_STATE_PATH), { recursive: true });

  const canonicalContractPath = path.join(wiki, "layout", "layout.yaml");
  const legacyCanonicalPath = path.join(wiki, "layout", ".llmwiki.layout.yaml");
  const legacyRootPath = path.join(wiki, ".llmwiki.layout.yaml");
  const alreadyPresent =
    fs.existsSync(canonicalContractPath) ||
    fs.existsSync(legacyCanonicalPath) ||
    fs.existsSync(legacyRootPath);
  let contractPath = canonicalContractPath;
  if (fs.existsSync(canonicalContractPath)) contractPath = canonicalContractPath;
  else if (fs.existsSync(legacyCanonicalPath)) contractPath = legacyCanonicalPath;
  else if (fs.existsSync(legacyRootPath)) contractPath = legacyRootPath;

  if (!alreadyPresent) {
    fs.mkdirSync(path.join(wiki, "layout"), { recursive: true });
    const tmpl = path.join(MEMORY_DIR, "templates", "llmwiki.layout.yaml");
    fs.copyFileSync(tmpl, canonicalContractPath);
    contractPath = canonicalContractPath;
  }

  // Build needs a source folder; an empty one yields an empty wiki shell.
  const src = path.join(MEMORY_DATA_DIR, ".build-src");
  fs.mkdirSync(src, { recursive: true });

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
      let target = rest[0];
      if (!target) {
        const candidates = [
          path.join(wikiRoot(), "layout", "layout.yaml"),
          path.join(wikiRoot(), "layout", ".llmwiki.layout.yaml"),
          path.join(wikiRoot(), ".llmwiki.layout.yaml"),
        ];
        target =
          candidates.find((p) => fs.existsSync(p)) ||
          candidates[candidates.length - 1];
      }
      const result = validateLayoutFile(target);
      process.stdout.write(formatValidationResult(result));
      process.exit(result.ok ? 0 : 2);
    }
    case "test-path-compiler": {
      // Usage:
      //   llm-wiki-memory test-path-compiler <file_kind> [--category issues] [--layout <wiki-root>] key=val ...
      // Compiles the file_kind's path_compiler (or path_template), runs it
      // against the supplied facets, and prints the resolved path plus any
      // unresolved placeholders.
      const {
        loadTopology,
        pathFor,
        validateFacets,
        findUnresolvedPlaceholders,
      } = await import("./lib/topology-runtime.mjs");
      let categoryPath = "issues";
      let wikiOverride = null;
      const fkArgs = [];
      const facets = {};
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--category") {
          categoryPath = rest[++i];
        } else if (a === "--layout") {
          wikiOverride = rest[++i];
        } else if (a.includes("=")) {
          const eq = a.indexOf("=");
          const k = a.slice(0, eq);
          let v = a.slice(eq + 1);
          if (/^-?\d+$/.test(v)) v = Number(v);
          facets[k] = v;
        } else {
          fkArgs.push(a);
        }
      }
      const fileKind = fkArgs[0];
      if (!fileKind) {
        process.stderr.write(
          "usage: llm-wiki-memory test-path-compiler <file_kind> [--category <name>] [--layout <wiki-root>] key=val ...\n",
        );
        process.exit(64);
      }
      const root = wikiOverride || wikiRoot();
      const topology = await loadTopology(root, { categoryPath });
      const v = validateFacets(topology, fileKind, facets);
      if (!v.ok) {
        out({ ok: false, errors: v.errors, facets });
        process.exit(2);
      }
      try {
        const resolved = pathFor(topology, fileKind, facets);
        const unresolved = findUnresolvedPlaceholders(resolved);
        out({
          ok: unresolved.length === 0,
          file_kind: fileKind,
          facets,
          path: resolved,
          unresolved_placeholders: unresolved,
        });
        process.exit(unresolved.length === 0 ? 0 : 2);
      } catch (err) {
        out({ ok: false, file_kind: fileKind, facets, error: err.message });
        process.exit(2);
      }
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
        "Usage: llm-wiki-memory <init|validate|validate-layout [path]|test-path-compiler <file_kind> [--category <name>] [--layout <wiki-root>] key=val ...|heal|where|compile|nest [--dry-run|--check]|migrate [--dry-run|--check]|recall <q>|search <q>>",
      );
      process.exit(cmd ? 1 : 0);
  }
}

await main();

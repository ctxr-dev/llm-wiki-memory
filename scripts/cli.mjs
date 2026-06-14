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
// absent) into the canonical <wiki>/.layout/layout.yaml location, and run
// the skill build. Idempotent.
function cmdInit() {
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
    case "validate-topology": {
      const { validateTopologyAgainstSamples, formatValidationReport } = await import(
        "./lib/topology-validator.mjs"
      );
      const target = rest[0] || wikiRoot();
      const category = rest[1] || "issues";
      const result = await validateTopologyAgainstSamples(target, { categoryPath: category });
      process.stdout.write(`validate-topology on ${target} (category=${category}):\n`);
      process.stdout.write(formatValidationReport(result));
      process.exit(result.ok ? 0 : 2);
    }
    case "validate-layout": {
      const { validateLayoutFile, formatValidationResult } = await import(
        "./lib/layout-validator.mjs"
      );
      const target = rest[0] || path.join(wikiRoot(), ".layout", "layout.yaml");
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
    case "gc-embeddings": {
      // On-demand sweep of orphaned embedding-cache entries (ids whose leaf no
      // longer exists). --dry-run previews without writing. --if-due throttles
      // to MEMORY_GC_INTERVAL_DAYS via state/.embed-gc.json (the SessionEnd
      // embed-gc hook + hook-less agents use this); plain run is unconditional.
      const { pruneEmbeddingCache } = await import("./lib/wiki-store.mjs");
      return out(
        pruneEmbeddingCache({
          dryRun: rest.includes("--dry-run"),
          ifDue: rest.includes("--if-due"),
        }),
      );
    }
    case "consolidate": {
      // Search-driven AutoDream consolidation. See scripts/consolidate.mjs
      // for the orchestrator + per-pass rules. Flags:
      //   --dry-run, --if-due, --force, --no-llm, --json
      //   --passes=<csv>            (allow-list of pass names)
      //   --cosine-threshold=<n>    (override 0..1)
      const { consolidateMemory } = await import("./consolidate.mjs");
      const flag = (name) => rest.includes(`--${name}`);
      const opt = (name) => {
        const prefix = `--${name}=`;
        const hit = rest.find((a) => a.startsWith(prefix));
        return hit ? hit.slice(prefix.length) : undefined;
      };
      // --cosine-threshold overrides the YAML knob for this CLI process via
      // the process-level settings override. Operators normally edit
      // settings.yaml; this flag is a one-shot override for the current
      // invocation and dies with the process.
      // Space-form flags silently did nothing (the 2026-06-04 one-off run
      // executed at the default threshold twice before anyone noticed).
      // Fail loud on the known value-taking flags when passed without '='.
      for (const valueFlag of ["cosine-threshold", "passes"]) {
        if (rest.includes(`--${valueFlag}`)) {
          process.stderr.write(
            `consolidate: --${valueFlag} requires the equals form (--${valueFlag}=<value>); ignoring the bare flag would silently run with defaults — aborting.\n`,
          );
          process.exit(2);
        }
      }
      const cosineOverride = opt("cosine-threshold");
      if (cosineOverride) {
        const n = Number.parseFloat(cosineOverride);
        if (Number.isFinite(n) && n >= 0 && n <= 1) {
          const { __setSettingsOverride } = await import("./lib/settings.mjs");
          __setSettingsOverride({ consolidate: { cosineThreshold: n } });
        } else {
          process.stderr.write(
            `consolidate: invalid --cosine-threshold value '${cosineOverride}' (expected 0..1); refusing to silently run at the default — aborting.\n`,
          );
          process.exit(2);
        }
      }
      const result = await consolidateMemory({
        dryRun: flag("dry-run"),
        ifDue: flag("if-due"),
        force: flag("force"),
        llm: !flag("no-llm"),
        passes: opt("passes"),
      });
      if (flag("json")) return out(result);
      // Pretty print: short summary + a one-line-per-pass breakdown.
      out(result);
      return;
    }
    case "where": {
      const { health } = await import("./lib/llm.mjs");
      const llm = await health().catch((err) => ({
        provider: "unknown",
        available: false,
        reason: err?.message || String(err),
      }));
      return out({
        memoryDir: MEMORY_DIR,
        dataDir: MEMORY_DATA_DIR,
        wiki: wikiRoot(),
        embedCache: embedCachePath(),
        projectModule: defaultProjectModule(),
        skill: where(),
        llm,
      });
    }
    case "cron-job": {
      // Hourly cron entry point. Runs compile + consolidate --if-due
      // sequentially, appends a structured attempt entry to
      // state/.consolidate-attempts.log (success OR error), and exits
      // 0 (so cron doesn't email failures — the log is the source of
      // truth and SessionStart surfaces unresolved failures to the user).
      const { runCronJob } = await import("./cron-job.mjs");
      const entry = await runCronJob();
      out(entry);
      // Exit 0 unconditionally so cron treats this as success. The log
      // entry's `ok: false` is the persistent signal; SessionStart's
      // cron-health check raises it with the user.
      process.exit(0);
      return;
    }
    case "cron-health": {
      const { cronHealth } = await import("./cron-job.mjs");
      out(cronHealth());
      return;
    }
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
    case "redistill": {
      // Manual recovery for the failed-distill stash. Three modes:
      //   --leaf <path>     re-distill against the stash whose session_id
      //                     matches the leaf's frontmatter.
      //   --session <id>    re-distill the newest stash for that session.
      //   --all             sweep every stash in STATE_DIR.
      const {
        redistillFromStash,
        redistillFromLeaf,
        listFailedDistillStashes,
        findStashForSession,
      } = await import("./hooks/flush.mjs");
      const opt = (name) => {
        const idx = rest.indexOf(`--${name}`);
        if (idx < 0) return null;
        const val = rest[idx + 1];
        // A following flag (e.g. `--leaf --session x`) means this flag had no
        // value — return null rather than swallowing the next flag as a value.
        return val == null || val.startsWith("--") ? null : val;
      };
      const leafArg = opt("leaf");
      const sessionArg = opt("session");
      const all = rest.includes("--all");

      if (!leafArg && !sessionArg && !all) {
        process.stderr.write(
          "usage: llm-wiki-memory redistill --leaf <path> | --session <id> | --all\n",
        );
        process.exit(64);
      }

      const stashes = [];
      // Leaves without a matching stash are recovered via the in-leaf raw
      // fallback path (redistillFromLeaf), so we collect those separately
      // from stash-backed leaves and process them after the stash sweep.
      const leafFallbacks = [];
      if (leafArg) {
        if (!fs.existsSync(leafArg)) {
          out({ ok: false, error: `leaf not found at ${leafArg}` });
          process.exit(2);
        }
        // Guard the read: --leaf pointed at a directory (EISDIR) or an
        // unreadable file would otherwise crash with an unhandled exception
        // instead of a clean JSON error.
        let leafText;
        try {
          leafText = fs.readFileSync(leafArg, "utf8");
        } catch (readErr) {
          out({ ok: false, error: `could not read leaf at ${leafArg}: ${readErr?.message || readErr}` });
          process.exit(2);
        }
        const m = leafText.match(/^- session_id:\s*(.+)$/m) ||
          leafText.match(/^session_id:\s*(.+)$/m);
        if (!m) {
          out({ ok: false, error: `leaf at ${leafArg} has no session_id in frontmatter` });
          process.exit(2);
        }
        const stash = findStashForSession(m[1].trim());
        if (stash) {
          stashes.push(stash);
        } else {
          // No stash — pre-map-reduce leaf, or one whose stash was purged.
          // Recover from the in-leaf UNTRUSTED MEMORY BODY block instead.
          leafFallbacks.push(leafArg);
        }
      } else if (sessionArg) {
        const stash = findStashForSession(sessionArg);
        if (!stash) {
          out({ ok: false, error: `no stash for session ${sessionArg}` });
          process.exit(2);
        }
        stashes.push(stash);
      } else {
        stashes.push(...listFailedDistillStashes());
        if (stashes.length === 0) {
          out({ ok: true, redistilled: 0, message: "no failed-distill stashes to process" });
          return;
        }
      }

      const results = [];
      let anyFailed = false;
      for (const stash of stashes) {
        try {
          const r = await redistillFromStash(stash, { tag: "cli-redistill" });
          results.push({ stash: path.basename(stash), ok: true, outcome: r.outcome, audit: r.audit });
        } catch (err) {
          anyFailed = true;
          results.push({ stash: path.basename(stash), ok: false, error: err?.message || String(err) });
        }
      }
      for (const leaf of leafFallbacks) {
        try {
          const r = await redistillFromLeaf(leaf, { tag: "cli-redistill-leaf" });
          results.push({ leaf: path.basename(leaf), ok: true, outcome: r.outcome, audit: r.audit });
        } catch (err) {
          anyFailed = true;
          results.push({ leaf: path.basename(leaf), ok: false, error: err?.message || String(err) });
        }
      }
      out({
        ok: !anyFailed,
        redistilled: results.filter((r) => r.ok).length,
        total: stashes.length + leafFallbacks.length,
        results,
      });
      process.exit(anyFailed ? 2 : 0);
      return;
    }
    case "nest": {
      const { migrateNest } = await import("./migrate-nest.mjs");
      const res = await migrateNest({ dryRun: rest.includes("--dry-run"), check: rest.includes("--check") });
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
    case "doctor": {
      // Curated-wiki health scan: broken index refs, leaves missing from their
      // index, raw no-frontmatter strays, orphans. Layout-derived (see
      // lib/doctor.mjs). Exit 3 on findings (mirrors nest/migrate --check) so a
      // cron/CI preflight can key on it. Run after a suspected cloud-sync event.
      // `--fix` (opt-in) surgically rebuilds the parents holding a broken ref;
      // without it, doctor stays purely read-only.
      const fix = rest.includes("--fix");
      const { doctor } = await import("./lib/doctor.mjs");
      let report;
      if (fix) {
        // --fix mutates index.md files; commit the repairs as ONE wiki commit
        // (a no-op outside a git wiki). Default doctor stays frame-free/read-only.
        const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
        report = withWikiCommit({ op: "doctor-fix", actor: "cli" }, () => doctor(wikiRoot(), { fix }));
      } else {
        report = doctor(wikiRoot());
      }
      out(report);
      process.exit(report.ok ? 0 : 3);
    }
    case "backfill-priority": {
      // Stamp a deterministic rubric priority (never P0) on every leaf that
      // lacks one — no LLM. --dry-run previews. Pinned in place; one commit.
      // Recall already lazy-defaults a missing priority, so this just persists it.
      const dryRun = rest.includes("--dry-run");
      const { backfillPriority } = await import("./lib/wiki-store.mjs");
      if (dryRun) {
        out(backfillPriority({ dryRun: true }));
        return;
      }
      const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
      out(withWikiCommit({ op: "backfill-priority", actor: "cli" }, () => backfillPriority({ dryRun: false })));
      return;
    }
    case "move-leaf": {
      // Relocate a curated leaf: move-leaf <from> <to> (wiki-relative paths).
      // moveDocument refuses facet/topology/daily regimes (see wiki-store.mjs).
      const [from, to] = rest.filter((a) => !a.startsWith("--"));
      if (!from || !to) {
        process.stderr.write("usage: llm-wiki-memory move-leaf <from> <to>\n");
        process.exit(64);
      }
      const { moveDocument } = await import("./lib/wiki-store.mjs");
      const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
      const res = withWikiCommit({ op: "cli-move-leaf", actor: "cli" }, () =>
        moveDocument({ fromPath: from, toPath: to }),
      );
      out(res);
      process.exit(res.ok ? 0 : 2);
    }
    case "monitor": {
      // Self-observability: record a redacted forensic capture of an observed
      // llm-wiki-memory anomaly under <data>/monitoring/, or --resolve one as
      // triaged. See lib/monitoring.mjs + the self-observability rule.
      const { writeMonitoringCapture, resolveCapture, relatedEscalation } =
        await import("./lib/monitoring.mjs");
      const opt = (name) => {
        const idx = rest.indexOf(`--${name}`);
        if (idx < 0) return null;
        const val = rest[idx + 1];
        return val == null || val.startsWith("--") ? null : val;
      };
      const resolveArg = opt("resolve");
      if (resolveArg) {
        const r = resolveCapture(resolveArg);
        out(r);
        process.exit(r.ok ? 0 : 2);
      }
      const title = opt("title");
      if (!title) {
        process.stderr.write(
          "usage: llm-wiki-memory monitor --title <t> [--severity likely-bug|confirmed-bug] [--surface <s>] [--observed <s>] [--evidence <s>] [--suspected <f,f>] [--cwd <p>] [--branch <b>] [--related <s>] | --resolve <file>\n",
        );
        process.exit(64);
      }
      const evidence = opt("evidence") || "";
      const relatedArg = opt("related");
      let related = relatedArg || "";
      if (!related) {
        const { normalizeErrorSignature } = await import("./lib/error-signature.mjs");
        related = await relatedEscalation(normalizeErrorSignature(title));
      }
      const r = writeMonitoringCapture({
        title,
        severity: opt("severity") || "confirmed-bug",
        surface: opt("surface") || "",
        observed: opt("observed") || "",
        evidence,
        suspectedFiles: (opt("suspected") || "").split(",").map((s) => s.trim()).filter(Boolean),
        cwd: opt("cwd") || "",
        branch: opt("branch") || "",
        related,
      });
      out(r);
      process.exit(r.ok ? 0 : 1);
    }
    case "monitoring-health": {
      // Read-only count of unreviewed self-observability captures (status:open).
      // Surfaced at SessionStart (one line) + the session-end-capture skill.
      const { monitoringHealth } = await import("./lib/monitoring.mjs");
      out(monitoringHealth());
      return;
    }
    case "gate-audit": {
      // Read-only view of the write-gate audit ledger
      // (state/.save-gate-audit.log): every decision on the gated self_improvement
      // category, newest last: L2 hook allow/ask, L3 server accepted/refused, and
      // compile-distilled lesson promotions (observability only). Inspect how (or
      // whether) each lesson was consented to. Returns [] when nothing recorded yet.
      const { readAudit } = await import("./lib/save-gate-audit.mjs");
      const idx = rest.indexOf("--limit");
      const limRaw = idx >= 0 ? Number(rest[idx + 1]) : NaN;
      const limit = Number.isFinite(limRaw) && limRaw > 0 ? limRaw : 50;
      out(readAudit({ limit }));
      return;
    }
    default:
      out(
        "Usage: llm-wiki-memory <init|validate|validate-layout [path]|validate-topology [wiki-root] [category]|test-path-compiler <file_kind> [--category <name>] [--layout <wiki-root>] key=val ...|heal|gc-embeddings [--dry-run]|where|compile|nest [--dry-run|--check]|migrate [--dry-run|--check]|doctor|move-leaf <from> <to>|monitor --title <t> [...] | --resolve <file>|monitoring-health|gate-audit [--limit N]|recall <q>|search <q>|redistill --leaf <path> | --session <id> | --all>",
      );
      process.exit(cmd ? 1 : 0);
  }
}

await main();

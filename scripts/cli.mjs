#!/usr/bin/env node
import { refuseBelowNodeFloor } from "./lib/node-floor.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { out } from "./cli-io.mjs";
import { handleSaveLeaf } from "./cli-save-leaf.mjs";
import { helpGuard, REPO_RAW_BASE } from "./lib/cli-args.mjs";
import { cmdInit } from "./cli-init.mjs";
import {
  handleValidate,
  handleValidateTopology,
  handleValidateLayout,
  handleTestPathCompiler,
} from "./cli-validate.mjs";
import { handleConsolidate } from "./cli-consolidate.mjs";
import { handleAbsorb } from "./cli-absorb.mjs";
import { handleMigrations } from "./cli-migrations.mjs";
import {
  handleHeal,
  handleGcEmbeddings,
  handleWarm,
  handleNest,
  handleMigrate,
  handleMigrateIdentity,
  handleDoctor,
  handleBackfillPriority,
  handleMoveLeaf,
} from "./cli-maintenance.mjs";
import { handleWhere, handleRecall, handleSearch } from "./cli-query.mjs";
import { handleCronJob, handleCronHealth } from "./cli-cron.mjs";
import { handleRedistill } from "./cli-redistill.mjs";
import { handleMonitor, handleMonitoringHealth, handleGateAudit } from "./cli-monitor.mjs";
import { handleRenderDiagram } from "./cli-render-diagram.mjs";
import { handleGallery } from "./cli-gallery.mjs";

refuseBelowNodeFloor();

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string[]} args */
function cmdCompile(args) {
  const r = spawnSync(process.execPath, [path.join(here, "compile.mjs"), ...args], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(r.status ?? 0);
}

const USAGE =
  "Usage: llm-wiki-memory <init|validate|validate-layout [path]|validate-topology [wiki-root] [category]|test-path-compiler <file_kind> [--category <name>] [--layout <wiki-root>] key=val ...|heal|gc-embeddings [--dry-run]|warm [--if-due]|migrations [--explain|--remigrate|--phase <settings|data>]|where|compile|nest [--dry-run|--check]|migrate [--dry-run|--check]|migrate-identity [--dry-run|--check]|doctor|save-leaf --file <path> --dataset <name> [--name|--path|--area=|--atom-type=|--task-type=|--subject=|--tags=|--language=|--priority=|--error-pattern=|--dry-run|--allow-duplicate]|move-leaf <from> <to>|render-diagram --list [--table] | --spec <file> [--out <file>] [--html] [--strict]|gallery [--png]|absorb <path...> --category=<name> [--match=<glob>]... [--area=|--subject=|--atom-type=] [--target=<sel>] [--dry-run]|monitor --title <t> [...] | --resolve <file>|monitoring-health|gate-audit [--limit N]|recall <q>|search <q>|redistill --leaf <path> | --session <id> | --all>\n\n" +
  `Docs (any OS, via WebFetch): ${REPO_RAW_BASE}/ — README.md · AI-INSTALL-PROMPT.md · ARCHITECTURE.md · docs/{shared-wikis,consolidate,embeddings}.md`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  helpGuard(process.argv.slice(2), USAGE);
  switch (cmd) {
    case "init":
      return cmdInit(rest);
    case "validate":
      return handleValidate();
    case "validate-topology":
      return handleValidateTopology(rest);
    case "validate-layout":
      return handleValidateLayout(rest);
    case "test-path-compiler":
      return handleTestPathCompiler(rest);
    case "heal":
      return handleHeal();
    case "gc-embeddings":
      return handleGcEmbeddings(rest);
    case "warm":
      return handleWarm(rest);
    case "migrations":
      return handleMigrations(rest);
    case "consolidate":
      return handleConsolidate(rest);
    case "absorb":
      return handleAbsorb(rest);
    case "where":
      return handleWhere(rest);
    case "cron-job":
      return handleCronJob();
    case "cron-health":
      return handleCronHealth();
    case "recall":
      return handleRecall(rest);
    case "search":
      return handleSearch(rest);
    case "compile":
      return cmdCompile(rest);
    case "redistill":
      return handleRedistill(rest);
    case "nest":
      return handleNest(rest);
    case "migrate":
      return handleMigrate(rest);
    case "migrate-identity":
      return handleMigrateIdentity(rest);
    case "doctor":
      return handleDoctor(rest);
    case "backfill-priority":
      return handleBackfillPriority(rest);
    case "save-leaf":
      return handleSaveLeaf(rest);
    case "move-leaf":
      return handleMoveLeaf(rest);
    case "render-diagram":
      return handleRenderDiagram(rest);
    case "gallery":
      return handleGallery(rest);
    case "monitor":
      return handleMonitor(rest);
    case "monitoring-health":
      return handleMonitoringHealth();
    case "gate-audit":
      return handleGateAudit(rest);
    default:
      out(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.main) {
  await main();
}

#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { out } from "./cli-io.mjs";
import { cmdInit } from "./cli-init.mjs";
import {
  handleValidate,
  handleValidateTopology,
  handleValidateLayout,
  handleTestPathCompiler,
} from "./cli-validate.mjs";
import { handleConsolidate } from "./cli-consolidate.mjs";
import {
  handleHeal,
  handleGcEmbeddings,
  handleNest,
  handleMigrate,
  handleDoctor,
  handleBackfillPriority,
  handleMoveLeaf,
} from "./cli-maintenance.mjs";
import { handleWhere, handleRecall, handleSearch } from "./cli-query.mjs";
import { handleCronJob, handleCronHealth } from "./cli-cron.mjs";
import { handleRedistill } from "./cli-redistill.mjs";
import { handleMonitor, handleMonitoringHealth, handleGateAudit } from "./cli-monitor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @param {string[]} args */
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
    case "consolidate":
      return handleConsolidate(rest);
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
    case "doctor":
      return handleDoctor(rest);
    case "backfill-priority":
      return handleBackfillPriority(rest);
    case "move-leaf":
      return handleMoveLeaf(rest);
    case "monitor":
      return handleMonitor(rest);
    case "monitoring-health":
      return handleMonitoringHealth();
    case "gate-audit":
      return handleGateAudit(rest);
    default:
      out(
        "Usage: llm-wiki-memory <init|validate|validate-layout [path]|validate-topology [wiki-root] [category]|test-path-compiler <file_kind> [--category <name>] [--layout <wiki-root>] key=val ...|heal|gc-embeddings [--dry-run]|where|compile|nest [--dry-run|--check]|migrate [--dry-run|--check]|doctor|move-leaf <from> <to>|monitor --title <t> [...] | --resolve <file>|monitoring-health|gate-audit [--limit N]|recall <q>|search <q>|redistill --leaf <path> | --session <id> | --all>",
      );
      process.exit(cmd ? 1 : 0);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMORY_DATA_DIR, wikiRoot } from "./lib/env.mjs";
import { runMigrations } from "./lib/migration-runner.mjs";
import { loadRegistry, PHASES } from "./lib/migration-registry.mjs";
import { readLedger } from "./lib/migration-ledger.mjs";
import { out } from "./cli-io.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.dirname(SCRIPTS_DIR);
// Under scripts/ so the existing check:size / check:comments / eslint globs cover
// migrations automatically, rather than needing their own gate wiring.
export const MIGRATIONS_DIR = path.join(SCRIPTS_DIR, "migrations");

/**
 * Human-readable summary of a run. The POINT of printing it is that an install
 * many versions behind never has to open a file: any decision a migration made on
 * the operator's behalf is surfaced here, already applied at its safe default.
 * @param {import("./lib/migration-runner.mjs").MigrationReport} r
 * @returns {string[]}
 */
export function formatReport(r) {
  const lines = [
    `migrations: ${r.skipped.length + r.alreadyCurrent.length} already current, ${r.applied.length} applied`,
  ];
  for (const id of r.applied) lines.push(`  applied ${id}`);
  if (r.decisions.length) {
    lines.push(
      `  ${r.decisions.length} decision${r.decisions.length === 1 ? "" : "s"} auto-defaulted:`,
    );
    for (const d of r.decisions) lines.push(`   · ${d.id}: ${d.decision}`);
    lines.push("  Review them with: cli.mjs migrations --explain");
  }
  return lines;
}

/** @param {string[]} rest */
export async function handleMigrations(rest) {
  const dataDir = MEMORY_DATA_DIR;
  // --explain lists every registered migration and whether this install has
  // settled it — a read-only view, so it can be run any time without side effects.
  if (rest.includes("--explain")) {
    const settled = new Set(readLedger(dataDir).applied);
    const entries = loadRegistry(MIGRATIONS_DIR);
    const rows = await Promise.all(
      entries.map(async (e) => {
        const mod = await import(`${e.file}`);
        return {
          id: e.id,
          phase: e.phase,
          title: mod.title || "",
          settled: settled.has(e.id),
          decision: typeof mod.decision === "string" ? mod.decision : undefined,
        };
      }),
    );
    return out({ ok: true, migrations: rows });
  }

  const remigrate = rest.includes("--remigrate");
  const phaseArg = rest[rest.indexOf("--phase") + 1];
  const phases = rest.includes("--phase") ? [phaseArg] : [...PHASES];
  for (const phase of phases) {
    if (!PHASES.includes(phase)) {
      throw new Error(`unknown phase ${JSON.stringify(phase)}; expected ${PHASES.join(" or ")}`);
    }
  }

  /** @type {import("./lib/migration-runner.mjs").MigrationReport} */
  const total = { applied: [], alreadyCurrent: [], skipped: [], decisions: [] };
  for (const phase of phases) {
    const r = await runMigrations({
      dataDir,
      migrationsDir: MIGRATIONS_DIR,
      phase,
      remigrate,
      context: { dataDir, wikiRoot: wikiRoot(), srcDir: SRC_DIR },
    });
    for (const k of /** @type {const} */ (["applied", "alreadyCurrent", "skipped", "decisions"])) {
      total[k].push(.../** @type {never[]} */ (r[k]));
    }
  }
  for (const line of formatReport(total)) process.stderr.write(`${line}\n`);
  return out({ ok: true, ...total });
}

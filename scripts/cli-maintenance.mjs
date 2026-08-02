import { wikiRoot } from "./lib/env.mjs";
import { heal } from "./lib/wiki-cli.mjs";
import { out } from "./cli-io.mjs";

export function handleHeal() {
  return out(heal(wikiRoot()));
}

/** @param {string[]} rest */
export async function handleGcEmbeddings(rest) {
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

/** @param {string[]} rest */
export async function handleWarm(rest) {
  // Gradual, duty-cycled warm of this wiki's embedding caches. --if-due honours
  // embed.warmIntervalMinutes and the cross-process lock (what the hourly cron
  // and the webapp timer use); a plain run warms unconditionally, which is the
  // form to reach for after a model change or a bulk import.
  const { warmWikiEmbeddings, warmWikiEmbeddingsIfDue } = await import("./lib/embed-warm.mjs");
  const root = wikiRoot();
  return out(
    rest.includes("--if-due")
      ? await warmWikiEmbeddingsIfDue(root)
      : { ok: true, ...(await warmWikiEmbeddings(root)) },
  );
}

/** @param {string[]} rest */
export async function handleNest(rest) {
  const { migrateNest } = await import("./migrate-nest.mjs");
  const res = await migrateNest({
    dryRun: rest.includes("--dry-run"),
    check: rest.includes("--check"),
  });
  out(res);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
  return;
}

/** @param {string[]} rest */
export async function handleMigrate(rest) {
  const { migrate } = await import("./migrate.mjs");
  const res = migrate({ dryRun: rest.includes("--dry-run"), check: rest.includes("--check") });
  out(res);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
  return;
}

/** @param {string[]} rest */
export async function handleMigrateIdentity(rest) {
  const { migrateProjectModuleIdentity } = await import("./migrate-identity.mjs");
  const dryRun = rest.includes("--dry-run");
  const check = rest.includes("--check");
  /** @type {ReturnType<typeof migrateProjectModuleIdentity>} */
  let res;
  if (dryRun || check) {
    res = migrateProjectModuleIdentity({ dryRun, check });
  } else {
    const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
    res = /** @type {ReturnType<typeof migrateProjectModuleIdentity>} */ (
      withWikiCommit({ op: "migrate-identity", actor: "cli" }, () =>
        migrateProjectModuleIdentity({}),
      )
    );
  }
  out(res);
  if (res.mode === "check" && !res.ok) process.exit(3);
  if (res.mode === "migrate" && !res.ok) process.exit(2);
  return;
}

/** @param {string[]} rest */
export async function handleDoctor(rest) {
  // Curated-wiki health scan: broken index refs, leaves missing from their
  // index, raw no-frontmatter strays, orphans. Layout-derived (see
  // lib/doctor.mjs). Exit 3 on findings (mirrors nest/migrate --check) so a
  // cron/CI preflight can key on it. Run after a suspected cloud-sync event.
  // `--fix` (opt-in) surgically rebuilds the parents holding a broken ref;
  // without it, doctor stays purely read-only.
  const fix = rest.includes("--fix");
  const { doctor } = await import("./lib/doctor.mjs");
  /** @type {import("./lib/doctor.mjs").DoctorReport} */
  let report;
  if (fix) {
    // --fix mutates index.md files; commit the repairs as ONE wiki commit
    // (a no-op outside a git wiki). Default doctor stays frame-free/read-only.
    const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
    report = /** @type {import("./lib/doctor.mjs").DoctorReport} */ (
      withWikiCommit({ op: "doctor-fix", actor: "cli" }, () => doctor(wikiRoot(), { fix }))
    );
  } else {
    report = doctor(wikiRoot());
  }
  out(report);
  process.exit(report.ok ? 0 : 3);
}

/** @param {string[]} rest */
export async function handleBackfillPriority(rest) {
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
  out(
    withWikiCommit({ op: "backfill-priority", actor: "cli" }, () =>
      backfillPriority({ dryRun: false }),
    ),
  );
  return;
}

/** @param {string[]} rest */
export async function handleMoveLeaf(rest) {
  // Relocate a curated leaf: move-leaf <from> <to> (wiki-relative paths).
  // moveDocument refuses facet/topology/daily regimes (see wiki-store.mjs).
  const [from, to] = rest.filter((a) => !a.startsWith("--"));
  if (!from || !to) {
    process.stderr.write("usage: llm-wiki-memory move-leaf <from> <to>\n");
    process.exit(64);
  }
  const { moveDocument } = await import("./lib/wiki-store.mjs");
  const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
  const res = /** @type {{ ok: boolean, reason?: string }} */ (
    withWikiCommit({ op: "cli-move-leaf", actor: "cli" }, () =>
      moveDocument({ fromPath: from, toPath: to }),
    )
  );
  out(res);
  process.exit(res.ok ? 0 : 2);
}

/**
 * Save a leaf whose BODY comes from a file, so document size stops being an
 * agent-side constraint: a large plan or investigation never has to be inlined in a
 * tool-call argument (clients cap and truncate those — a ~46KB inline payload fails
 * to parse), and re-saving an edited doc costs a file write rather than re-emitting
 * the whole body.
 *
 * save-leaf --file <path> --dataset <name> [--name <leaf.md>] [--path <dir>]
 *           [--area=…] [--atom-type=…] [--task-type=…] [--subject=…] [--tags=…]
 * @param {string[]} rest
 */
export async function handleSaveLeaf(rest) {
  /** @param {string} key @returns {string | undefined} */
  const flag = (key) => {
    const eq = rest.find((a) => a.startsWith(`--${key}=`));
    if (eq) return eq.slice(key.length + 3);
    const i = rest.indexOf(`--${key}`);
    return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : undefined;
  };
  const usage =
    "usage: llm-wiki-memory save-leaf --file <path> --dataset <name> " +
    "[--name <leaf.md>] [--path <dir>] [--area=…] [--atom-type=…] [--task-type=…] " +
    "[--subject=…] [--tags=…]\n";

  const file = flag("file");
  const dataset = flag("dataset");
  if (!file || !dataset) {
    process.stderr.write(usage);
    process.exit(64);
  }
  // The consent gate lives in the MCP layer, so a CLI door must not become a way
  // around it for the one category that requires an in-turn human yes.
  if (dataset === "self_improvement") {
    process.stderr.write(
      "save-leaf refuses self_improvement: that category is write-gated and needs " +
        "the MCP save_lesson tool so the consent prompt is recorded.\n",
    );
    process.exit(2);
  }

  const fs = await import("node:fs");
  const path = await import("node:path");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(
      `save-leaf: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(66);
  }
  if (!text.trim()) {
    process.stderr.write(`save-leaf: ${file} is empty\n`);
    process.exit(65);
  }

  const name = flag("name") || path.basename(file);
  const subject = flag("subject");
  const metadata = {
    ...(flag("area") ? { area: flag("area") } : {}),
    ...(flag("atom-type") ? { atom_type: flag("atom-type") } : {}),
    ...(flag("task-type") ? { task_type: flag("task-type") } : {}),
    ...(subject
      ? {
          subject: subject
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(flag("tags") ? { tags: flag("tags") } : {}),
  };
  const placementOverride = flag("path");

  const { saveDocument } = await import("./lib/wiki-store.mjs");
  const { withWikiCommit } = await import("./lib/wiki-commit.mjs");
  try {
    const res = /** @type {Record<string, unknown>} */ (
      await withWikiCommit({ op: "cli-save-leaf", actor: "cli" }, () =>
        saveDocument({
          name,
          text,
          datasetId: dataset,
          metadata,
          ...(placementOverride ? { placementOverride } : {}),
        }),
      )
    );
    out({ ok: true, bytes: Buffer.byteLength(text), ...res });
  } catch (err) {
    out({ ok: false, reason: err instanceof Error ? err.message : String(err) });
    process.exit(2);
  }
}

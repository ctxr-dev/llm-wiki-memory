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

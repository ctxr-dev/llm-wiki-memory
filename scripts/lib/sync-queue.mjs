import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Durable, crash-safe job queue for the post-git refresh (embedding warm + index
// rebuild). Jobs are detail-less per wiki: at most one PENDING per wiki
// (coalesced) plus at most one PROCESSING (a run that started before the newest
// git event). The firing hook self-drains under row-level leasing, so a lease
// that outlives a killed worker is reclaimable — nothing is lost, nothing piles up.

// 10 min — longer than any realistic single-job time (even a cold fresh-clone
// warm), so a still-running worker is never stolen; only a dead one is reclaimed.
export const LEASE_MS = 600_000;
const RETRY_BACKOFF_MS = 30_000;
const MAX_ATTEMPTS = 3;
const DRAIN_HARD_CAP = 100;

/** @typedef {{ id: number, wiki: string, mount_dir: string, state: string, enqueued_at: number, lease_until: number | null, attempts: number }} Job */

/** @param {unknown} err @returns {string} */
const sqliteCode = (err) =>
  err && typeof err === "object" ? String(/** @type {{ code?: unknown }} */ (err).code || "") : "";
/** Contention under concurrent drainer processes — expected, treated as "try later". */
const isBusy = (/** @type {unknown} */ err) => sqliteCode(err).startsWith("SQLITE_BUSY");
/** A racing pending-insert hit the one-pending-per-wiki index — already coalesced. */
const isPendingDup = (/** @type {unknown} */ err) => sqliteCode(err) === "SQLITE_CONSTRAINT_UNIQUE";

/**
 * @param {string} dbPath
 * @param {{ now?: () => number, busyTimeoutMs?: number }} [opts] injectable clock + busy timeout (tests)
 */
export function openQueue(dbPath, { now = () => Date.now(), busyTimeoutMs = 5000 } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${Number(busyTimeoutMs)}`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wiki TEXT NOT NULL,
      mount_dir TEXT NOT NULL,
      state TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      lease_until INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0
    )`,
  );
  // Schema-enforce the coalesce invariant regardless of isolation: at most one
  // PENDING row per wiki (a PROCESSING row for the same wiki is not covered).
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_pending_per_wiki ON jobs(wiki) WHERE state = 'pending'",
  );
  const q = {
    pendingForWiki: db.prepare("SELECT id FROM jobs WHERE wiki = ? AND state = 'pending' LIMIT 1"),
    insert: db.prepare(
      "INSERT INTO jobs(wiki, mount_dir, state, enqueued_at) VALUES (?, ?, 'pending', ?)",
    ),
    claimable: db.prepare(
      "SELECT * FROM jobs WHERE state = 'pending' OR (state = 'processing' AND lease_until < ?) ORDER BY enqueued_at ASC, id ASC LIMIT 1",
    ),
    lease: db.prepare(
      "UPDATE jobs SET state = 'processing', lease_until = ?, attempts = attempts + 1 WHERE id = ?",
    ),
    del: db.prepare("DELETE FROM jobs WHERE id = ?"),
    backoff: db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?"),
    countPending: db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE state = 'pending'"),
    countAll: db.prepare("SELECT COUNT(*) AS c FROM jobs"),
  };

  // `.immediate` = BEGIN IMMEDIATE — take the write lock at BEGIN so concurrent
  // drainer PROCESSES serialize (via busy_timeout) instead of racing to a
  // SQLITE_BUSY_SNAPSHOT on the deferred read snapshot.
  const enqueueTx = db.transaction((/** @type {string} */ wiki, /** @type {string} */ mountDir) => {
    if (q.pendingForWiki.get(wiki)) return false;
    q.insert.run(wiki, mountDir, now());
    return true;
  });
  const claimTx = db.transaction(() => {
    const job = /** @type {Job | undefined} */ (q.claimable.get(now()));
    if (!job) return null;
    const leaseUntil = now() + LEASE_MS;
    q.lease.run(leaseUntil, job.id);
    return { ...job, state: "processing", lease_until: leaseUntil, attempts: job.attempts + 1 };
  });

  /** @param {Job} job */
  function settleFailure(job) {
    if (job.attempts >= MAX_ATTEMPTS) {
      q.del.run(job.id);
      process.stderr.write(
        `[sync-queue] dropping poison job for ${job.wiki} after ${job.attempts} attempts\n`,
      );
      return;
    }
    q.backoff.run(now() + RETRY_BACKOFF_MS, job.id);
  }

  return {
    /** @param {string} wiki @param {string} mountDir @returns {boolean} true if enqueued, false if coalesced/contended */
    enqueue: (wiki, mountDir) => {
      try {
        return /** @type {boolean} */ (enqueueTx.immediate(wiki, mountDir));
      } catch (err) {
        if (isPendingDup(err) || isBusy(err)) return false;
        throw err;
      }
    },
    /** @returns {Job | null} */
    claim: () => {
      try {
        return /** @type {Job | null} */ (claimTx.immediate());
      } catch (err) {
        if (isBusy(err)) return null;
        throw err;
      }
    },
    /**
     * Claim + run + settle until nothing is claimable. `runJob` may be async (the
     * embedding warm is); the DB ops around it are synchronous and hold no lock
     * across the await. A failed job is backed off and skipped for the rest of
     * THIS drain (a later fire retries it). Contention or a claim error stops the
     * drain gracefully — never rejects, so the detached hook can't crash.
     * @param {(job: Job) => void | Promise<void>} runJob
     * @returns {Promise<{ processed: number, failed: number }>}
     */
    drain: async (runJob) => {
      let processed = 0;
      let failed = 0;
      /** @type {Set<number>} */
      const settled = new Set();
      for (let i = 0; i < DRAIN_HARD_CAP; i += 1) {
        let job = null;
        try {
          job = /** @type {Job | null} */ (claimTx.immediate());
        } catch (err) {
          if (!isBusy(err))
            process.stderr.write(
              `[sync-queue] claim error: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          break;
        }
        if (!job || settled.has(job.id)) break;
        try {
          await runJob(job);
          q.del.run(job.id);
          processed += 1;
        } catch {
          settleFailure(job);
          settled.add(job.id);
          failed += 1;
        }
      }
      return { processed, failed };
    },
    pendingCount: () => /** @type {{ c: number }} */ (q.countPending.get()).c,
    size: () => /** @type {{ c: number }} */ (q.countAll.get()).c,
    close: () => db.close(),
  };
}

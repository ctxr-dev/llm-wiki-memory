import fs from "node:fs";

// File-based exclusive lock with stale-owner reclaim.
//
// Two SessionStarts can spawn `compile.mjs` close together (user opens
// two terminals, agent restarts mid-session, etc). Without coordination,
// both compiles load `.compile-state.json`, mutate it independently, and
// the last writer wins - metadata_retry counters can regress and an atom
// can be promoted twice (one by each compile).
//
// This module provides a small atomic-ish file lock:
//
//   acquireLock(path) -> {ok: true, release} | {ok: false, owner, reason}
//   releaseLock(path) (only if WE own it)
//
// On contention:
//   - parse the lockfile body for `{pid, startedAt}`
//   - if the owner pid is alive AND the lock is younger than `staleMs`,
//     we lose cleanly (return ok:false)
//   - otherwise the lock is stale - reclaim it
//
// Notes:
//   - Atomic create uses `fs.openSync(path, 'wx')` which is POSIX-atomic.
//   - Stale reclaim is followed by a re-read verify: if two processes both
//     detect the same stale lock at the same instant, the loser of the
//     write race re-reads, sees a foreign pid, and returns ok:false. So
//     the rare "both detect stale" race resolves to exactly one winner,
//     same as the fast path.
//   - The primary goal - preventing the FREQUENT race of two healthy
//     compiles started by back-to-back SessionStart hooks - is fully
//     covered by the atomic-create fast path.

// 30 minutes. compile.mjs runs LLM calls (default 120s timeout each) per
// atom, plus a dedup search per atom, across N daily docs. A real run
// with several dailies of several atoms each easily exceeds 10 minutes.
// 30 minutes covers the typical case while still reclaiming a truly
// stuck/dead lock within a reasonable wait.
const DEFAULT_STALE_MS = 1_800_000;

// The fast path creates the lockfile with openSync('wx') THEN writes its body
// as separate syscalls, so a racing acquirer can momentarily observe a 0-byte
// lockfile. That window is microseconds; a 0-byte file older than this grace
// period is instead an ABANDONED lock (a writer was SIGKILLed between create
// and write) and must be reclaimed, or it would livelock every future acquirer
// forever. 5s is orders of magnitude above the real create→write gap.
const EMPTY_LOCK_GRACE_MS = 5_000;

/**
 * The parsed body of a lockfile.
 * @typedef {Object} LockBody
 * @property {number} pid
 * @property {string} startedAt - ISO timestamp.
 * @property {string} [label]
 */

/**
 * The result returned by `acquireLock`.
 * @typedef {Object} LockResult
 * @property {boolean} ok
 * @property {() => void} [release] - present on success.
 * @property {LockBody | null} [owner] - present on a refusal.
 * @property {string} [reason] - present on a refusal.
 */

/**
 * @param {unknown} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    // signal 0 is a "does this process exist + can we signal it" probe;
    // it does not actually deliver a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we can't signal it
    // (another user); for our purposes that still counts as "alive".
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/**
 * @param {string} lockPath
 * @returns {LockBody | null}
 */
function readLockBody(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} lockPath
 * @param {LockBody} body
 * @returns {void}
 */
function writeLockBody(lockPath, body) {
  // We can't use 'wx' here because callers reach this function only
  // after a stale-detection path; the lockfile might still exist.
  // Truncate-write is acceptable since stale-reclaim TOCTOU is documented.
  fs.writeFileSync(lockPath, JSON.stringify(body) + "\n");
}

/**
 * @param {string} lockPath
 * @param {{ staleMs?: number, label?: string }} [opts]
 * @returns {LockResult}
 */
export function acquireLock(lockPath, { staleMs = DEFAULT_STALE_MS, label = "compile" } = {}) {
  /** @type {LockBody} */
  const body = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    label,
  };

  // Fast path: try atomic create.
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, JSON.stringify(body) + "\n");
    fs.closeSync(fd);
    return { ok: true, release: () => releaseLock(lockPath) };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
  }

  // Lock exists. Check if owner is alive AND the lock is fresh.
  const existing = readLockBody(lockPath);
  if (existing) {
    const ageMs = Date.now() - new Date(existing.startedAt || 0).getTime();
    const alive = isProcessAlive(existing.pid);
    const stale = !alive || !Number.isFinite(ageMs) || ageMs > staleMs;
    if (!stale) {
      return {
        ok: false,
        owner: existing,
        reason: `lock held by pid=${existing.pid} (started ${existing.startedAt}, age=${Math.round(ageMs / 1000)}s)`,
      };
    }
    // Stale: log + reclaim.
    process.stderr.write(
      `${label}: replacing stale lock (pid=${existing.pid}, age=${Math.round(ageMs / 1000)}s, alive=${alive})\n`,
    );
  } else {
    // readLockBody returned null: the lockfile exists but has no valid JSON.
    // Distinguish a racing winner mid-create (0-byte + brand new → LOSE
    // cleanly; reclaiming would hand the same lock to two processes) from a
    // crash-abandoned 0-byte file or genuinely corrupt body (→ stale, reclaim).
    let raw = null;
    try {
      raw = fs.readFileSync(lockPath, "utf8");
    } catch {
      /* vanished between EEXIST and read */
    }
    if (raw !== null && raw.trim() === "") {
      let ageMs = Infinity;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        /* vanished */
      }
      // Treat as a live mid-create racer (LOSE) only when the mtime is CLOSE to
      // now in EITHER direction: |age| < grace. A just-created file can read a
      // tiny NEGATIVE age (statSync mtimeMs is a sub-ms float, Date.now() is
      // integer-truncated) or a sub-second-positive age on coarse-granularity
      // filesystems. A genuinely abandoned lock ages PAST the grace (large
      // positive); a clock-step future-date is large NEGATIVE — both fall
      // through to reclaim, so neither livelocks.
      if (Math.abs(ageMs) < EMPTY_LOCK_GRACE_MS) {
        return {
          ok: false,
          owner: null,
          reason: `lock is mid-creation by another process (empty lockfile, age=${Math.round(ageMs)}ms)`,
        };
      }
      process.stderr.write(
        `${label}: empty + stale lockfile at ${lockPath} (age=${Math.round(ageMs)}ms); reclaiming\n`,
      );
    } else {
      process.stderr.write(`${label}: lockfile at ${lockPath} is unparseable; reclaiming\n`);
    }
  }

  writeLockBody(lockPath, body);
  // Defend against the double-stale-reclaim race: two processes both
  // detect the same stale lock at the same instant and both fall through
  // here. Both writeFileSync calls run; whichever ran SECOND has its pid
  // on disk. Re-read and lose cleanly if pid no longer matches ours, so
  // exactly one of the racers proceeds. Without this check, the loser
  // would continue and a third compile arriving after the loser releases
  // could acquire while the winner is still running.
  const verify = readLockBody(lockPath);
  if (!verify || verify.pid !== process.pid) {
    return {
      ok: false,
      owner: verify,
      reason: `lost stale-reclaim race to pid=${verify ? verify.pid : "?"}`,
    };
  }
  return { ok: true, release: () => releaseLock(lockPath) };
}

/**
 * @param {string} lockPath
 * @returns {void}
 */
function releaseLock(lockPath) {
  // Only release if WE own it. Re-read to avoid clobbering a lock that
  // another process atomically claimed after us (shouldn't happen, but
  // defensive).
  const existing = readLockBody(lockPath);
  if (existing && existing.pid === process.pid) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* lock already gone - best effort */
    }
  }
}

// Wire signal + exit handlers so unexpected termination still releases.
// Caller passes the lockPath; we install one-shot handlers per path.
/** @type {Set<string>} */
const installedHandlers = new Set();
/**
 * @param {string} lockPath
 * @returns {void}
 */
export function installLockReleaseHandlers(lockPath) {
  if (installedHandlers.has(lockPath)) return;
  installedHandlers.add(lockPath);

  const release = () => releaseLock(lockPath);

  // 'exit' fires for normal exits (including process.exit calls).
  process.on("exit", release);

  // SIGINT / SIGTERM / SIGHUP: release then re-exit with the conventional
  // code. SIGHUP matters because compile.mjs is often spawned detached by
  // SessionStart hooks; closing the controlling terminal delivers SIGHUP
  // and without this the lock would leak until staleMs expires.
  /** @type {Array<[NodeJS.Signals, number]>} */
  const signalExits = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ];
  for (const [sig, code] of signalExits) {
    process.once(sig, () => {
      release();
      process.exit(code);
    });
  }
}

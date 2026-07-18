import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { openQueue, LEASE_MS } from "../scripts/lib/sync-queue.mjs";

const RETRY_BACKOFF_MS = 30_000; // mirrors the module constant
// A file:// URL, not a raw path: ESM on Windows rejects a backslashed absolute path.
const SYNC_QUEUE_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/lib/sync-queue.mjs"),
).href;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-queue-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let dbn = 0;
const freshDb = () => path.join(TMP, `q${dbn++}.sqlite`);
function clock(start = 1000) {
  const c = { t: start };
  return { now: () => c.t, advance: (/** @type {number} */ ms) => (c.t += ms) };
}

test("enqueue coalesces: a second pending job for the same wiki is skipped", () => {
  const q = openQueue(freshDb());
  assert.equal(q.enqueue("/w/A", "/m/A"), true, "first is enqueued");
  assert.equal(q.enqueue("/w/A", "/m/A"), false, "second coalesced (a pending row already exists)");
  assert.equal(q.pendingCount(), 1);
  assert.equal(q.enqueue("/w/B", "/m/B"), true, "a different wiki enqueues independently");
  assert.equal(q.pendingCount(), 2);
  q.close();
});

test("a PROCESSING job allows ONE trailing PENDING for the same wiki (<=1 pending + <=1 processing)", () => {
  const q = openQueue(freshDb());
  q.enqueue("/w/A", "/m/A");
  const job = q.claim();
  assert.equal(job?.state, "processing");
  assert.equal(q.pendingCount(), 0, "the claimed job is no longer pending");
  assert.equal(
    q.enqueue("/w/A", "/m/A"),
    true,
    "a trailing pending is allowed while one processes",
  );
  assert.equal(q.enqueue("/w/A", "/m/A"), false, "but only ONE trailing pending");
  assert.equal(q.pendingCount(), 1);
  assert.equal(q.size(), 2, "exactly one processing + one pending");
  q.close();
});

test("claim leases the job; a second claim finds nothing until the lease expires", () => {
  const c = clock();
  const q = openQueue(freshDb(), { now: c.now });
  q.enqueue("/w/A", "/m/A");
  const first = q.claim();
  assert.equal(first?.attempts, 1);
  assert.equal(q.claim(), null, "a leased job is not re-claimable while the lease holds");
  q.close();
});

test("a stale lease (a killed worker) is reclaimed after the TTL; attempts increments", () => {
  const c = clock();
  const q = openQueue(freshDb(), { now: c.now });
  q.enqueue("/w/A", "/m/A");
  const first = q.claim();
  assert.equal(first?.attempts, 1);
  c.advance(LEASE_MS + 1);
  const reclaimed = q.claim();
  assert.equal(reclaimed?.id, first?.id, "the same job is reclaimed");
  assert.equal(reclaimed?.attempts, 2, "attempts incremented on the reclaim");
  q.close();
});

test("drain claims + runs + deletes every claimable job", async () => {
  const q = openQueue(freshDb());
  q.enqueue("/w/A", "/m/A");
  q.enqueue("/w/B", "/m/B");
  /** @type {string[]} */
  const ran = [];
  const res = await q.drain((job) => ran.push(job.wiki));
  assert.deepEqual(res, { processed: 2, failed: 0 });
  assert.deepEqual(ran.sort(), ["/w/A", "/w/B"]);
  assert.equal(q.size(), 0, "all jobs settled + removed");
  q.close();
});

test("a failing job is backed off (not re-run in the same drain) and dropped after MAX_ATTEMPTS", async () => {
  const c = clock();
  const q = openQueue(freshDb(), { now: c.now });
  q.enqueue("/w/A", "/m/A");
  const boom = () => {
    throw new Error("boom");
  };
  let res = await q.drain(boom);
  assert.deepEqual(
    res,
    { processed: 0, failed: 1 },
    "one attempt, backed off (not looped this drain)",
  );
  assert.equal(q.size(), 1, "still queued after attempt 1");
  c.advance(30_001);
  res = await q.drain(boom);
  assert.equal(res.failed, 1);
  assert.equal(q.size(), 1, "still queued after attempt 2");
  c.advance(30_001);
  res = await q.drain(boom);
  assert.equal(res.failed, 1);
  assert.equal(q.size(), 0, "the poison job is dropped after MAX_ATTEMPTS");
  q.close();
});

test("two handles on the same DB: only one claims a given job (cross-connection leasing)", () => {
  const dbp = freshDb();
  const q1 = openQueue(dbp);
  const q2 = openQueue(dbp);
  q1.enqueue("/w/A", "/m/A");
  const a = q1.claim();
  const b = q2.claim();
  assert.ok(a, "the first handle claims the job");
  assert.equal(b, null, "the second handle sees it leased and claims nothing");
  q1.close();
  q2.close();
});

test("a pending job survives closing + reopening the DB (durable)", () => {
  const dbp = freshDb();
  const q1 = openQueue(dbp);
  q1.enqueue("/w/A", "/m/A");
  q1.close();
  const q2 = openQueue(dbp);
  assert.equal(q2.pendingCount(), 1, "the pending job persisted on disk");
  assert.equal(q2.claim()?.wiki, "/w/A");
  q2.close();
});

test("openQueue creates the DB file and its parent directory", () => {
  const dbp = path.join(TMP, "nested", "state", "sync-queue.sqlite");
  const q = openQueue(dbp);
  assert.ok(fs.existsSync(dbp), "the DB file (and its state/ parent) are created");
  q.close();
});

test("the partial unique index is the backstop: a raw second pending row for one wiki throws UNIQUE", () => {
  const dbp = freshDb();
  const q = openQueue(dbp);
  q.enqueue("/w/A", "/m/A");
  q.close();
  const raw = new Database(dbp);
  const insertPending = () =>
    raw
      .prepare(
        "INSERT INTO jobs(wiki, mount_dir, state, enqueued_at) VALUES ('/w/A','/m/A','pending', 1)",
      )
      .run();
  assert.throws(
    insertPending,
    (err) => /** @type {{ code?: string }} */ (err).code === "SQLITE_CONSTRAINT_UNIQUE",
    "the one-pending-per-wiki index rejects a duplicate",
  );
  raw.close();
});

test("claim/enqueue TOLERATE SQLITE_BUSY (a held write lock) — return null/false, never throw", () => {
  const dbp = freshDb();
  const q = openQueue(dbp, { busyTimeoutMs: 40 });
  q.enqueue("/w/A", "/m/A");
  const blocker = new Database(dbp);
  blocker.pragma("busy_timeout = 40");
  blocker.exec("BEGIN IMMEDIATE"); // hold the single WAL writer lock
  try {
    assert.equal(q.claim(), null, "claim under contention returns null (busy swallowed)");
    assert.equal(
      q.enqueue("/w/B", "/m/B"),
      false,
      "enqueue under contention returns false (busy swallowed)",
    );
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  q.close();
});

test("the `settled` guard prevents same-drain re-run when a backoff expires mid-drain", async () => {
  const c = clock();
  const q = openQueue(freshDb(), { now: c.now });
  q.enqueue("/w/FAIL", "/m/FAIL"); // fails -> backed off to now+30s
  q.enqueue("/w/SLOW", "/m/SLOW"); // its runJob advances the clock PAST that backoff
  /** @type {string[]} */
  const runs = [];
  await q.drain((job) => {
    runs.push(job.wiki);
    if (job.wiki === "/w/FAIL") throw new Error("boom");
    if (job.wiki === "/w/SLOW") c.advance(RETRY_BACKOFF_MS + 1);
  });
  // Without `settled`, FAIL (now claimable again) would be re-run in this same drain.
  assert.equal(runs.filter((w) => w === "/w/FAIL").length, 1, "FAIL ran exactly once");
  assert.deepEqual(runs, ["/w/FAIL", "/w/SLOW"], "no same-drain re-claim of the backed-off job");
  q.close();
});

const WORKER = path.join(TMP, "concurrency-worker.mjs");
fs.writeFileSync(
  WORKER,
  `import fs from "node:fs";
import { openQueue } from ${JSON.stringify(SYNC_QUEUE_URL)};
const [dbPath, out] = process.argv.slice(2);
const q = openQueue(dbPath);
await q.drain((job) => fs.appendFileSync(out, job.wiki + "\\n"));
q.close();
`,
);
/** @param {string} dbPath @param {string} out @returns {Promise<number|null>} */
const runWorker = (dbPath, out) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [WORKER, dbPath, out], { stdio: "ignore" });
    p.on("exit", (code) => resolve(code));
  });

test("CONCURRENCY: N worker PROCESSES draining one DB process each job exactly once, no crash", async () => {
  const dbp = freshDb();
  const q = openQueue(dbp);
  const M = 12;
  for (let i = 0; i < M; i += 1) q.enqueue(`/w/${i}`, `/m/${i}`);
  q.close();
  const outs = Array.from({ length: 4 }, (_, k) => path.join(TMP, `cc-${dbn}-${k}.txt`));
  const codes = await Promise.all(outs.map((o) => runWorker(dbp, o)));
  assert.ok(
    codes.every((code) => code === 0),
    `every worker exits 0 (no crash under contention): ${codes}`,
  );
  const processed = outs.flatMap((o) =>
    fs.existsSync(o) ? fs.readFileSync(o, "utf8").split("\n").filter(Boolean) : [],
  );
  assert.equal(processed.length, M, "each job processed exactly once (no double-lease, none lost)");
  assert.equal(new Set(processed).size, M, "no job processed twice");
  const after2 = openQueue(dbp);
  assert.equal(after2.size(), 0, "queue fully drained");
  after2.close();
});

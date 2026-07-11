import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../scripts/lib/lock.mjs";

// The file lock prevents two compiles / two flush workers from double-promoting
// or double-writing. These pin the contention outcomes — especially the 0-byte
// "racing winner mid-create" window, which previously let two processes both
// believe they held the lock.

const dirs = [];
function lockPath() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
  dirs.push(d);
  return path.join(d, "x.lock");
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("fast path: first acquire wins, a second concurrent acquire loses cleanly", () => {
  const lp = lockPath();
  const a = acquireLock(lp, { label: "t" });
  assert.equal(a.ok, true);
  const b = acquireLock(lp, { label: "t" });
  assert.equal(b.ok, false, "second acquire must lose while the first holds it");
  assert.match(b.reason, /held by pid/);
  a.release();
});

test("release lets a subsequent acquire succeed", () => {
  const lp = lockPath();
  const a = acquireLock(lp, { label: "t" });
  assert.equal(a.ok, true);
  a.release();
  assert.equal(fs.existsSync(lp), false, "release removes the lockfile");
  const b = acquireLock(lp, { label: "t" });
  assert.equal(b.ok, true, "lock is acquirable again after release");
  b.release();
});

test("EMPTY + brand-new lockfile (racing winner mid-create) → acquire LOSES cleanly, does NOT reclaim", () => {
  const lp = lockPath();
  // Simulate the window between openSync('wx') and writeSync in another
  // process: a 0-byte lockfile that was just created.
  fs.writeFileSync(lp, "");
  const r = acquireLock(lp, { label: "t" });
  assert.equal(r.ok, false, "must NOT reclaim a lock another process is mid-creating");
  assert.match(r.reason, /mid-creation/);
  // The empty file is left for the real creator to populate; we didn't clobber it.
  assert.equal(fs.readFileSync(lp, "utf8"), "", "did not overwrite the racer's lockfile");
});

test("EMPTY + aged lockfile (crash-abandoned) → reclaimed (no livelock)", () => {
  const lp = lockPath();
  fs.writeFileSync(lp, "");
  // Backdate mtime well past the empty-lock grace period.
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lp, old, old);
  const r = acquireLock(lp, { label: "t" });
  assert.equal(
    r.ok,
    true,
    "an abandoned 0-byte lock must be reclaimable, else it livelocks forever",
  );
  r.release();
});

test("EMPTY + future-dated lockfile (clock step) → reclaimed, NOT a permanent livelock", () => {
  const lp = lockPath();
  fs.writeFileSync(lp, "");
  // mtime in the future (negative age). Must NOT be mistaken for "mid-create".
  const future = new Date(Date.now() + 3_600_000);
  fs.utimesSync(lp, future, future);
  const r = acquireLock(lp, { label: "t" });
  assert.equal(r.ok, true, "a future-dated empty lock must be reclaimable, not livelock forever");
  r.release();
});

test("stale lock (dead owner pid) is reclaimed", () => {
  const lp = lockPath();
  // A non-existent pid with an old timestamp = a dead owner.
  fs.writeFileSync(
    lp,
    JSON.stringify({
      pid: 999_999,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      label: "ghost",
    }) + "\n",
  );
  const r = acquireLock(lp, { label: "t" });
  assert.equal(r.ok, true, "stale lock from a dead pid should be reclaimed");
  r.release();
});

test("non-empty corrupt lockfile body is treated as stale and reclaimed", () => {
  const lp = lockPath();
  fs.writeFileSync(lp, "{not json at all");
  const r = acquireLock(lp, { label: "t" });
  assert.equal(r.ok, true, "garbage (non-empty) lock body → stale → reclaim");
  r.release();
});

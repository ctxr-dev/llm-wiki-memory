// The SCHEDULED warm: warmWikiEmbeddingsIfDue's due-stamp, its disabled switch,
// its cross-process lock, and the two schedulers that call it (the hourly cron,
// the webapp timer).
//
// The due-stamp is keyed BY WIKI ROOT. That is the whole point of the test below
// that runs two roots: the webapp warms whichever wiki it serves while the cron
// warms the brain, so a single flat timestamp would let either starve the other
// indefinitely.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "./harness.mjs";

const { dataDir, wiki } = setupWorkspace();
const { warmWikiEmbeddingsIfDue } = await import("../scripts/lib/embed-warm.mjs");
const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");
after(() => {
  __clearSettingsForTest();
  cleanup(dataDir);
});

const STATE_PATH = path.join(dataDir, "state", ".embed-warm.json");
const LOCK_PATH = path.join(dataDir, "state", ".embed-warm.lock");

function seed(rel, focus, body) {
  const abs = path.join(wiki, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    `---\nfocus: ${focus}\nmemory:\n  atom_type: decision\n  status: active\n---\n${body}\n`,
  );
}

function clearState() {
  for (const p of [STATE_PATH, LOCK_PATH]) {
    try {
      fs.rmSync(p);
    } catch {
      /* none */
    }
  }
}

function readState() {
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

seed("knowledge/sched-a.md", "alpha", "A fact about scheduled warming.");
seed("knowledge/sched-b.md", "beta", "Another fact about scheduled warming.");

test("warmIntervalMinutes 0 disables the scheduled warm and writes no state", async () => {
  clearState();
  __setSettingsForTest({ embed: { warmIntervalMinutes: 0 } });
  const res = await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  assert.equal(res.skipped, "disabled");
  assert.equal(fs.existsSync(STATE_PATH), false, "a disabled tick stamps nothing");
});

test("no prior stamp -> runs and stamps; a second tick is not-due", async () => {
  clearState();
  __setSettingsForTest({ embed: { warmIntervalMinutes: 30 } });
  const first = await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  assert.equal(first.skipped, undefined, `first tick runs: ${JSON.stringify(first)}`);
  assert.ok(Date.parse(readState()[wiki]), "stamped under this wiki root");

  const second = await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  assert.equal(second.skipped, "not-due");
  assert.ok(Date.parse(String(second.next_due_utc)) > Date.now(), "reports when it is next due");
});

test("an ALL-WARM wiki still stamps, so a warm brain is not rechecked every tick", async () => {
  clearState();
  __setSettingsForTest({ embed: { warmIntervalMinutes: 30 } });
  await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  const stamp = readState()[wiki];
  clearState();
  const again = await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  assert.equal(again.embedded, 0, "nothing left to embed");
  assert.ok(Date.parse(readState()[wiki]), `a no-op pass stamps too (prior ${stamp})`);
});

test("backdating past the interval makes it due again", async () => {
  clearState();
  __setSettingsForTest({ embed: { warmIntervalMinutes: 30 } });
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ [wiki]: new Date(Date.now() - 60 * 60_000).toISOString() }),
  );
  const res = await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  assert.equal(res.skipped, undefined, "an hour-old stamp is past a 30-minute interval");
  assert.ok(Date.now() - Date.parse(readState()[wiki]) < 60_000, "the stamp was refreshed");
});

test("the stamp is per WIKI ROOT: one wiki being warm never starves another", async () => {
  clearState();
  __setSettingsForTest({ embed: { warmIntervalMinutes: 30 } });
  await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  const other = path.join(dataDir, "other-wiki");
  fs.mkdirSync(other, { recursive: true });
  const res = await warmWikiEmbeddingsIfDue(other, { sleep: async () => {} });
  assert.equal(res.skipped, undefined, "a different root is due even though this one just ran");
  const state = readState();
  assert.ok(state[wiki] && state[other], "both roots carry their own stamp");
});

test("a held lock makes the tick a no-op (two schedulers cannot warm at once)", async () => {
  clearState();
  __setSettingsForTest({ embed: { warmIntervalMinutes: 30 } });
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  // A live PID (this process) so the lock is held, not treated as stale.
  fs.writeFileSync(
    LOCK_PATH,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), label: "other-warm" })}\n`,
  );
  const res = await warmWikiEmbeddingsIfDue(wiki, { sleep: async () => {} });
  assert.equal(res.skipped, "locked");
  assert.equal(fs.existsSync(STATE_PATH), false, "a locked-out tick stamps nothing");
  clearState();
});

test("the webapp timer is opt-out-able and never holds the process open", async () => {
  const { startWarmTimer } = await import("../src/webapp/server/index.mjs");
  const prev = process.env.LWM_WEBAPP_NO_WARM;
  process.env.LWM_WEBAPP_NO_WARM = "1";
  assert.equal(startWarmTimer(), null, "LWM_WEBAPP_NO_WARM=1 starts no timer at all");
  delete process.env.LWM_WEBAPP_NO_WARM;
  const handle = startWarmTimer();
  assert.ok(handle && typeof handle.stop === "function", "otherwise a stoppable handle");
  handle.stop();
  if (prev !== undefined) process.env.LWM_WEBAPP_NO_WARM = prev;
});

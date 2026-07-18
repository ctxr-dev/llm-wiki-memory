import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "./harness.mjs";

const CLI = path.join(SRC, "scripts", "webapp-cli.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webapp-cli-")));
const ENTRY = path.join(TMP, "fixture-server.mjs");
const PID = path.join(TMP, "webapp", "webapp.pid");
const ENV = {
  ...process.env,
  LWM_WEBAPP_DIR: path.join(TMP, "webapp"),
  LWM_WEBAPP_SERVER_ENTRY: ENTRY,
  LWM_WEBAPP_PORT: "4711",
};

const cli = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: ENV });
const readPid = () => {
  try {
    return Number(fs.readFileSync(PID, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = (fn, ms = 3000) => {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) Atomics.wait(buf, 0, 0, 25);
  return fn();
};

before(() => fs.writeFileSync(ENTRY, "setInterval(() => {}, 1e9);\n"));
after(() => {
  cli("stop");
  const p = readPid();
  if (p) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("start launches a detached daemon (non-blocking), writes the PID, prints the URL", () => {
  const r = cli("start");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /started at http:\/\/localhost:4711/);
  assert.ok(fs.existsSync(PID), "PID file written");
  assert.ok(
    waitFor(() => isAlive(readPid())),
    "daemon is alive",
  );
});

test("a second start is refused while one is running (same PID)", () => {
  const pid = readPid();
  const r = cli("start");
  assert.match(r.stdout, /already running/);
  assert.equal(readPid(), pid, "PID unchanged");
});

test("status reports the running daemon", () => {
  const r = cli("status");
  assert.match(r.stdout, /running \(pid \d+\) at http:\/\/localhost:4711/);
});

test("stop terminates the daemon and reaps the PID file", () => {
  const pid = readPid();
  const r = cli("stop");
  assert.match(r.stdout, /stopped/);
  assert.ok(
    waitFor(() => !isAlive(pid)),
    "daemon process is dead",
  );
  assert.ok(!fs.existsSync(PID), "PID file reaped");
  assert.match(cli("status").stdout, /not running/);
});

test("restart brings the daemon back up", () => {
  const r = cli("restart");
  assert.match(r.stdout, /restarted at http:\/\/localhost:4711/);
  assert.ok(waitFor(() => isAlive(readPid())));
  cli("stop");
});

test("a stale PID file reads as not-running and does not block a start", () => {
  fs.mkdirSync(path.dirname(PID), { recursive: true });
  fs.writeFileSync(PID, "999999999");
  assert.match(cli("status").stdout, /not running/);
  const r = cli("start");
  assert.match(r.stdout, /started at/);
  assert.notEqual(readPid(), 999999999);
  cli("stop");
});

test("an unknown subcommand exits 2 with usage", () => {
  const r = cli("frobnicate");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: llm-wiki-webapp/);
});

test("--help prints usage and exits 0", () => {
  const r = cli("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /start\|stop\|restart\|status/);
});

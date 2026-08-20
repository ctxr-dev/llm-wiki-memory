import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "./harness.mjs";
import { clientBuildStale, findFreePort } from "../scripts/webapp-cli.mjs";

const CLI = path.join(SRC, "scripts", "webapp-cli.mjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webapp-cli-")));
const ENTRY = path.join(TMP, "fixture-server.mjs");
const PID = path.join(TMP, "webapp", "webapp.pid");
const ENV = {
  ...process.env,
  LWM_WEBAPP_DIR: path.join(TMP, "webapp"),
  LWM_WEBAPP_SERVER_ENTRY: ENTRY,
  LWM_WEBAPP_PORT: "4711",
  LWM_WEBAPP_OPEN: "0",
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

test("findFreePort returns a bindable port at or above the start when free", async () => {
  const port = await findFreePort(45990);
  assert.ok(port >= 45990, `expected >= 45990, got ${port}`);
});

test("findFreePort rolls past a busy port to the next free one", async () => {
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(45991, "127.0.0.1", resolve));
  try {
    const port = await findFreePort(45991);
    assert.ok(port > 45991, `expected a port above the busy 45991, got ${port}`);
  } finally {
    await new Promise((resolve) => busy.close(resolve));
  }
});

test("a busy configured port rolls the daemon to the next free one", async () => {
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(4711, "127.0.0.1", resolve));
  try {
    const r = cli("start");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /started at http:\/\/localhost:(?!4711\b)\d+/);
    assert.match(cli("status").stdout, /at http:\/\/localhost:(?!4711\b)\d+/);
  } finally {
    cli("stop");
    await new Promise((resolve) => busy.close(resolve));
  }
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

test("clientBuildStale flags a dist older than the client sources so restart rebuilds it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webapp-stale-"));
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(dir, "client"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "built");
  fs.writeFileSync(path.join(dir, "client", "App.tsx"), "source");
  const older = new Date(1_000_000_000);
  const newer = new Date(2_000_000_000);

  fs.utimesSync(path.join(dir, "dist", "index.html"), older, older);
  fs.utimesSync(path.join(dir, "client", "App.tsx"), newer, newer);
  assert.equal(clientBuildStale(dir), true, "source newer than dist => stale");

  fs.utimesSync(
    path.join(dir, "dist", "index.html"),
    new Date(3_000_000_000),
    new Date(3_000_000_000),
  );
  assert.equal(clientBuildStale(dir), false, "dist newer than source => fresh");

  fs.writeFileSync(path.join(dir, "client", "App.test.tsx"), "x");
  fs.utimesSync(
    path.join(dir, "client", "App.test.tsx"),
    new Date(4_000_000_000),
    new Date(4_000_000_000),
  );
  assert.equal(clientBuildStale(dir), false, "a newer test file does not force a rebuild");

  fs.rmSync(path.join(dir, "dist", "index.html"));
  assert.equal(clientBuildStale(dir), true, "missing dist => stale");
  fs.rmSync(dir, { recursive: true, force: true });
});

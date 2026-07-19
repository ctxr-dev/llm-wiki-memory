#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MEMORY_DATA_DIR } from "./lib/env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENTRY = path.join(HERE, "..", "src", "webapp", "server", "index.mjs");
const DEFAULT_PORT = 4319;
const STOP_GRACE_MS = 3000;

/** @returns {{ pidPath: string, logPath: string, entry: string, port: number }} */
function config() {
  const dir = process.env.LWM_WEBAPP_DIR || path.join(MEMORY_DATA_DIR, "webapp");
  return {
    pidPath: process.env.LWM_WEBAPP_PID_PATH || path.join(dir, "webapp.pid"),
    logPath: process.env.LWM_WEBAPP_LOG_PATH || path.join(dir, "logs", "server.log"),
    entry: process.env.LWM_WEBAPP_SERVER_ENTRY || DEFAULT_ENTRY,
    port: Number(process.env.LWM_WEBAPP_PORT || DEFAULT_PORT),
  };
}

/** @param {number} pid @returns {boolean} */
function alive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {{ code?: string }} */ (err).code === "EPERM";
  }
}

/** @param {string} pidPath @returns {number} */
function readPid(pidPath) {
  try {
    return Number(fs.readFileSync(pidPath, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** @param {string} p */
function rmQuiet(p) {
  try {
    fs.rmSync(p);
  } catch {
    /* absent is fine */
  }
}

/** @param {string} url */
function openBrowser(url) {
  if (process.env.LWM_WEBAPP_OPEN === "0") return;
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* opening a browser is best-effort */
  }
}

/** @param {number} pid @param {number} ms @returns {boolean} */
function waitDead(pid, ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    Atomics.wait(buf, 0, 0, 50);
  }
  return !alive(pid);
}

/** @returns {{ running: boolean, pid: number, url: string }} */
export function status() {
  const { pidPath, port } = config();
  const pid = readPid(pidPath);
  const running = alive(pid);
  return { running, pid: running ? pid : 0, url: `http://localhost:${port}` };
}

/**
 * @param {{ foreground?: boolean }} [opts]
 * @returns {{ started: boolean, pid: number, url: string, reason?: string }}
 */
export function start({ foreground = false } = {}) {
  const { pidPath, logPath, entry, port } = config();
  const url = `http://localhost:${port}`;
  const existing = readPid(pidPath);
  if (alive(existing)) return { started: false, pid: existing, url, reason: "already-running" };
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const childEnv = { ...process.env, PORT: String(port), LWM_WEBAPP_URL: url };
  if (foreground) {
    const child = spawn(process.execPath, [entry], { stdio: "inherit", env: childEnv });
    fs.writeFileSync(pidPath, String(child.pid));
    return { started: true, pid: Number(child.pid), url };
  }
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", out, out],
    env: childEnv,
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(pidPath, String(child.pid));
  openBrowser(url);
  return { started: true, pid: Number(child.pid), url };
}

/** @returns {{ stopped: boolean, pid?: number, reason?: string }} */
export function stop() {
  const { pidPath } = config();
  const pid = readPid(pidPath);
  if (!alive(pid)) {
    rmQuiet(pidPath);
    return { stopped: false, reason: "not-running" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  if (!waitDead(pid, STOP_GRACE_MS)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    waitDead(pid, 1000);
  }
  rmQuiet(pidPath);
  return { stopped: true, pid };
}

/** @param {{ foreground?: boolean }} [opts] */
export function restart(opts) {
  stop();
  return start(opts);
}

const USAGE = "Usage: llm-wiki-webapp <start|stop|restart|status> [--foreground] [--port <n>]";

/** @param {string[]} argv @returns {number} */
export function run(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (argv.includes("--port")) {
    const v = argv[argv.indexOf("--port") + 1];
    if (v) process.env.LWM_WEBAPP_PORT = v;
  }
  const foreground = argv.includes("--foreground");
  const cmd = argv.find((a) => !a.startsWith("-"));
  switch (cmd) {
    case "start": {
      const r = start({ foreground });
      process.stdout.write(
        r.started
          ? `llm-wiki-webapp started at ${r.url} (pid ${r.pid})\n`
          : `already running (pid ${r.pid}) at ${r.url}\n`,
      );
      return 0;
    }
    case "stop": {
      const r = stop();
      process.stdout.write(r.stopped ? `stopped (pid ${r.pid})\n` : "not running\n");
      return 0;
    }
    case "restart": {
      const r = restart({ foreground });
      process.stdout.write(`llm-wiki-webapp restarted at ${r.url} (pid ${r.pid})\n`);
      return 0;
    }
    case "status": {
      const r = status();
      process.stdout.write(r.running ? `running (pid ${r.pid}) at ${r.url}\n` : "not running\n");
      return 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}

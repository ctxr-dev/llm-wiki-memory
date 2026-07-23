#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MEMORY_DATA_DIR, envInt } from "./lib/env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENTRY = path.join(HERE, "..", "src", "webapp", "server", "index.mjs");
const DEFAULT_PORT = 4319;
const MAX_PORT_PROBES = 50;
const STOP_GRACE_MS = 3000;

/** @returns {{ pidPath: string, portPath: string, logPath: string, entry: string, port: number }} */
function config() {
  const dir = process.env.LWM_WEBAPP_DIR || path.join(MEMORY_DATA_DIR, "webapp");
  return {
    pidPath: process.env.LWM_WEBAPP_PID_PATH || path.join(dir, "webapp.pid"),
    portPath: process.env.LWM_WEBAPP_PORT_PATH || path.join(dir, "webapp.port"),
    logPath: process.env.LWM_WEBAPP_LOG_PATH || path.join(dir, "logs", "server.log"),
    entry: process.env.LWM_WEBAPP_SERVER_ENTRY || DEFAULT_ENTRY,
    port: envInt("LWM_WEBAPP_PORT", DEFAULT_PORT),
  };
}

/**
 * Resolve the first free TCP port at or above `startPort` on the loopback host,
 * so a busy configured port transparently rolls to the next one. There is a tiny
 * window between the probe closing and the server binding; the caller writes the
 * resolved port to disk so `status`/the opened URL always reflect the real port.
 * @param {number} startPort
 * @param {number} [maxProbes]
 * @returns {Promise<number>}
 */
export function findFreePort(startPort, maxProbes = MAX_PORT_PROBES) {
  const host = process.env.LWM_WEBAPP_HOST || "127.0.0.1";
  return new Promise((resolve, reject) => {
    let port = startPort;
    let probes = 0;
    const probe = () => {
      const srv = net.createServer();
      srv.once("error", (err) => {
        srv.close();
        if (/** @type {{ code?: string }} */ (err).code === "EADDRINUSE" && probes < maxProbes) {
          probes += 1;
          port += 1;
          probe();
        } else {
          reject(err);
        }
      });
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, host);
    };
    probe();
  });
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

/** @param {string} portPath @returns {number} */
function readPort(portPath) {
  try {
    return Number(fs.readFileSync(portPath, "utf8").trim()) || 0;
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

const SOURCE_DIRS = ["client", "server", "shared"];
const SOURCE_FILES = ["package.json", "vite.config.ts", "tailwind.config.js", "index.html"];

/** @param {string} dir @returns {number} */
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    if (entry.name.startsWith(".") || entry.name.includes(".test.")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* skip a vanished file */
      }
    }
  }
  return newest;
}

/** @param {string} webappDir @returns {boolean} */
export function clientBuildStale(webappDir) {
  let built;
  try {
    built = fs.statSync(path.join(webappDir, "dist", "index.html")).mtimeMs;
  } catch {
    return true;
  }
  const dirTimes = SOURCE_DIRS.map((dir) => newestMtime(path.join(webappDir, dir)));
  const fileTimes = SOURCE_FILES.map((file) => {
    try {
      return fs.statSync(path.join(webappDir, file)).mtimeMs;
    } catch {
      return 0;
    }
  });
  return Math.max(...dirTimes, ...fileTimes) > built;
}

/** @param {string} entry */
function ensureBuilt(entry) {
  const webappDir = path.dirname(path.dirname(entry));
  if (!fs.existsSync(path.join(webappDir, "package.json"))) return;
  if (!clientBuildStale(webappDir)) return;
  process.stdout.write("building the web client (sources changed)…\n");
  const result = spawnSync("npm", ["run", "build"], { cwd: webappDir, stdio: "ignore" });
  if (result.status !== 0) process.stdout.write("client build failed; serving the existing dist\n");
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
  const { pidPath, portPath, port } = config();
  const pid = readPid(pidPath);
  const running = alive(pid);
  const actualPort = readPort(portPath) || port;
  return { running, pid: running ? pid : 0, url: `http://localhost:${actualPort}` };
}

/**
 * @param {{ foreground?: boolean }} [opts]
 * @returns {Promise<{ started: boolean, pid: number, url: string, reason?: string }>}
 */
export async function start({ foreground = false } = {}) {
  const { pidPath, portPath, logPath, entry, port } = config();
  const existing = readPid(pidPath);
  if (alive(existing)) {
    const url = `http://localhost:${readPort(portPath) || port}`;
    return { started: false, pid: existing, url, reason: "already-running" };
  }
  ensureBuilt(entry);
  const freePort = await findFreePort(port);
  const url = `http://localhost:${freePort}`;
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(portPath, String(freePort));
  const childEnv = { ...process.env, PORT: String(freePort), LWM_WEBAPP_URL: url };
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
  const { pidPath, portPath } = config();
  const pid = readPid(pidPath);
  if (!alive(pid)) {
    rmQuiet(pidPath);
    rmQuiet(portPath);
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
  rmQuiet(portPath);
  return { stopped: true, pid };
}

/**
 * @param {{ foreground?: boolean }} [opts]
 * @returns {Promise<{ started: boolean, pid: number, url: string, reason?: string }>}
 */
export function restart(opts) {
  stop();
  return start(opts);
}

const USAGE = "Usage: llm-wiki-webapp <start|stop|restart|status> [--foreground] [--port <n>]";

/** @param {string[]} argv @returns {Promise<number>} */
export async function run(argv) {
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
      const r = await start({ foreground });
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
      const r = await restart({ foreground });
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
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`llm-wiki-webapp: ${error?.message || error}\n`);
      process.exit(1);
    },
  );
}

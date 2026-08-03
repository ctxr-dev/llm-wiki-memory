// Process-level diagnostics for the long-lived entrypoints.
//
// Node terminates on an escaped async rejection. In the stdio MCP server that removed the
// user's memory tools mid-session with a bare stack on a stream nobody reads; in the embed
// worker it killed the thread, which rejects every in-flight embed and drops the whole
// process to lexical for 30s. Neither left a durable record.
//
// Driven as real child processes, because that is the only way to observe an exit code and a
// process that survives.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = path.join(SRC, "scripts/lib/fatal-guard.mjs");

/**
 * Runs a snippet in a child with an isolated data dir, so a capture cannot touch real state.
 * `keepDir` leaves the workspace behind so the monitoring store can be inspected.
 * @param {string} body @param {{ keepDir?: boolean }} [opts]
 * @returns {{ status: number | null, stdout: string, stderr: string, dataDir: string }}
 */
function runChild(body, { keepDir = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-fatal-"));
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    cwd: SRC,
    env: { ...process.env, MEMORY_DATA_DIR: dataDir, LWM_REAL_BRAIN: "", NODE_TEST_CONTEXT: "" },
    encoding: "utf8",
  });
  if (!keepDir) fs.rmSync(dataDir, { recursive: true, force: true });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", dataDir };
}

/** Every capture file the child wrote. @param {string} dataDir @returns {string[]} */
function capturesUnder(dataDir) {
  /** @type {string[]} */
  const found = [];
  const walk = (dir) => {
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) walk(abs);
      else if (it.name.endsWith(".md")) found.push(abs);
    }
  };
  walk(path.join(dataDir, "monitoring"));
  return found;
}

test("an unhandled rejection is REPORTED and the process keeps running", () => {
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    Promise.reject(new Error("escaped rejection"));
    await new Promise((r) => setTimeout(r, 120));
    process.stdout.write("STILL-ALIVE");
  `);
  assert.equal(r.status, 0, `must survive; stderr: ${r.stderr}`);
  assert.match(r.stdout, /STILL-ALIVE/, "execution continued past the rejection");
  assert.match(r.stderr, /probe: unhandledRejection/, "reported, naming the process");
  assert.match(r.stderr, /escaped rejection/, "and carrying the detail");
});

test("stdout is never written to — it is the JSON-RPC channel", () => {
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    Promise.reject(new Error("must not reach stdout"));
    await new Promise((r) => setTimeout(r, 120));
  `);
  assert.equal(r.stdout, "", `stdout must stay clean, got: ${r.stdout}`);
  assert.match(r.stderr, /must not reach stdout/, "the diagnostic went to stderr");
});

test("a repeating rejection CAPTURES once per signature, not once per occurrence", () => {
  // Every occurrence gets a stderr line (that is the guaranteed channel); the CAPTURE is what
  // is deduped, and that is what keeps the monitoring store usable when something rejects on
  // every tick. Asserting only the stderr lines would leave the dedup untested.
  const r = runChild(
    `
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    for (let i = 0; i < 5; i += 1) Promise.reject(new Error("same failure every tick"));
    await new Promise((r) => setTimeout(r, 400));
  `,
    { keepDir: true },
  );
  try {
    assert.equal(r.status, 0, "still alive after five");
    assert.equal(
      [...r.stderr.matchAll(/probe: unhandledRejection/g)].length,
      5,
      "each occurrence is visible on stderr",
    );
    const captures = capturesUnder(r.dataDir);
    assert.equal(captures.length, 1, `one capture for one signature, got ${captures.length}`);
  } finally {
    fs.rmSync(r.dataDir, { recursive: true, force: true });
  }
});

test("two DIFFERENT signatures each get their own capture", () => {
  const r = runChild(
    `
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    Promise.reject(new Error("first distinct failure"));
    Promise.reject(new Error("second unrelated failure"));
    await new Promise((r) => setTimeout(r, 400));
  `,
    { keepDir: true },
  );
  try {
    assert.equal(capturesUnder(r.dataDir).length, 2, "dedup is per signature, not global");
  } finally {
    fs.rmSync(r.dataDir, { recursive: true, force: true });
  }
});

test("an uncaught exception exits 70 (EX_SOFTWARE), not the overloaded 1", () => {
  // 1 cannot distinguish a clean refusal from an engine crash — a dozen commands use it for
  // ordinary rejections, and it is what an unhandled rejection produced before this.
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    setTimeout(() => { throw new Error("boom, unwound"); }, 10);
    await new Promise((r) => setTimeout(r, 400));
  `);
  assert.equal(r.status, 70, `expected EX_SOFTWARE; stderr: ${r.stderr}`);
  assert.match(r.stderr, /probe: uncaughtException/);
});

test("installFatalGuard is idempotent — two calls do not double-report", () => {
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    installFatalGuard("probe");
    Promise.reject(new Error("single line please"));
    await new Promise((r) => setTimeout(r, 120));
  `);
  const lines = [...r.stderr.matchAll(/probe: unhandledRejection/g)];
  assert.equal(lines.length, 1, `one handler, one line; got ${lines.length}`);
});

test("a non-Error rejection value is still reported without throwing", () => {
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    Promise.reject("a bare string");
    Promise.reject(undefined);
    await new Promise((r) => setTimeout(r, 150));
    process.stdout.write("SURVIVED");
  `);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SURVIVED/, "the handler itself must never throw");
  assert.match(r.stderr, /a bare string/);
});

test("a NON-SERIALIZABLE rejection value cannot invert the policy", () => {
  // JSON.stringify throws on a circular object, and it ran as the FIRST statement of the
  // handler — so the throw escaped and killed the process the guard exists to keep alive,
  // reporting nothing about the original value.
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    const circular = { name: "loop" };
    circular.self = circular;
    Promise.reject(circular);
    await new Promise((r) => setTimeout(r, 150));
    process.stdout.write("SURVIVED");
  `);
  assert.equal(r.status, 0, `must survive a circular value; stderr: ${r.stderr}`);
  assert.match(r.stdout, /SURVIVED/);
  assert.match(r.stderr, /probe: unhandledRejection/, "and the value is still described");
});

test("a NON-SERIALIZABLE thrown value still exits 70 and still runs the exit hooks", () => {
  // The worse half: a throwing describe() made this Node-fatal at exit 7, which SKIPS
  // process.on("exit") — so a wiki batch went unflushed and a lock stayed held, the one outcome
  // those hooks exist to prevent, and worse than the pre-change default of exit 1 WITH hooks.
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    process.on("exit", (c) => process.stdout.write("EXIT-HOOK-RAN:" + c));
    setTimeout(() => { const c = {}; c.self = c; throw c; }, 10);
    await new Promise((r) => setTimeout(r, 400));
  `);
  assert.equal(r.status, 70, `expected EX_SOFTWARE, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /EXIT-HOOK-RAN:70/, "the exit hooks MUST still run");
});

test("the uncaughtException path writes a capture before exiting", () => {
  // It previously started a lazy import that process.exit abandoned, so the one path the
  // module header says left "nothing to diagnose" wrote nothing at all.
  const r = runChild(
    `
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe");
    setTimeout(() => { throw new Error("fatal with a record"); }, 10);
    await new Promise((r) => setTimeout(r, 400));
  `,
    { keepDir: true },
  );
  try {
    assert.equal(r.status, 70);
    assert.equal(capturesUnder(r.dataDir).length, 1, "the exception is recorded, not just logged");
  } finally {
    fs.rmSync(r.dataDir, { recursive: true, force: true });
  }
});

test("a WORKER installs rejection handling only, so the parent still sees the cause", () => {
  // Handling an exception in-thread consumes it: the parent's worker.on("error") never fires
  // and the real cause is replaced by a synthetic "worker exited (code N)".
  const worker = fs.readFileSync(path.join(SRC, "scripts/lib/embed-worker.mjs"), "utf8");
  assert.match(
    worker,
    /installFatalGuard\("embed-worker",\s*\{\s*catchExceptions:\s*false\s*\}\)/,
    "the worker must opt out of exception handling",
  );
  const r = runChild(`
    const { installFatalGuard } = await import(${JSON.stringify(GUARD)});
    installFatalGuard("probe", { catchExceptions: false });
    Promise.reject(new Error("rejection is still handled"));
    await new Promise((r) => setTimeout(r, 120));
    process.stdout.write("ALIVE-AFTER-REJECTION");
    setTimeout(() => { throw new Error("exception propagates"); }, 5);
    await new Promise((r) => setTimeout(r, 200));
  `);
  assert.match(r.stdout, /ALIVE-AFTER-REJECTION/, "rejections are still absorbed");
  assert.notEqual(r.status, 70, "an exception is NOT swallowed into a 70 exit");
  assert.match(r.stderr, /exception propagates/, "it propagates with its real cause");
});

test("the MCP server installs it — a rejection does not take the server down", () => {
  // The whole point: this is the process whose death removes the user's memory tools.
  const body = fs.readFileSync(path.join(SRC, "mcp-server/index.mjs"), "utf8");
  assert.match(body, /installFatalGuard\("mcp-server"\)/, "the server arms the guard");
  const worker = fs.readFileSync(path.join(SRC, "scripts/lib/embed-worker.mjs"), "utf8");
  // Its exact option shape is pinned by the dedicated worker test above.
  assert.match(worker, /installFatalGuard\("embed-worker"/, "the worker thread arms it too");
  // The webapp daemon is the third entrypoint the module header names, and src/webapp is
  // excluded from jsconfig.json, so tsc never checks that import either.
  const webapp = fs.readFileSync(path.join(SRC, "src/webapp/server/index.mjs"), "utf8");
  assert.match(webapp, /installFatalGuard\("webapp-server"\)/, "the webapp daemon arms it");
});

test("hooks and the one-shot CLI deliberately do NOT install it", () => {
  // Eight hook wrappers run under `set -euo pipefail` with a bare `node` last, so node's
  // exit code IS the hook's, and a capture hook must always exit 0. Two PreToolUse hooks also
  // fail in deliberately OPPOSITE directions, which a uniform handler would flatten.
  for (const rel of [
    "scripts/cli.mjs",
    "scripts/hooks/flush.mjs",
    "scripts/hooks/session-start.mjs",
  ]) {
    const body = fs.readFileSync(path.join(SRC, rel), "utf8");
    assert.doesNotMatch(body, /installFatalGuard/, `${rel} must own its own failure policy`);
  }
});

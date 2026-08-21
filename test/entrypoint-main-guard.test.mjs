// GATE: every CLI entrypoint must run when launched through a symlinked path.
//
// Node resolves `import.meta.url` to the PHYSICAL path but leaves `process.argv[1]` exactly as
// typed. Every entrypoint here used to decide "was I run directly?" by comparing the two, so any
// launch path containing a symlink made them disagree and the script silently did nothing while
// exiting 0 — success and total failure were byte-identical. It reproduced through a symlinked
// install dir, an `npm link` / `npm i -g` bin shim, and every Windows launch. The worst case was
// the MCP server: it exited 0 before the handshake, so every memory tool vanished with no error.
//
// `import.meta.main` is the fix — Node answers the question itself, identically across a real
// path, a symlinked dir, a bin shim, and `--preserve-symlinks-main`. It is true for exactly what
// Node was HANDED as the entry: argv[1], the `-e`/stdin source TEXT, or a Worker's entry module.
// An imported file is never main regardless of how its importer was launched, so the `-e`
// inversion is unreachable for these files; a Worker entry, however, would be main.
//
// The entrypoint list is DERIVED, never hand-written: a hard-coded list silently stops covering
// the 30th entrypoint someone adds.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isNodeVersionBelowFloor } from "../scripts/lib/node-floor.mjs";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["scripts", "mcp-server", "src/webapp/server"];

// The pre-fix idiom, in all six dialects it was written in. A line qualifies only when it
// COMPARES argv[1] against the module's own identity — `process.argv[1]` alone does not, because
// embed-cache-io.mjs legitimately uses it as a diagnostic label naming the offending process.
const OLD_GUARD_LINE = /process\.argv\[1\]/;
const SELF_IDENTITY = /import\.meta\.url|fileURLToPath|SELF_PATH/;
const NEW_GUARD = /import\.meta\.main/;

/** @param {string} dir @returns {string[]} absolute paths of every .mjs under dir, recursively */
function mjsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...mjsFiles(abs));
      continue;
    }
    if (entry.name.endsWith(".mjs")) out.push(abs);
  }
  return out;
}

/** @param {string} body @returns {boolean} */
function hasOldGuard(body) {
  return body.split("\n").some((line) => OLD_GUARD_LINE.test(line) && SELF_IDENTITY.test(line));
}

// A file is an entrypoint if it decides whether to run itself — by either idiom, so this same
// derivation is valid before and after the migration.
/** @returns {string[]} repo-relative paths, sorted */
function entrypoints() {
  /** @type {string[]} */
  const found = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of mjsFiles(path.join(SRC_DIR, root))) {
      const body = fs.readFileSync(abs, "utf8");
      if (NEW_GUARD.test(body) || hasOldGuard(body)) {
        found.push(path.relative(SRC_DIR, abs).split(path.sep).join("/"));
      }
    }
  }
  return found.sort();
}

// A temp dir whose realpath differs from its own path, so a launch through it exercises the bug.
// On macOS /tmp is itself a symlink to /private/tmp, which is why the alias is asserted rather
// than assumed: if it ever collapsed, every test below would pass vacuously.
/** @returns {{ link: string, cleanup: () => void }} */
function symlinkedSrc() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-entrypoint-"));
  const link = path.join(base, "srclink");
  // "junction", not "dir": a plain directory symlink needs Administrator or Developer Mode on
  // Windows, so a "dir" link EPERMs there — on the very platform whose launches motivated this
  // gate. Junctions need no elevation and `fs.realpathSync` resolves them, so the alias
  // precondition below still holds. Matches test/e2e/bootstrap-drive.mjs and test/path-equal.test.mjs.
  fs.symlinkSync(SRC_DIR, link, "junction");
  assert.notEqual(link, fs.realpathSync(link), "fixture is not a symlink alias");
  return { link, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// MEMORY_DATA_DIR must point somewhere disposable. NODE_TEST_CONTEXT is inherited by every child,
// and real-brain-guard.mjs correctly refuses to let an engine module open the real workspace brain
// from a test context — so without this, the engine-importing probes throw at module load and the
// differential below compares two identical crashes instead of the guard's behaviour.
/** @param {string} script @param {string[]} args @param {string} dataDir @returns {{status:number|null, stdout:string, stderr:string}} */
function run(script, args, dataDir) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MEMORY_DATA_DIR: dataDir },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// One side-effect-free invocation per dialect. Each either prints to stdout or refuses with a
// usage message; none writes to a wiki, binds a port, or runs a hook. flush.mjs (the SELF_PATH
// dialect) has no safe direct invocation — it would run a real capture hook — so it is covered by
// the uniformity test instead.
// `exit` is the code the DIRECT launch must produce. Pinning it is what makes the differential
// trustworthy: a probe that crashes identically both ways would otherwise satisfy a bare
// direct-vs-symlinked comparison while proving nothing.
const PROBES = [
  { what: "IIFE + try/catch", script: "scripts/lib/cron-path.mjs", args: [], exit: 0 },
  { what: "argv[1] || ''", script: "scripts/bootstrap/ws-hash.mjs", args: ["/tmp/demo"], exit: 0 },
  { what: "bare pathToFileURL", script: "scripts/cli.mjs", args: ["--help"], exit: 0 },
  { what: "bare, second surface", script: "scripts/webapp-cli.mjs", args: ["--help"], exit: 0 },
  // Reads its data dir from MEMORY_DATA_DIR (the temp dir run() injects) and reports
  // "no-settings-dir" without writing anything. Do NOT pass --dry-run here: it would be read as
  // argv[2], i.e. as the data-dir path.
  { what: "inverted fileURLToPath", script: "scripts/migrate-settings.mjs", args: [], exit: 0 },
  {
    what: "resolve + coalesce",
    script: "scripts/migrate-from-manifest.mjs",
    args: ["--help"],
    exit: 0,
  },
];

test("a symlinked launch behaves identically to a direct launch", () => {
  const { link, cleanup } = symlinkedSrc();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-entrypoint-data-"));
  try {
    /** @type {string[]} */
    const broken = [];
    const combined = (/** @type {{stdout:string,stderr:string}} */ r) => r.stdout + r.stderr;
    for (const { what, script, args, exit } of PROBES) {
      const direct = run(path.join(SRC_DIR, script), args, dataDir);
      assert.equal(
        direct.status,
        exit,
        `${script} did not behave as expected even on a DIRECT launch, so the ` +
          `comparison below would be meaningless: ${combined(direct).slice(0, 400)}`,
      );
      assert.notEqual(combined(direct), "", `${script} produced no output even directly`);
      const linked = run(path.join(link, script), args, dataDir);
      if (combined(linked) !== combined(direct) || linked.status !== direct.status) {
        broken.push(
          `${script} (${what}): direct exit=${direct.status} ${combined(direct).length}B, ` +
            `symlinked exit=${linked.status} ${combined(linked).length}B`,
        );
      }
    }
    assert.deepEqual(broken, [], "entrypoints that silently do nothing via a symlinked path");
  } finally {
    cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// The other half of the contract, and the reason the guard exists at all: a guard that runs too
// EAGERLY is worse than one that never runs. Importing these modules must stay inert — 12 test
// files import flush.mjs, the webapp suites import the server module (which would bind a port),
// and two import register-global.mjs / unregister-global.mjs (which would rewrite ~/.claude.json).
// Generalises the single existing tripwire in test/cron-path.test.mjs to every entrypoint.
test("importing an entrypoint has no side effects", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-entrypoint-import-"));
  try {
    /** @type {string[]} */
    const noisy = [];
    for (const rel of entrypoints()) {
      const abs = path.join(SRC_DIR, rel);
      const r = spawnSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(pathToFileURL(abs).href)}).then(() => {})`],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, MEMORY_DATA_DIR: dataDir },
        },
      );
      if (r.status !== 0)
        noisy.push(`${rel}: exit ${r.status} — ${(r.stderr ?? "").slice(0, 200)}`);
      else if ((r.stdout ?? "") !== "")
        noisy.push(`${rel}: wrote stdout — ${r.stdout.slice(0, 120)}`);
    }
    assert.deepEqual(noisy, [], "entrypoints that do something merely by being imported");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("every entrypoint uses import.meta.main and none keeps the path comparison", () => {
  /** @type {string[]} */
  const stale = [];
  for (const rel of entrypoints()) {
    const body = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
    if (!NEW_GUARD.test(body)) stale.push(`${rel}: no import.meta.main`);
    if (hasOldGuard(body)) stale.push(`${rel}: still compares process.argv[1]`);
  }
  assert.deepEqual(stale, [], "entrypoints still using the symlink-fragile guard");
});

test("the version floor comparison is correct at its boundaries", () => {
  const below = ["20.19.5", "21.7.3", "22.0.0", "22.17.9", "22.17.0", "18.0.0"];
  const atOrAbove = ["22.18.0", "22.18.1", "22.22.2", "23.0.0", "24.2.0", "25.9.0"];
  for (const v of below) {
    assert.equal(isNodeVersionBelowFloor(v), true, `${v} must count as below the floor`);
  }
  for (const v of atOrAbove) {
    assert.equal(isNodeVersionBelowFloor(v), false, `${v} must NOT count as below the floor`);
  }
  // A pre-release suffix must compare on its numeric core, not lexically.
  assert.equal(isNodeVersionBelowFloor("22.17.0-nightly"), true);
  assert.equal(isNodeVersionBelowFloor("24.0.0-nightly"), false);
});

// Evaluates node-floor's OWN source with substitutions, which is the only faithful way to simulate
// the two below-floor scenarios. Importing it and redefining the CALLER's `import.meta` proves
// nothing: `belowFloor()` reads the property of the module it is written in, not the caller's.
const FEATURE_TEST = 'typeof import.meta.main !== "boolean"';
/** @param {Array<[string,string]>} replacements @returns {{status:number|null,stdout:string,stderr:string}} */
function runFloorSource(replacements) {
  let src = fs.readFileSync(path.join(SRC_DIR, "scripts/lib/node-floor.mjs"), "utf8");
  for (const [from, to] of replacements) {
    assert.ok(
      src.includes(from),
      `node-floor.mjs no longer contains \`${from}\` — update this test`,
    );
    src = src.split(from).join(to);
  }
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `${src}\nrefuseBelowNodeFloor();\nprocess.stdout.write("survived");`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// A SUPPORTED Node whose `import.meta.main` was erased by a bundler must NOT be refused.
// Vite/Vitest's SSR transform rewrites `import.meta` into a synthesised object holding only
// { url, env, filename, dirname }, so a feature-test-only predicate reads `undefined` and would
// exit(78) inside a vitest worker on a perfectly good Node. "Old Node" and "transformed source"
// are indistinguishable through that property, which is why the version is consulted too.
test("a bundler erasing import.meta.main does NOT trigger the floor on a supported Node", () => {
  const r = runFloorSource([[FEATURE_TEST, "true"]]);
  assert.equal(r.status, 0, `floor must not refuse a supported Node: ${r.stderr.slice(0, 300)}`);
  assert.equal(r.stdout, "survived");
  assert.equal(r.stderr, "");
});

// A genuinely below-floor Node must be refused loudly — otherwise every guard is falsy and each
// command exits 0 in silence, which is the failure this whole change removes. `engines` does not
// prevent it: npm enforces it only under engine-strict.
test("a genuinely below-floor Node is refused, not silently ignored", () => {
  const r = runFloorSource([
    [FEATURE_TEST, "true"],
    ["process.versions.node", '"20.19.0"'],
  ]);
  assert.equal(r.status, 78, `below-floor Node must exit EX_CONFIG(78): ${r.stderr.slice(0, 200)}`);
  assert.match(r.stderr, /22\.18\.0/, "the refusal must name the required version");
  assert.equal(r.stdout, "", "the refusal goes to stderr — stdout is JSON-RPC on the server");
});

// Containment: the floor calls process.exit at the caller's request, so an accidental import into
// a shared lib (env.mjs, wiki-store.mjs) or into the webapp graph would put that exit inside the
// vitest workers. Only the surfaces that own a launch policy may reference it.
test("only the entrypoints that own a launch policy import the Node floor", () => {
  const allowed = new Set([
    "scripts/cli.mjs",
    "mcp-server/index.mjs",
    "scripts/hooks/flush.mjs",
    "scripts/hooks/exit-plan-mode.mjs",
    "scripts/hooks/sync-embeddings.mjs",
    "scripts/lib/node-floor.mjs",
  ]);
  /** @type {string[]} */
  const unexpected = [];
  for (const root of SCAN_ROOTS) {
    for (const abs of mjsFiles(path.join(SRC_DIR, root))) {
      const rel = path.relative(SRC_DIR, abs).split(path.sep).join("/");
      if (allowed.has(rel)) continue;
      if (fs.readFileSync(abs, "utf8").includes("node-floor.mjs")) unexpected.push(rel);
    }
  }
  assert.deepEqual(unexpected, [], "unexpected importers of node-floor.mjs (see the test comment)");
});

test("the CLI and the server refuse below the floor; the hooks only warn", () => {
  for (const rel of ["scripts/cli.mjs", "mcp-server/index.mjs"]) {
    const body = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
    assert.match(body, /^refuseBelowNodeFloor\(\);$/m, `${rel} must refuse below the floor`);
  }
  // A capture hook must always exit 0 and never block a session, so it may only warn.
  for (const rel of [
    "scripts/hooks/flush.mjs",
    "scripts/hooks/exit-plan-mode.mjs",
    "scripts/hooks/sync-embeddings.mjs",
  ]) {
    const body = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
    assert.match(body, /^warnBelowNodeFloor\("/m, `${rel} must warn below the floor`);
    assert.doesNotMatch(body, /refuseBelowNodeFloor/, `${rel} must NOT exit non-zero`);
  }
});

// Both bootstrap scripts feature-test the same property before shelling out to any guarded .mjs.
// Pinned because nothing else asserts their probe, and because it must sit ABOVE the uninstall
// path: unregister-global.mjs and uninstall.mjs are themselves guarded, so a below-floor
// `--uninstall` otherwise printed "Uninstall complete" while removing nothing at all.
test("both bootstrap scripts check the Node floor before the uninstall path", () => {
  for (const [name, uninstallMarker] of [
    ["bootstrap.sh", '"$UNINSTALL" -eq 1'],
    ["bootstrap.ps1", "if ($Uninstall) {"],
  ]) {
    const body = fs.readFileSync(path.join(SRC_DIR, name), "utf8");
    const probe = body.indexOf("import.meta.main === undefined");
    const uninstall = body.indexOf(uninstallMarker);
    assert.ok(probe >= 0, `${name} must feature-test import.meta.main`);
    assert.ok(uninstall >= 0, `${name} uninstall marker not found — update this test`);
    assert.ok(probe < uninstall, `${name} must check the floor BEFORE its uninstall path`);
    // No quote characters in the probe: Windows PowerShell 5.1 mangles embedded double quotes
    // when building a native command line, which would reject a perfectly good Node.
    const line = body.split("\n").find((l) => l.includes("import.meta.main === undefined")) ?? "";
    assert.doesNotMatch(line, /"/, `${name}'s probe must contain no double quotes`);
  }
});

test("the derivation finds every entrypoint and excludes non-guards", () => {
  const found = entrypoints();
  // A floor, not an exact count: adding an entrypoint must not silently shrink this gate's reach.
  assert.ok(found.length >= 29, `expected >=29 entrypoints, found ${found.length}`);
  assert.ok(found.includes("mcp-server/index.mjs"), "mcp-server must be covered");
  assert.ok(found.includes("src/webapp/server/index.mjs"), "webapp server must be covered");
  // Uses process.argv[1] as a diagnostic label only; it decides nothing and must never be rewritten.
  assert.ok(
    !found.includes("scripts/lib/embed-cache-io.mjs"),
    "embed-cache-io.mjs is not an entrypoint — its argv[1] names the offending process in a warning",
  );
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCliScopes, stripScopesArgs, withScopeContext } from "../scripts/cli-scopes.mjs";
import { getActiveWikiContext } from "../scripts/lib/wiki-context.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(SRC, "scripts", "cli.mjs");
const SKILL_CLI = path.join(SRC, "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs");
const SHARED_LAYOUT = "layout:\n  - path: knowledge\n  - path: daily\n";

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function mkMount(dir) {
  const layoutDir = path.join(dir, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(layoutDir, { recursive: true });
  fs.writeFileSync(path.join(layoutDir, "layout.yaml"), SHARED_LAYOUT);
  return dir;
}

function brainOpts(home) {
  return { home, brainDataDir: path.join(home, ".llm-wiki-memory") };
}

// ── resolveCliScopes ────────────────────────────────────────────────────────

test("resolveCliScopes: --scopes with a comma list yields the split paths", () => {
  assert.deepEqual(resolveCliScopes(["--scopes", "/a,/b"]), ["/a", "/b"]);
});

test("resolveCliScopes: --scopes value splits on whitespace as well as commas", () => {
  assert.deepEqual(resolveCliScopes(["--scopes", "/a /b,/c"]), ["/a", "/b", "/c"]);
});

test("resolveCliScopes: the --scopes=<value> equals form is accepted", () => {
  assert.deepEqual(resolveCliScopes(["--scopes=/x"]), ["/x"]);
});

test("resolveCliScopes: no flag falls back to a single cwd scope", () => {
  assert.deepEqual(resolveCliScopes([], { cwd: () => "/here" }), ["/here"]);
  assert.deepEqual(resolveCliScopes([]), [process.cwd()], "the real cwd is the default scope");
});

test("resolveCliScopes: explicit --scopes wins even when the cwd is unavailable", () => {
  assert.deepEqual(resolveCliScopes(["--scopes", "/a"], { cwd: () => "" }), ["/a"]);
});

test("resolveCliScopes: HARD FAIL when cwd is empty and there is no --scopes flag", () => {
  assert.throws(() => resolveCliScopes([], { cwd: () => "" }), /cannot resolve CLI scopes/);
});

test("resolveCliScopes: HARD FAIL when process.cwd() throws and there is no --scopes flag", () => {
  assert.throws(
    () =>
      resolveCliScopes([], {
        cwd: () => {
          throw new Error("ENOENT: cwd removed");
        },
      }),
    /cannot resolve CLI scopes/,
  );
});

test("resolveCliScopes: HARD FAIL when --scopes is present but resolves to nothing (never empty)", () => {
  assert.throws(() => resolveCliScopes(["--scopes", ""]), /resolved to no directories/);
  assert.throws(() => resolveCliScopes(["--scopes"]), /resolved to no directories/);
});

// ── stripScopesArgs ─────────────────────────────────────────────────────────

test("stripScopesArgs: removes the flag and its value, keeps positionals", () => {
  assert.deepEqual(stripScopesArgs(["foo", "--scopes", "/a,/b", "bar"]), ["foo", "bar"]);
  assert.deepEqual(stripScopesArgs(["foo", "--scopes=/a", "bar"]), ["foo", "bar"]);
});

test("stripScopesArgs: is a no-op when no --scopes flag is present", () => {
  assert.deepEqual(stripScopesArgs(["hello", "world"]), ["hello", "world"]);
});

// ── withScopeContext ────────────────────────────────────────────────────────

test("withScopeContext: runs fn inside the resolved multi-level context (brain + repo)", () => {
  const home = makeTmp("lwm-scope-mlvl-");
  mkMount(home);
  const proj = mkMount(path.join(home, "proj"));

  let seen = null;
  const ret = withScopeContext(
    [proj],
    () => {
      seen = getActiveWikiContext();
      return "ok";
    },
    brainOpts(home),
  );

  assert.equal(ret, "ok", "fn's return value propagates");
  assert.ok(seen, "a context was active inside fn");
  assert.equal(seen.levels.length, 2, "brain + one repo => two levels, no crash");
  assert.equal(seen.brain.ownership, "wiki", "the brain is still the private-wiki level");
  assert.equal(seen.writeDefault, seen.brain, "reads still default to the brain (no fan-out yet)");
  assert.equal(getActiveWikiContext(), null, "the frame is gone after fn returns");
});

test("withScopeContext: falls through to fn() with no context when the context cannot be resolved", () => {
  // An uninitialised brain (no .layout/layout.yaml) makes resolveWikiContext
  // throw; the runner must swallow ONLY that and still run fn — today's
  // single-root behavior, which keeps a read command from crashing.
  const home = makeTmp("lwm-scope-fail-");
  const brainDataDir = path.join(home, ".llm-wiki-memory");
  fs.mkdirSync(path.join(brainDataDir, "wiki"), { recursive: true });

  let ran = false;
  let ctxInside = "unset";
  const ret = withScopeContext(
    [home],
    () => {
      ran = true;
      ctxInside = getActiveWikiContext();
      return 42;
    },
    { home, brainDataDir },
  );

  assert.equal(ran, true, "fn still runs when the context cannot be resolved");
  assert.equal(ret, 42, "fn's return value propagates through the fall-through path");
  assert.equal(ctxInside, null, "no wiki context is active on the fall-through path");
});

test("withScopeContext: does NOT swallow fn's own error", () => {
  const home = makeTmp("lwm-scope-boom-");
  mkMount(home);
  assert.throws(
    () =>
      withScopeContext(
        [home],
        () => {
          throw new Error("fn exploded");
        },
        brainOpts(home),
      ),
    /fn exploded/,
    "only a resolve failure is caught; fn's own error propagates",
  );
});

// ── End-to-end CLI behavior-neutrality (subprocess) ─────────────────────────

function baseEnv(dataDir, extra = {}) {
  const env = {
    ...process.env,
    MEMORY_DATA_DIR: dataDir,
    MEMORY_DEFAULT_PROJECT_MODULE: "scopetest",
    LLM_WIKI_SKILL_CLI: SKILL_CLI,
    LLM_WIKI_NO_PROMPT: "1",
    LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
    MEMORY_LLM_PROVIDER: "mock",
    MEMORY_LLM_MOCK_RESPONSE: '{"ok":true}',
    ...extra,
  };
  // Clear the path overrides so neutrality compares the pure MEMORY_DATA_DIR
  // default against the brain root the wrap installs (must be identical).
  delete env.LLM_WIKI_MEMORY_ROOT;
  delete env.MEMORY_EMBED_CACHE;
  return env;
}

function initBrain(dataDir, extraEnv = {}) {
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "settings", "settings.yaml"), "embed:\n  backend: lexical\n");
  const r = spawnSync(process.execPath, [CLI, "init"], {
    env: baseEnv(dataDir, extraEnv),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `brain init failed: ${r.stderr || r.stdout}`);
}

function runCli(args, { dataDir, cwd, extraEnv = {} }) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: baseEnv(dataDir, extraEnv),
    encoding: "utf8",
  });
  return r;
}

test("`where` from a cwd targets the brain wiki (behavior-neutral single root)", () => {
  const dataDir = makeTmp("lwm-scope-where-");
  initBrain(dataDir);

  const r = runCli(["where"], { dataDir, cwd: dataDir });
  assert.equal(r.status, 0, `where exited non-zero: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(
    parsed.wiki,
    path.join(dataDir, "wiki"),
    "wikiRoot() inside the wrap equals the pre-wrap brain default",
  );
  assert.equal(
    parsed.embedCache,
    path.join(dataDir, "index", "embeddings.json"),
    "embedCachePath() inside the wrap equals the pre-wrap brain default",
  );
});

test("`search`/`recall` from a cwd run without error and `--scopes` never pollutes the query", () => {
  const dataDir = makeTmp("lwm-scope-read-");
  initBrain(dataDir);

  for (const cmd of ["search", "recall"]) {
    const plain = runCli([cmd, "hello", "world"], { dataDir, cwd: dataDir });
    assert.equal(plain.status, 0, `${cmd} exited non-zero: ${plain.stderr}`);
    const plainParsed = JSON.parse(plain.stdout);
    assert.equal(plainParsed.query, "hello world", `${cmd} echoes the positional query`);
    assert.ok(Array.isArray(plainParsed.records), `${cmd} returns a records array`);

    const scoped = runCli([cmd, "hello", "world", "--scopes", "/tmp/does-not-exist"], {
      dataDir,
      cwd: dataDir,
    });
    assert.equal(scoped.status, 0, `${cmd} --scopes exited non-zero: ${scoped.stderr}`);
    const scopedParsed = JSON.parse(scoped.stdout);
    assert.equal(
      scopedParsed.query,
      "hello world",
      `${cmd} strips --scopes from the query (additive, behavior-neutral)`,
    );
  }
});

test("`search --scopes <repo-with-a-mount>` resolves a multi-level context without error", () => {
  const home = makeTmp("lwm-scope-e2e-mlvl-");
  const brainData = path.join(home, ".llm-wiki-memory");
  initBrain(brainData, { HOME: home });
  const proj = mkMount(path.join(home, "proj"));

  const r = runCli(["search", "hello", "--scopes", proj], {
    dataDir: brainData,
    cwd: SRC,
    extraEnv: { HOME: home },
  });
  assert.equal(r.status, 0, `multi-level search exited non-zero: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.query, "hello", "the query is the positional arg, not the --scopes value");
  assert.ok(Array.isArray(parsed.records), "brain results are present (reads do not fan out yet)");
});

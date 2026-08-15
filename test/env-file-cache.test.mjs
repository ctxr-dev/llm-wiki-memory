// `envValue` re-read and re-parsed `settings/.env` from disk on EVERY call, uncached. That is the
// real cost behind a "slow" settings lookup: `settings()` already caches its parsed YAML by mtime,
// but BUILDING its cache key calls envValue 4-6 times, so a settings() cache HIT cost ~200µs — six
// full file reads of a 695-byte file at ~33µs each — and cacheStamp() (2-3 settings() calls)
// cost 400-600µs. Caching the parse by mtime makes the same hit ~5.6µs.
//
// The cache must preserve two properties exactly, and these tests are the reason it is safe:
// process.env still wins on EVERY call (so a runtime mutation is honoured), and a .env edit is
// picked up on the next call (so nothing goes stale). Only the PARSE is memoised, never a lookup
// result.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fresh MEMORY_DATA_DIR per module load, so this file never touches the real brain and the
// env-file path it exercises is disposable.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-envcache-"));
fs.mkdirSync(path.join(TMP, "settings"), { recursive: true });
const ENV_FILE = path.join(TMP, "settings", ".env");
fs.writeFileSync(ENV_FILE, "FROM_FILE=file-value\nSHARED=file-wins-unless-process\n");
process.env.MEMORY_DATA_DIR = TMP;

const { envValue, __resetEnvFileCache } = await import("../scripts/lib/env.mjs");

/** mtime has 1ms resolution at best; bump it explicitly so a same-millisecond edit is still seen. */
function writeEnv(body) {
  fs.writeFileSync(ENV_FILE, body);
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(ENV_FILE, t, t);
}

test("a value is read from the .env file", () => {
  __resetEnvFileCache();
  writeEnv("FROM_FILE=file-value\n");
  assert.equal(envValue("FROM_FILE"), "file-value");
});

test("repeated reads are consistent (the cache serves the same content)", () => {
  __resetEnvFileCache();
  writeEnv("A=1\n");
  for (let i = 0; i < 50; i += 1) assert.equal(envValue("A"), "1");
});

// THE correctness property the cache must not break. envValue checks process.env FIRST on every
// call, so only the file parse may be memoised — never the resolved value.
test("process.env still wins on EVERY call, including after the cache is warm", () => {
  __resetEnvFileCache();
  writeEnv("SHARED=from-file\n");
  assert.equal(envValue("SHARED"), "from-file", "file value while process.env is unset");
  process.env.SHARED = "from-process";
  try {
    assert.equal(envValue("SHARED"), "from-process", "a mid-run process.env change must win");
    process.env.SHARED = "changed-again";
    assert.equal(envValue("SHARED"), "changed-again", "and again, with no cache in the way");
  } finally {
    delete process.env.SHARED;
  }
  assert.equal(envValue("SHARED"), "from-file", "and removing it falls back to the file");
});

test("an empty process.env value does NOT shadow the file (existing semantics)", () => {
  __resetEnvFileCache();
  writeEnv("SHARED=from-file\n");
  process.env.SHARED = "";
  try {
    assert.equal(envValue("SHARED"), "from-file", "empty is treated as unset");
  } finally {
    delete process.env.SHARED;
  }
});

test("an edit to .env is picked up on the next call", () => {
  __resetEnvFileCache();
  writeEnv("K=first\n");
  assert.equal(envValue("K"), "first");
  writeEnv("K=second\n");
  assert.equal(envValue("K"), "second", "a stale parse would still say 'first'");
});

test("a missing .env resolves to the fallback, and is picked up when CREATED later", () => {
  __resetEnvFileCache();
  fs.rmSync(ENV_FILE, { force: true });
  assert.equal(envValue("LATER", "fallback"), "fallback", "absent file => fallback");
  writeEnv("LATER=now-here\n");
  assert.equal(envValue("LATER"), "now-here", "a cached MISS must not be permanent");
});

test("a .env deleted after being cached stops being served", () => {
  __resetEnvFileCache();
  writeEnv("GONE=value\n");
  assert.equal(envValue("GONE"), "value");
  fs.rmSync(ENV_FILE, { force: true });
  assert.equal(envValue("GONE", "fb"), "fb", "a deleted file must not be served from cache");
  writeEnv("GONE=value\n");
});

test("comments and quoting still parse identically through the cache", () => {
  __resetEnvFileCache();
  writeEnv('# a comment\nQ="quoted value"\nI=inline # trailing comment\nEMPTY=\n');
  assert.equal(envValue("Q"), "quoted value");
  assert.equal(envValue("I"), "inline");
  assert.equal(envValue("EMPTY", "fb"), "", "an empty value stays empty — ?? only catches absent");
});

// Relative, never an absolute µs bound. The cost here is dominated by ONE `statSync`, and that
// varies ~16x by filesystem (0.9µs on the user volume vs 14µs on macOS /var/folders, where temp
// dirs live) — so an absolute threshold measures the mount, not the code, and flakes on a different
// CI runner. Comparing cached against forced-uncached tests the actual property: the cache avoids
// re-parsing.
test("a cached lookup is materially cheaper than a forced re-parse", () => {
  __resetEnvFileCache();
  writeEnv(
    Array.from({ length: 14 }, (_, i) => `MEMORY_KEY_${i}=${"v".repeat(40)}`).join("\n") + "\n",
  );
  const N = 4000;
  const timeIt = (fn) => {
    for (let i = 0; i < 200; i += 1) fn();
    const t = process.hrtime.bigint();
    for (let i = 0; i < N; i += 1) fn();
    return Number(process.hrtime.bigint() - t) / N;
  };
  const cached = timeIt(() => envValue("MEMORY_KEY_0"));
  const uncached = timeIt(() => {
    __resetEnvFileCache();
    return envValue("MEMORY_KEY_0");
  });
  assert.ok(
    uncached > cached * 2,
    `a cached lookup (${(cached / 1000).toFixed(1)}µs) must beat a re-parse ` +
      `(${(uncached / 1000).toFixed(1)}µs) by a clear margin — otherwise the cache is not working`,
  );
});

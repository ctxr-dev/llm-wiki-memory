// SECURITY: the mtime-keyed .env parse cache must never RETAIN a credential.
//
// `settings/.env` is the documented home for API keys — templates/env.example lists
// `ANTHROPIC_API_KEY=` and `OPENAI_API_KEY=`, and llm-api-providers.mjs reads them through
// envValue(). Caching the parse (a ~35x win on the settings() hot path) therefore moved plaintext
// keys from a transient object, collected immediately, into a module-level Map held for the life of
// the process — and the MCP server runs for days.
//
// This grants no NEW capability: a process that can read the cache could always read the file. It
// lengthens the window in which a heap dump or a memory-disclosure bug yields a live credential,
// which is worth not doing when the fix is free. Secrets are read only when an LLM provider is
// invoked — a handful of times per process — so they do not need the fast path at all. Config keys
// (MEMORY_*), read thousands of times, keep it.
//
// The assertions below inspect the CACHE, not the return value. A return-value test passes whether
// or not the secret is retained, so it would prove nothing about the property that matters.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fake data dir before importing the engine, so this never touches the real brain and ENV_PATH
// resolves into a disposable tree. (Engine modules capture MEMORY_DATA_DIR at load.)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-envsec-"));
fs.mkdirSync(path.join(TMP, "settings"), { recursive: true });
const ENV_FILE = path.join(TMP, "settings", ".env");
process.env.MEMORY_DATA_DIR = TMP;

const { envValue } = await import("../scripts/lib/env.mjs");
const { __resetEnvFileCache, __envFileCacheSnapshot } = await import("../scripts/lib/env-file.mjs");

const SECRET = "sk-ant-test-do-not-retain-0123456789";

// Stamps a STRICTLY INCREASING mtime. `Date.now() + k` is not enough: two writes of equal-length
// values inside one millisecond then produce an identical (mtime, size) cache key, and a test meant
// to prove a rewrite is seen instead proves the cache served a stale value.
let fixtureClock = Date.now();
function writeEnv(body) {
  fs.writeFileSync(ENV_FILE, body);
  fixtureClock += 1000;
  const t = new Date(fixtureClock);
  fs.utimesSync(ENV_FILE, t, t);
}

/** Every value currently held anywhere in the parse cache. */
function cachedValues() {
  return Object.values(__envFileCacheSnapshot()).flatMap((parsed) => Object.values(parsed));
}

test("a credential is NEVER retained in the parse cache", () => {
  __resetEnvFileCache();
  writeEnv(`MEMORY_DEFAULT_PROJECT_MODULE=repos\nANTHROPIC_API_KEY=${SECRET}\n`);

  assert.equal(envValue("ANTHROPIC_API_KEY"), SECRET, "the key must still resolve correctly");
  assert.equal(envValue("MEMORY_DEFAULT_PROJECT_MODULE"), "repos", "and config still resolves");

  const values = cachedValues();
  assert.equal(
    values.includes(SECRET),
    false,
    `the credential must not be in the cache; found: ${JSON.stringify(values)}`,
  );
  assert.equal(
    values.includes("repos"),
    true,
    "the non-secret config value SHOULD be cached — the perf win depends on it",
  );
});

test("every documented credential name is treated as secret", () => {
  __resetEnvFileCache();
  writeEnv(
    [
      "ANTHROPIC_API_KEY=a-secret-1",
      "OPENAI_API_KEY=a-secret-2",
      "SOME_SERVICE_TOKEN=a-secret-3",
      "DB_PASSWORD=a-secret-4",
      "MY_CLIENT_SECRET=a-secret-5",
      "MEMORY_FLUSH_SLOT=daily",
    ].join("\n") + "\n",
  );
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "SOME_SERVICE_TOKEN",
    "DB_PASSWORD",
    "MY_CLIENT_SECRET",
  ]) {
    envValue(name);
  }
  envValue("MEMORY_FLUSH_SLOT");

  const values = cachedValues();
  for (const leaked of ["a-secret-1", "a-secret-2", "a-secret-3", "a-secret-4", "a-secret-5"]) {
    assert.equal(values.includes(leaked), false, `${leaked} must not be cached`);
  }
  assert.equal(values.includes("daily"), true, "an ordinary config value stays cached");
});

test("a secret still resolves correctly on every call, uncached", () => {
  __resetEnvFileCache();
  writeEnv(`ANTHROPIC_API_KEY=${SECRET}\n`);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(envValue("ANTHROPIC_API_KEY"), SECRET, `call ${i} must resolve`);
  }
});

test("process.env still wins for a secret, on every call", () => {
  __resetEnvFileCache();
  writeEnv(`ANTHROPIC_API_KEY=${SECRET}\n`);
  process.env.ANTHROPIC_API_KEY = "from-process";
  try {
    assert.equal(envValue("ANTHROPIC_API_KEY"), "from-process");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
  assert.equal(envValue("ANTHROPIC_API_KEY"), SECRET, "and falls back to the file when unset");
});

// A rotated key must take effect immediately. Since secrets are never cached this is inherent,
// but it is the property an operator actually depends on, so it is pinned.
test("a rotated credential is picked up at once", () => {
  __resetEnvFileCache();
  writeEnv("ANTHROPIC_API_KEY=old-key\n");
  assert.equal(envValue("ANTHROPIC_API_KEY"), "old-key");
  writeEnv("ANTHROPIC_API_KEY=new-key\n");
  assert.equal(envValue("ANTHROPIC_API_KEY"), "new-key", "a stale credential would be worse");
});

// The cache key is (mtime, size), so the case it CANNOT see is a same-size rewrite that preserves
// the timestamp. mtime is forced back explicitly rather than relying on writes landing in the same
// millisecond — APFS timestamps are finer than 1ms, so without this the test passes even when
// secrets ARE cached, proving nothing.
test("a rotated credential is picked up even when mtime and size are unchanged", () => {
  __resetEnvFileCache();
  fixtureClock += 1000;
  const pinned = new Date(fixtureClock);

  fs.writeFileSync(ENV_FILE, "ANTHROPIC_API_KEY=first\n");
  fs.utimesSync(ENV_FILE, pinned, pinned);
  const before = fs.statSync(ENV_FILE);
  assert.equal(envValue("ANTHROPIC_API_KEY"), "first");

  // Same length, same pinned timestamp => a byte-identical (mtime, size) cache key.
  fs.writeFileSync(ENV_FILE, "ANTHROPIC_API_KEY=secnd\n");
  fs.utimesSync(ENV_FILE, pinned, pinned);
  const after = fs.statSync(ENV_FILE);
  assert.equal(after.mtimeMs, before.mtimeMs, "fixture must pin mtime, or this proves nothing");
  assert.equal(after.size, before.size, "and size, so the cache key is genuinely identical");

  assert.equal(envValue("ANTHROPIC_API_KEY"), "secnd", "secrets must not ride an mtime cache");
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

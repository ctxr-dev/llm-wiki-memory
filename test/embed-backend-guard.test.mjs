import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveCache,
  loadCache,
  persistSuspended,
  fallbackActive,
  __setBackendStateForTest,
} from "../scripts/lib/embed.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

const created = [];
function tmpFile() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-embed-guard-")));
  created.push(dir);
  return path.join(dir, "cache.json");
}
after(() => {
  __setBackendStateForTest();
  for (const d of created) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("persistSuspended is true when a NON-lexical config resolves to lexical (degraded)", () => {
  assert.equal(persistSuspended("transformers", "lexical"), true);
  assert.equal(persistSuspended("transformers", "transformers"), false);
  assert.equal(persistSuspended("lexical", "lexical"), false);
  assert.equal(persistSuspended("lexical", "transformers"), false);
  assert.equal(persistSuspended("transformers", null), false);
  assert.equal(
    persistSuspended("transformer", "lexical"),
    true,
    "a misspelled backend still guards",
  );
});

test("fallbackActive is true only for a lexical backend still inside the retry window", () => {
  assert.equal(fallbackActive("lexical", 1000, 500), true);
  assert.equal(fallbackActive("lexical", 1000, 1000), false);
  assert.equal(fallbackActive("lexical", 1000, 1500), false);
  assert.equal(fallbackActive("lexical", 0, 500), false);
  assert.equal(fallbackActive("transformers", 1000, 500), false);
  assert.equal(fallbackActive(null, 1000, 500), false);
});

test("saveCache suspends persistence in a degraded transformers->lexical fallback", () => {
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    const p = tmpFile();
    __setBackendStateForTest({ backend: "lexical", fallbackUntil: Number.MAX_SAFE_INTEGER });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } } });
    assert.equal(
      fs.existsSync(p),
      false,
      "a degraded fallback must NOT overwrite the on-disk cache",
    );
  });
});

test("saveCache persists normally once the transformer backend is resolved", () => {
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    const p = tmpFile();
    __setBackendStateForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
    assert.equal(fs.existsSync(p), true);
    assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "transformers");
  });
});

test("saveCache persists for a genuinely lexical-configured wiki (not a downgrade)", () => {
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    const p = tmpFile();
    __setBackendStateForTest({ backend: "lexical" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } } });
    assert.equal(fs.existsSync(p), true, "a real lexical config is authoritative, not a downgrade");
    assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "lexical");
  });
});

test("saveCache refuses to downgrade an EXISTING transformers cache to lexical", () => {
  const p = tmpFile();
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __setBackendStateForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
  });
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "transformers");
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __setBackendStateForTest({ backend: "lexical" });
    saveCache(p, { entries: { b: { hash: "h2", vector: [0.9] } } });
  });
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.backend, "transformers", "the transformers cache is preserved");
  assert.ok(after.entries.a, "original entries intact");
  assert.equal("b" in after.entries, false, "the foreign lexical write was discarded");
});

test("a suspended persist EVICTS the memo so the next load re-reads authoritative disk bytes", () => {
  const p = tmpFile();
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __setBackendStateForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
    const memoized = loadCache(p);
    memoized.entries.a.vector = [0.9];
    memoized._dirty = true;
    __setBackendStateForTest({ backend: "lexical", fallbackUntil: Number.MAX_SAFE_INTEGER });
    saveCache(p, memoized);
    __setBackendStateForTest({ backend: "transformers" });
    const reloaded = loadCache(p);
    assert.deepEqual(
      reloaded.entries.a.vector,
      [0.1, 0.2],
      "next load returns the authoritative disk vectors, not the poisoned in-memory object",
    );
  });
});

test("a dtype flip invalidates a stamped cache; a legacy cache without dtype still loads", () => {
  const p = tmpFile();
  withSettingsOverride(
    { embed: { backend: "transformers", model: "test/plain-model", dtype: "q8" } },
    () => {
      __setBackendStateForTest({ backend: "transformers" });
      saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
      assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).dtype, "q8", "dtype stamped");
      assert.ok(loadCache(p).entries.a, "same dtype loads");
    },
  );
  withSettingsOverride(
    { embed: { backend: "transformers", model: "test/plain-model", dtype: "q4" } },
    () => {
      __setBackendStateForTest({ backend: "transformers" });
      assert.equal(Object.keys(loadCache(p).entries).length, 0, "q4 vs q8 stamp re-embeds");
    },
  );
  const legacy = JSON.parse(fs.readFileSync(p, "utf8"));
  delete legacy.dtype;
  fs.writeFileSync(p, JSON.stringify(legacy));
  withSettingsOverride(
    { embed: { backend: "transformers", model: "test/plain-model", dtype: "q4" } },
    () => {
      __setBackendStateForTest({ backend: "transformers" });
      assert.ok(loadCache(p).entries.a, "a pre-dtype legacy cache matches any dtype");
    },
  );
});

test("saveCache allows UPGRADING a lexical cache to transformers (the reconcile/heal path)", () => {
  const p = tmpFile();
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __setBackendStateForTest({ backend: "lexical" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } } });
  });
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "lexical");
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __setBackendStateForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h3", vector: [0.1, 0.2, 0.3] } } });
  });
  assert.equal(
    JSON.parse(fs.readFileSync(p, "utf8")).backend,
    "transformers",
    "an upgrade (transformers over lexical) persists",
  );
});

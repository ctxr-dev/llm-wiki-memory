import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveCache, loadCache } from "../scripts/lib/embed.mjs";
import {
  persistSuspended,
  fallbackActive,
  __resetForTest,
} from "../scripts/lib/embed-backend-state.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

const created = [];
// A cache path inside a WIKI-SHAPED install, because the persistence guard resolves
// "did this wiki choose lexical" from the owning install's settings file — not from the
// writing process's settings(). A bare temp path would declare nothing, which the guard
// (correctly) reads as "not chosen".
/** @param {string} [declaredBackend] what the owning install's settings.yaml declares */
function tmpFile(declaredBackend) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-embed-guard-")));
  created.push(dataDir);
  if (declaredBackend) {
    fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "settings", "settings.yaml"),
      `embed:\n  backend: ${declaredBackend}\n`,
    );
  }
  const dir = path.join(dataDir, "wiki", "knowledge", ".embeddings");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "embeddings.json");
}
after(() => {
  __resetForTest();
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
    __resetForTest({ backend: "lexical", fallbackUntil: Number.MAX_SAFE_INTEGER });
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
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
    assert.equal(fs.existsSync(p), true);
    assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "transformers");
  });
});

test("saveCache persists for a genuinely lexical-configured wiki (not a downgrade)", () => {
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    const p = tmpFile("lexical");
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } } });
    assert.equal(fs.existsSync(p), true, "a real lexical config is authoritative, not a downgrade");
    assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "lexical");
  });
});

test("a DELIBERATE lexical config CAN overwrite an existing transformers cache", () => {
  // The old guard blocked this, and because the write was blocked the on-disk
  // stamp never changed — so every subsequent save was blocked too, forever. With
  // loadCache also rejecting the mismatched cache, recall could only ever score
  // `embed.maxColdPerRead` leaves (default 32) and then threw the work away.
  // A lexical backend the operator CHOSE is not a degradation, so the cache follows
  // the config; the vectors are recomputable either way.
  const p = tmpFile("lexical");
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
  });
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "transformers");

  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { b: { hash: "h2", vector: [0.9] } } });
  });
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.backend, "lexical", "the cache follows the configured backend");
  assert.ok(after.entries.b, "the lexical write persisted");
});

test("a lexical-configured wiki persists REPEATEDLY (the block was self-perpetuating)", () => {
  const p = tmpFile("lexical");
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } } });
  });
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { b: { hash: "h2", vector: [0.9] } } });
    saveCache(p, {
      entries: { b: { hash: "h2", vector: [0.9] }, c: { hash: "h3", vector: [0.5] } },
    });
  });
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(after.entries.c, "a second save also lands — progress is not frozen");
});

test("a DEGRADED transformers->lexical fallback is STILL refused (guard 1 intact)", () => {
  // The protection that actually matters is unchanged: a run that WANTED
  // transformers but fell back to lexical must never overwrite good vectors.
  const p = tmpFile();
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
    __resetForTest({ backend: "lexical", fallbackUntil: Number.MAX_SAFE_INTEGER });
    saveCache(p, { entries: { b: { hash: "h2", vector: [0.9] } } });
  });
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.backend, "transformers", "degraded run cannot clobber the good cache");
  assert.equal("b" in after.entries, false, "the degraded write was discarded");
});

test("a suspended persist EVICTS the memo so the next load re-reads authoritative disk bytes", () => {
  const p = tmpFile();
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
    const memoized = loadCache(p);
    memoized.entries.a.vector = [0.9];
    memoized._dirty = true;
    __resetForTest({ backend: "lexical", fallbackUntil: Number.MAX_SAFE_INTEGER });
    saveCache(p, memoized);
    __resetForTest({ backend: "transformers" });
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
      __resetForTest({ backend: "transformers" });
      saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
      assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).dtype, "q8", "dtype stamped");
      assert.ok(loadCache(p).entries.a, "same dtype loads");
    },
  );
  withSettingsOverride(
    { embed: { backend: "transformers", model: "test/plain-model", dtype: "q4" } },
    () => {
      __resetForTest({ backend: "transformers" });
      assert.equal(Object.keys(loadCache(p).entries).length, 0, "q4 vs q8 stamp re-embeds");
    },
  );
  const legacy = JSON.parse(fs.readFileSync(p, "utf8"));
  delete legacy.dtype;
  fs.writeFileSync(p, JSON.stringify(legacy));
  withSettingsOverride(
    { embed: { backend: "transformers", model: "test/plain-model", dtype: "q4" } },
    () => {
      __resetForTest({ backend: "transformers" });
      assert.ok(loadCache(p).entries.a, "a pre-dtype legacy cache matches any dtype");
    },
  );
});

test("saveCache allows UPGRADING a lexical cache to transformers (the reconcile/heal path)", () => {
  const p = tmpFile("lexical");
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } } });
  });
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "lexical");
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h3", vector: [0.1, 0.2, 0.3] } } });
  });
  assert.equal(
    JSON.parse(fs.readFileSync(p, "utf8")).backend,
    "transformers",
    "an upgrade (transformers over lexical) persists",
  );
});

// The on-disk tripwire. Distinct from the state-machine guard above: this one
// compares what we are about to stamp against what is actually on disk, and exists
// because the in-memory invariant was observed to break on a live brain — 908
// transformer vectors (dim 768) were replaced by 646 lexical ones (dim 256) while
// `embed.backend: transformers` was configured.

test("a lexical stamp NEVER replaces an on-disk transformers cache when lexical was not configured", () => {
  const p = tmpFile();
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { good: { hash: "h", vector: [0.1, 0.2] } } });
  });

  // A process that resolved lexical WITHOUT the operator configuring it. By
  // derivation the state-machine guard already covers this; the tripwire is the
  // belt-and-braces that does not depend on in-memory state being correct.
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { bad: { hash: "h2", vector: [0.9] } } });
  });

  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.backend, "transformers", "the good stamp survives");
  assert.ok(after.entries.good, "the transformer vectors are still on disk");
  assert.equal(after.entries.bad, undefined, "the lexical write did not land");
});

test("the tripwire does NOT re-freeze a DELIBERATELY lexical wiki", () => {
  // The regression the tripwire must not reintroduce: when the operator chooses
  // lexical, the cache follows the config — otherwise the refusal is
  // self-perpetuating (the stamp never updates, so every later save is refused too).
  const p = tmpFile("lexical");
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
  });
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { b: { hash: "h2", vector: [0.9] } } });
  });
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.backend, "lexical", "a chosen backend still wins");
  assert.ok(after.entries.b, "and it persists");
});

// The scenario that actually destroyed vectors, three times, on a live brain.
//
// The writing process had `embed.backend: lexical` in effect — from a settings override,
// or from a temp workspace's own settings.yaml — while the wiki it was writing declares
// `transformers`. Because the guard used to ask the PROCESS ("is lexical configured?")
// rather than the wiki ("did THIS install choose lexical?"), that process presented
// itself as a deliberately-lexical wiki and was allowed to replace 768-dim transformer
// vectors with 256-dim lexical ones. Recall then scored at most `embed.maxColdPerRead`
// leaves of the corpus until a full re-warm.
test("a lexical-OVERRIDDEN process cannot overwrite a wiki that declares transformers", () => {
  const p = tmpFile("transformers");
  withSettingsOverride({ embed: { backend: "transformers" } }, () => {
    __resetForTest({ backend: "transformers" });
    saveCache(p, { entries: { real: { hash: "h", vector: [0.1, 0.2, 0.3] } } });
  });
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).backend, "transformers");

  // A test run, a stray tool, anything with a lexical override in its own settings().
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { lex: { hash: "h2", vector: [0.9] } } });
  });

  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.backend, "transformers", "the wiki's OWN declaration is authoritative");
  assert.ok(after.entries.real, "the transformer vectors survive");
  assert.equal(after.entries.lex, undefined, "the overriding process's write is refused");
});

test("an install that DECLARES NOTHING falls back to the process value", () => {
  // A SHARED repo wiki carries no settings file — its settings live in the consuming
  // brain — so silence cannot mean "refuse to persist", or a shared wiki could never
  // cache a vector while the consumer runs lexical. Silence is not the incident case:
  // the brain that lost its vectors DECLARES transformers, and the test above pins that.
  const p = tmpFile();
  withSettingsOverride({ embed: { backend: "lexical" } }, () => {
    __resetForTest({ backend: "lexical" });
    saveCache(p, { entries: { lex: { hash: "h2", vector: [0.9] } } });
  });
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(after.backend, "lexical", "an undeclared wiki follows the running process");
  assert.ok(after.entries.lex, "so a shared wiki can still cache vectors");
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "settings-test-"));
process.env.MEMORY_DATA_DIR = TMP_DATA_DIR;
fs.mkdirSync(path.join(TMP_DATA_DIR, "settings"), { recursive: true });

const {
  settings,
  settingsPath,
  __setSettingsForTest,
  __clearSettingsForTest,
  consolidateCosineThreshold,
  flushChunkTargetK,
  hookMaxTurns,
  writeGateSelfImprovementEnabled,
  writeGateClaudeHookEnabled,
  writeGateAuditTrailEnabled,
  writeGatePerLessonConsent,
  writeGateAuditKeep,
  resolvedChain,
  pickStrongerModel,
  isCliProvider,
  isApiProvider,
  __testing,
} = await import("../scripts/lib/settings.mjs");

after(() => {
  __clearSettingsForTest();
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

const STRICT_ENV_KEYS = [
  "MEMORY_LLM_PROVIDER",
  "MEMORY_LLM_MODEL",
  "MEMORY_LLM_BASE_URL",
  "MEMORY_SETTINGS_PATH",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

function clearEnv() {
  for (const k of STRICT_ENV_KEYS) delete process.env[k];
  __clearSettingsForTest();
}

function withYaml(yamlText, fn) {
  const yamlPath = path.join(TMP_DATA_DIR, "settings", "settings.yaml");
  if (yamlText === null) fs.rmSync(yamlPath, { force: true });
  else fs.writeFileSync(yamlPath, yamlText);
  try {
    return fn();
  } finally {
    fs.rmSync(yamlPath, { force: true });
    __clearSettingsForTest();
  }
}

// ─── Defaults from shipped template ───────────────────────────────────────

test("defaults: no user YAML -> loader falls back to shipped templates/settings.yaml", () => {
  clearEnv();
  withYaml(null, () => {
    const s = settings({ cmdProbe: () => false });
    // Section presence + a few sentinel values.
    assert.ok(s.consolidate.cosineThreshold > 0 && s.consolidate.cosineThreshold <= 1);
    assert.equal(s.flush.chunkTargetK, 5);
    assert.equal(s.hook.maxTurns, 30);
    assert.equal(s.embed.backend, "transformers");
    assert.equal(s.gate.selfImprovementEnabled, true);
    assert.equal(s.gate.claudeHookEnabled, true);
    // Provider model lists sourced from the shipped template (don't assert
    // specific names — they live in the YAML, not in code).
    assert.ok(s.providers.anthropic.models.length > 0);
  });
});

test("gate: audit + per-lesson keys default ON; auditKeep default 1000", () => {
  clearEnv();
  withYaml(null, () => {
    settings({ cmdProbe: () => false });
    assert.equal(writeGateAuditTrailEnabled(), true);
    assert.equal(writeGatePerLessonConsent(), true);
    assert.equal(writeGateAuditKeep(), 1000);
  });
});

test("gate: explicit false disables audit / per-lesson; positive auditKeep honored", () => {
  clearEnv();
  withYaml(
    `gate:\n  auditTrailEnabled: false\n  perLessonConsent: false\n  auditKeep: 50\n`,
    () => {
      settings({ cmdProbe: () => false });
      assert.equal(writeGateAuditTrailEnabled(), false);
      assert.equal(writeGatePerLessonConsent(), false);
      assert.equal(writeGateAuditKeep(), 50);
    },
  );
});

test("gate: null/bare audit + per-lesson keys FAIL CLOSED to true (not Boolean(null) false)", () => {
  clearEnv();
  // A bare `auditTrailEnabled:` / `perLessonConsent:` (null) must NOT silently
  // disable consent recording or per-lesson prompting — same fail-closed rule
  // as selfImprovementEnabled. Garbage auditKeep falls back to the default.
  withYaml(`gate:\n  auditTrailEnabled:\n  perLessonConsent:\n  auditKeep: nonsense\n`, () => {
    settings({ cmdProbe: () => false });
    assert.equal(writeGateAuditTrailEnabled(), true, "bare auditTrailEnabled must stay ON");
    assert.equal(writeGatePerLessonConsent(), true, "bare perLessonConsent must stay ON");
    assert.equal(writeGateAuditKeep(), 1000, "garbage auditKeep must fall back to default");
  });
});

test("user YAML overrides template", () => {
  clearEnv();
  withYaml(
    `consolidate:\n  cosineThreshold: 0.55\nflush:\n  chunkTargetK: 9\nhook:\n  maxTurns: 100\n`,
    () => {
      const s = settings();
      assert.equal(s.consolidate.cosineThreshold, 0.55);
      assert.equal(s.flush.chunkTargetK, 9);
      assert.equal(s.hook.maxTurns, 100);
    },
  );
});

test("malformed USER YAML does NOT throw — falls back to shipped defaults (system stays up)", () => {
  clearEnv();
  // A crash-truncated or typo'd settings.yaml must not take down every hook /
  // recall / cron. The loader warns to stderr and serves template defaults.
  withYaml("consolidate:\n  cosineThreshold: [oops\n", () => {
    let s;
    assert.doesNotThrow(() => {
      s = settings({ cmdProbe: () => false });
    }, "must not throw on a malformed user file");
    // Served the shipped default, not garbage.
    assert.equal(s.consolidate.cosineThreshold, 0.97);
    assert.equal(s.flush.chunkTargetK, 5);
  });
});

// The companion to the malformed-USER test: the loader's asymmetry is
// deliberate. A bad USER file is recoverable operator data (warn + fall back to
// the shipped template). A bad shipped TEMPLATE is a packaging bug — there is
// no safe fallback below it, so the loader THROWS rather than serve garbage.
function withCorruptTemplate(corruptYaml, fn) {
  const tplPath = __testing.TEMPLATE_PATH;
  const original = fs.readFileSync(tplPath, "utf8");
  fs.writeFileSync(tplPath, corruptYaml);
  __clearSettingsForTest();
  try {
    return fn();
  } finally {
    fs.writeFileSync(tplPath, original);
    __clearSettingsForTest();
  }
}

test("malformed shipped TEMPLATE THROWS when there is no usable user override (packaging bug, not recoverable)", () => {
  clearEnv();
  // No user file at all: a missing user path parses to null and falls straight
  // through to the template. With the template unparseable, there is nothing
  // left to fall back to, so the loader must surface the packaging bug.
  const missingUserPath = path.join(TMP_DATA_DIR, "settings", "does-not-exist.yaml");
  fs.rmSync(missingUserPath, { force: true });
  withCorruptTemplate("consolidate:\n  cosineThreshold: [oops\n", () => {
    assert.throws(
      () => settings({ configPath: missingUserPath, cmdProbe: () => false }),
      (err) => {
        assert.match(err.message, /shipped template .* failed to parse/);
        assert.ok(
          err.message.includes(__testing.TEMPLATE_PATH),
          "names the offending template path",
        );
        return true;
      },
      "a malformed shipped template must throw, not silently degrade",
    );
  });
});

test("malformed shipped TEMPLATE still THROWS even when the user file is ALSO malformed (no recoverable layer)", () => {
  clearEnv();
  // A malformed user file warns and falls through to the template (the
  // malformed-USER test pins that). When the template below it is ALSO corrupt
  // there is no recoverable configuration anywhere, so the fall-through still
  // ends in a throw — the warn path does not mask the packaging bug.
  withCorruptTemplate(": : : not yaml [\n", () => {
    withYaml("flush:\n  chunkTargetK: [bad\n", () => {
      assert.throws(
        () => settings({ cmdProbe: () => false }),
        /settings: shipped template .* failed to parse/,
      );
    });
  });
});

// ─── Strict-subset env overlay ────────────────────────────────────────────

test("env MEMORY_LLM_PROVIDER collapses chain to single provider", () => {
  clearEnv();
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  withYaml(`providers:\n  chain: [openai, anthropic, claude]\n`, () => {
    assert.deepEqual([...settings().providers.chain], ["anthropic"]);
  });
});

test("env MEMORY_LLM_MODEL prepends to head provider's models", () => {
  clearEnv();
  process.env.MEMORY_LLM_PROVIDER = "anthropic";
  process.env.MEMORY_LLM_MODEL = "fixture-model-z";
  withYaml(`providers:\n  chain: [anthropic]\n  anthropic:\n    models: [a, b]\n`, () => {
    assert.equal(settings().providers.anthropic.models[0], "fixture-model-z");
    assert.ok(settings().providers.anthropic.models.includes("a"));
  });
});

// ─── Non-strict env vars are IGNORED (breaking-change discipline) ─────────

test("BREAKING: process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD has NO effect on settings", (t) => {
  clearEnv();
  process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD = "0.5";
  t.after(() => {
    delete process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD;
    clearEnv();
  });
  withYaml(`consolidate:\n  cosineThreshold: 0.91\n`, () => {
    assert.equal(
      consolidateCosineThreshold(),
      0.91,
      "env var must NOT win over YAML; back-compat removed",
    );
  });
});

test("BREAKING: process.env.MEMORY_FLUSH_CHUNK_TARGET_K has NO effect", (t) => {
  clearEnv();
  process.env.MEMORY_FLUSH_CHUNK_TARGET_K = "99";
  t.after(() => {
    delete process.env.MEMORY_FLUSH_CHUNK_TARGET_K;
    clearEnv();
  });
  withYaml(`flush:\n  chunkTargetK: 7\n`, () => {
    assert.equal(flushChunkTargetK(), 7);
  });
});

test("BREAKING: process.env.MEMORY_HOOK_MAX_TURNS has NO effect", (t) => {
  clearEnv();
  process.env.MEMORY_HOOK_MAX_TURNS = "1000";
  t.after(() => {
    delete process.env.MEMORY_HOOK_MAX_TURNS;
    clearEnv();
  });
  withYaml(`hook:\n  maxTurns: 42\n`, () => {
    assert.equal(hookMaxTurns(), 42);
  });
});

// ─── In-memory test seam ──────────────────────────────────────────────────

test("__setSettingsForTest deep-merges into the cached singleton", () => {
  clearEnv();
  withYaml(`consolidate:\n  cosineThreshold: 0.91\n  staleAfterMonths: 6\n`, () => {
    assert.equal(consolidateCosineThreshold(), 0.91);
    __setSettingsForTest({ consolidate: { cosineThreshold: 0.42 } });
    assert.equal(consolidateCosineThreshold(), 0.42, "test seam wins");
    // Other YAML keys preserved (deep merge, not replace).
    assert.equal(settings().consolidate.staleAfterMonths, 6);
    __clearSettingsForTest();
    assert.equal(consolidateCosineThreshold(), 0.91, "clearing restores YAML");
  });
});

test("__setSettingsForTest works for nested sections including providers", () => {
  clearEnv();
  withYaml(null, () => {
    __setSettingsForTest({
      providers: { chain: ["mock"], mock: { models: [] } },
      flush: { chunkTargetK: 3 },
    });
    assert.deepEqual([...settings().providers.chain], ["mock"]);
    assert.equal(flushChunkTargetK(), 3);
    __clearSettingsForTest();
  });
});

// ─── Caching ──────────────────────────────────────────────────────────────

test("settings() caches by mtime — re-call is fast and stable until file changes", () => {
  clearEnv();
  const yamlPath = path.join(TMP_DATA_DIR, "settings", "settings.yaml");
  fs.writeFileSync(yamlPath, `flush:\n  chunkTargetK: 3\n`);
  try {
    assert.equal(flushChunkTargetK(), 3);
    // No filesystem change → cached value returned even if we touch the
    // function many times.
    for (let i = 0; i < 50; i++) assert.equal(flushChunkTargetK(), 3);
    // Touch the YAML with new mtime + new value → cache invalidates.
    const future = (Date.now() + 1000) / 1000;
    fs.writeFileSync(yamlPath, `flush:\n  chunkTargetK: 11\n`);
    fs.utimesSync(yamlPath, future, future);
    assert.equal(flushChunkTargetK(), 11);
  } finally {
    fs.rmSync(yamlPath, { force: true });
    __clearSettingsForTest();
  }
});

// ─── Validation: bad values fall back to defaults (no crash) ──────────────

test("invalid numeric values in YAML fall back to structural defaults", () => {
  clearEnv();
  withYaml(
    `flush:\n  chunkTargetK: -1\n  chunkParallelism: 0\n  reduceMaxChars: not-a-number\n`,
    () => {
      const s = settings();
      assert.equal(s.flush.chunkTargetK, 5);
      assert.equal(s.flush.chunkParallelism, 1);
      assert.equal(s.flush.reduceMaxChars, 30_000);
    },
  );
});

// ─── Auto-detect chain ────────────────────────────────────────────────────

test("auto-detect: anthropic key present -> anthropic heads the chain", () => {
  clearEnv();
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    withYaml(null, () => {
      const s = settings({ cmdProbe: () => false });
      assert.equal(s.providers.chain[0], "anthropic");
    });
  } finally {
    clearEnv();
  }
});

test("auto-detect: empty YAML chain + no env keys + no CLI -> empty chain", () => {
  clearEnv();
  withYaml(null, () => {
    const s = settings({ cmdProbe: () => false });
    assert.deepEqual([...s.providers.chain], []);
  });
});

// ─── Provider helpers ─────────────────────────────────────────────────────

test("isCliProvider / isApiProvider classify each known provider", () => {
  for (const cli of ["claude", "codex", "cursor"]) {
    assert.equal(isCliProvider(cli), true);
    assert.equal(isApiProvider(cli), false);
  }
  for (const api of ["anthropic", "openai", "openai-compatible"]) {
    assert.equal(isApiProvider(api), true);
    assert.equal(isCliProvider(api), false);
  }
});

test("pickStrongerModel: tail returns same; unknown returns head; empty returns same", () => {
  const list = ["t1", "t2", "t3"];
  assert.equal(pickStrongerModel("t1", list), "t2");
  assert.equal(pickStrongerModel("t2", list), "t3");
  assert.equal(pickStrongerModel("t3", list), "t3");
  assert.equal(pickStrongerModel("unknown", list), "t1");
  assert.equal(pickStrongerModel("anything", []), "anything");
});

test("resolvedChain flattens providers + their model lists in chain order", () => {
  clearEnv();
  withYaml(`providers:\n  chain: [anthropic, claude]\n  anthropic:\n    models: [a, b]\n`, () => {
    const chain = resolvedChain();
    assert.equal(chain.length, 2);
    assert.equal(chain[0].provider, "anthropic");
    assert.deepEqual([...chain[0].models], ["a", "b"]);
    assert.equal(chain[1].provider, "claude");
    assert.deepEqual([...chain[1].models], []);
  });
});

// ─── Frozen ───────────────────────────────────────────────────────────────

test("returned settings object is deeply frozen", () => {
  clearEnv();
  withYaml(null, () => {
    const s = settings({ cmdProbe: () => true });
    assert.throws(() => {
      s.flush.chunkTargetK = 999;
    }, TypeError);
    assert.throws(() => {
      s.providers.chain[0] = "garbage";
    }, TypeError);
    assert.throws(() => {
      s.providers.anthropic.models[0] = "garbage";
    }, TypeError);
  });
});

test("settingsPath honors MEMORY_SETTINGS_PATH env when absolute", () => {
  clearEnv();
  process.env.MEMORY_SETTINGS_PATH = "/tmp/custom-settings.yaml";
  try {
    assert.equal(settingsPath(), "/tmp/custom-settings.yaml");
  } finally {
    clearEnv();
  }
});

test("__testing.KNOWN_PROVIDERS exposed for downstream validation", () => {
  assert.ok(__testing.KNOWN_PROVIDERS.includes("anthropic"));
  assert.ok(__testing.KNOWN_PROVIDERS.includes("cursor"));
});

// ─── flush.reduceModelPromote opt-out (regression guard for B1) ───────────

test("flush.reduceModelPromote defaults to true when YAML doesn't supply it", () => {
  clearEnv();
  withYaml(null, () => {
    assert.equal(settings({ cmdProbe: () => true }).flush.reduceModelPromote, true);
  });
});

test("flush.reduceModelPromote: false in YAML is honored (the opt-out actually works)", () => {
  clearEnv();
  withYaml(`flush:\n  reduceModelPromote: false\n`, () => {
    assert.equal(settings().flush.reduceModelPromote, false);
  });
});

test("flush.reduceModelPromote: true in YAML round-trips", () => {
  clearEnv();
  withYaml(`flush:\n  reduceModelPromote: true\n`, () => {
    assert.equal(settings().flush.reduceModelPromote, true);
  });
});

test("settings override aliases: __setSettingsForTest === __setSettingsOverride", async () => {
  const m = await import("../scripts/lib/settings.mjs");
  assert.equal(m.__setSettingsForTest, m.__setSettingsOverride);
  assert.equal(m.__clearSettingsForTest, m.__clearSettingsOverride);
});

// ─── withSettingsOverride: concurrent-safe per-frame override ─────────────

test("withSettingsOverride: two concurrent frames each see their own override", async () => {
  const m = await import("../scripts/lib/settings.mjs");
  clearEnv();
  // Each parallel call gets its own AsyncLocalStorage frame; the override
  // does NOT leak between them. Without the frame this would race.
  const [a, b] = await Promise.all([
    m.withSettingsOverride({ consolidate: { cosineThreshold: 0.5 } }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return m.settings().consolidate.cosineThreshold;
    }),
    m.withSettingsOverride({ consolidate: { cosineThreshold: 0.9 } }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return m.settings().consolidate.cosineThreshold;
    }),
  ]);
  assert.equal(a, 0.5, "frame A's cosineThreshold is its own");
  assert.equal(b, 0.9, "frame B's cosineThreshold is its own");
});

test("withSettingsOverride: frame supersedes the global seam inside that frame", async () => {
  const m = await import("../scripts/lib/settings.mjs");
  clearEnv();
  m.__setSettingsOverride({ consolidate: { cosineThreshold: 0.1 } });
  try {
    // Outside the frame: the global seam is in effect.
    assert.equal(m.settings().consolidate.cosineThreshold, 0.1);
    // Inside the frame: the frame wins.
    const inside = await m.withSettingsOverride(
      { consolidate: { cosineThreshold: 0.7 } },
      async () => m.settings().consolidate.cosineThreshold,
    );
    assert.equal(inside, 0.7);
    // After the frame: the global seam is back.
    assert.equal(m.settings().consolidate.cosineThreshold, 0.1);
  } finally {
    m.__clearSettingsOverride();
  }
});

test("withSettingsOverride: a frame does not poison the cache for a later plain settings() call", async () => {
  const m = await import("../scripts/lib/settings.mjs");
  clearEnv();
  withYaml(`consolidate:\n  cosineThreshold: 0.33\n`, () => {
    return m.withSettingsOverride({ consolidate: { cosineThreshold: 0.99 } }, () => {
      assert.equal(m.settings().consolidate.cosineThreshold, 0.99, "inside frame: override wins");
    });
  });
  // After the frame, with no override active, a fresh load returns the YAML
  // value — the frame build was never persisted to the cache.
  withYaml(`consolidate:\n  cosineThreshold: 0.33\n`, () => {
    assert.equal(
      m.settings().consolidate.cosineThreshold,
      0.33,
      "after frame: YAML value, no poisoning",
    );
  });
});

// ─── numeric/float/bool coercion (the catastrophic-data-loss guard) ───────

test("coercion: a string cosineThreshold falls back to the default (NOT a corrupt comparison)", () => {
  clearEnv();
  withYaml(`consolidate:\n  cosineThreshold: high\n`, () => {
    assert.equal(
      consolidateCosineThreshold(),
      0.97,
      "string → structural default, not NaN/garbage",
    );
  });
});

test("coercion: empty-string / null cosineThreshold does NOT become 0 (would archive everything)", () => {
  clearEnv();
  withYaml(`consolidate:\n  cosineThreshold: ""\n`, () => {
    assert.equal(consolidateCosineThreshold(), 0.97, "empty string must NOT coerce to 0");
  });
  withYaml(`consolidate:\n  cosineThreshold:\n`, () => {
    assert.equal(consolidateCosineThreshold(), 0.97, "null (bare key) must NOT coerce to 0");
  });
});

test("coercion: out-of-range float (>1) falls back; in-range survives", () => {
  clearEnv();
  withYaml(`consolidate:\n  cosineThreshold: 1.5\n`, () => {
    assert.equal(consolidateCosineThreshold(), 0.97);
  });
  withYaml(`consolidate:\n  cosineThreshold: 0.6\n`, () => {
    assert.equal(consolidateCosineThreshold(), 0.6);
  });
});

test("coercion: clusterTopK string/zero/negative → default; positive survives", () => {
  clearEnv();
  withYaml(`consolidate:\n  clusterTopK: lots\n`, () =>
    assert.equal(settings().consolidate.clusterTopK, 12),
  );
  withYaml(`consolidate:\n  clusterTopK: 0\n`, () =>
    assert.equal(settings().consolidate.clusterTopK, 12),
  );
  withYaml(`consolidate:\n  clusterTopK: -3\n`, () =>
    assert.equal(settings().consolidate.clusterTopK, 12),
  );
  withYaml(`consolidate:\n  clusterTopK: 20\n`, () =>
    assert.equal(settings().consolidate.clusterTopK, 20),
  );
});

test("coercion: intervalDays accepts 0 (disabled) but rejects garbage", () => {
  clearEnv();
  withYaml(`consolidate:\n  intervalDays: 0\n`, () =>
    assert.equal(settings().consolidate.intervalDays, 0),
  );
  withYaml(`gc:\n  intervalDays: 0\n`, () => assert.equal(settings().gc.intervalDays, 0));
  withYaml(`consolidate:\n  intervalDays: weekly\n`, () =>
    assert.equal(settings().consolidate.intervalDays, 1),
  );
});

test("coercion: a quoted-string bool does NOT become truthy at the accessor", () => {
  clearEnv();
  // YAML `"false"` is a string; without coercion Boolean("false") === true.
  withYaml(`consolidate:\n  llmPassesEnabled: "false"\n`, () => {
    assert.equal(
      settings().consolidate.llmPassesEnabled,
      true,
      "non-bool → structural default (true)",
    );
  });
  withYaml(`gate:\n  selfImprovementEnabled: false\n`, () => {
    assert.equal(settings().gate.selfImprovementEnabled, false, "real YAML bool false honored");
  });
});

test("write-gate fails CLOSED: a null/empty/commented selfImprovementEnabled stays ENABLED", () => {
  clearEnv();
  // The single most safety-critical knob. An empty or commented-out value
  // (both extremely common hand-edits) parses to null. A Boolean(null) → false
  // pre-coercion used to DISABLE the gate silently (fail-open). It must default
  // back to enabled, while an explicit `false` still disables.
  for (const yaml of [
    `gate:\n  selfImprovementEnabled:\n`, // bare key, no value → null
    `gate:\n  selfImprovementEnabled: null\n`, // explicit null
    `gate:\n  selfImprovementEnabled: # off later\n`, // trailing comment, no value → null
  ]) {
    withYaml(yaml, () => {
      assert.equal(
        settings().gate.selfImprovementEnabled,
        true,
        `must fail CLOSED (enabled) for: ${JSON.stringify(yaml)}`,
      );
      assert.equal(writeGateSelfImprovementEnabled(), true, "accessor agrees the gate is enabled");
    });
  }
  // Explicit disable still works (operator override is not clobbered).
  withYaml(`gate:\n  selfImprovementEnabled: false\n`, () => {
    assert.equal(writeGateSelfImprovementEnabled(), false, "explicit false still disables");
  });
});

test("L2 hook knob fails CLOSED: null/empty claudeHookEnabled stays ENABLED; explicit false disables", () => {
  clearEnv();
  for (const yaml of [
    `gate:\n  claudeHookEnabled:\n`, // bare key, no value → null
    `gate:\n  claudeHookEnabled: null\n`, // explicit null
  ]) {
    withYaml(yaml, () => {
      assert.equal(
        settings().gate.claudeHookEnabled,
        true,
        `must fail CLOSED (enabled) for: ${JSON.stringify(yaml)}`,
      );
      assert.equal(writeGateClaudeHookEnabled(), true, "accessor agrees the hook stays enabled");
    });
  }
  withYaml(`gate:\n  claudeHookEnabled: false\n`, () => {
    assert.equal(writeGateClaudeHookEnabled(), false, "explicit false disables the L2 hook");
    assert.equal(
      settings().gate.selfImprovementEnabled,
      true,
      "L3 knob unaffected by the L2 toggle",
    );
  });
});

test("cron logging + healing knobs coerce like their consolidate siblings", () => {
  clearEnv();
  withYaml(
    `consolidate:\n  attemptsKeep: 0\n  fullLogRetentionDays: -3\n  escalateAfterAttempts: "x"\n`,
    () => {
      const c = settings().consolidate;
      assert.equal(c.attemptsKeep, 50, "zero → default");
      assert.equal(c.fullLogRetentionDays, 90, "negative → default");
      assert.equal(c.escalateAfterAttempts, 3, "non-numeric → default");
    },
  );
  withYaml(
    `consolidate:\n  attemptsKeep: 10\n  fullLogRetentionDays: 30\n  escalateAfterAttempts: 5\n`,
    () => {
      const c = settings().consolidate;
      assert.equal(c.attemptsKeep, 10);
      assert.equal(c.fullLogRetentionDays, 30);
      assert.equal(c.escalateAfterAttempts, 5);
    },
  );
});

test("wiki.autoCommit defaults true, honours explicit false, fails safe on null", () => {
  clearEnv();
  assert.equal(settings().wiki.autoCommit, true);
  withYaml(`wiki:\n  autoCommit: false\n`, () => {
    assert.equal(settings().wiki.autoCommit, false);
  });
  withYaml(`wiki:\n  autoCommit:\n`, () => {
    assert.equal(settings().wiki.autoCommit, true, "null/empty falls back to enabled");
  });
});

test("recall.recentActivityDays / planContextMax default, honour values, fail safe on garbage", () => {
  clearEnv();
  assert.equal(settings().recall.recentActivityDays, 3);
  assert.equal(settings().recall.planContextMax, 2);
  withYaml(`recall:\n  recentActivityDays: 5\n  planContextMax: 1\n`, () => {
    assert.equal(settings().recall.recentActivityDays, 5);
    assert.equal(settings().recall.planContextMax, 1);
  });
  withYaml(`recall:\n  recentActivityDays: 0\n  planContextMax: 0\n`, () => {
    assert.equal(settings().recall.recentActivityDays, 0, "0 is honoured (disables the reminder)");
    assert.equal(settings().recall.planContextMax, 0);
  });
  withYaml(`recall:\n  recentActivityDays: nope\n`, () => {
    assert.equal(settings().recall.recentActivityDays, 3, "garbage falls back to the default");
  });
});

// ─── BREAKING contract: table-driven over EVERY removed env var ───────────

test("BREAKING: every removed MEMORY_* env var is a no-op (table-driven over the full set)", async () => {
  clearEnv();
  // The migrator's ENV_TO_SETTINGS map is the canonical list of removed vars.
  const { ENV_TO_SETTINGS } = await import("../scripts/migrate-settings.mjs");
  // Map each removed env var to a settings accessor that reads its target so
  // we can assert the env value is ignored and the YAML value wins.
  const sampleByPath = {
    "consolidate.cosineThreshold": {
      yaml: `consolidate:\n  cosineThreshold: 0.42\n`,
      read: () => settings().consolidate.cosineThreshold,
      expect: 0.42,
      env: "0.99",
    },
    "consolidate.intervalDays": {
      yaml: `consolidate:\n  intervalDays: 3\n`,
      read: () => settings().consolidate.intervalDays,
      expect: 3,
      env: "9",
    },
    "flush.chunkTargetK": {
      yaml: `flush:\n  chunkTargetK: 7\n`,
      read: () => settings().flush.chunkTargetK,
      expect: 7,
      env: "99",
    },
    "hook.maxTurns": {
      yaml: `hook:\n  maxTurns: 11\n`,
      read: () => settings().hook.maxTurns,
      expect: 11,
      env: "999",
    },
    "embed.model": {
      yaml: `embed:\n  model: fixture-bge\n`,
      read: () => settings().embed.model,
      expect: "fixture-bge",
      env: "Xenova/other",
    },
    "consolidate.enabled": {
      yaml: `consolidate:\n  enabled: true\n`,
      read: () => settings().consolidate.enabled,
      expect: true,
      env: "off",
    },
    "gc.intervalDays": {
      yaml: `gc:\n  intervalDays: 14\n`,
      read: () => settings().gc.intervalDays,
      expect: 14,
      env: "1",
    },
    "compile.atomBodyMaxChars": {
      yaml: `compile:\n  atomBodyMaxChars: 555\n`,
      read: () => settings().compile.atomBodyMaxChars,
      expect: 555,
      env: "1",
    },
    "gate.selfImprovementEnabled": {
      yaml: `gate:\n  selfImprovementEnabled: false\n`,
      read: () => settings().gate.selfImprovementEnabled,
      expect: false,
      env: "on",
    },
  };
  // Reverse-map: which env var(s) target each sampled path.
  const pathToEnv = {};
  for (const [envVar, p] of Object.entries(ENV_TO_SETTINGS)) {
    (pathToEnv[p] ||= []).push(envVar);
  }
  let asserted = 0;
  for (const [p, spec] of Object.entries(sampleByPath)) {
    const envVars = pathToEnv[p] || [];
    assert.ok(envVars.length > 0, `expected a removed env var mapping to ${p}`);
    for (const envVar of envVars) process.env[envVar] = spec.env;
    try {
      withYaml(spec.yaml, () => {
        assert.deepEqual(
          spec.read(),
          spec.expect,
          `${envVars.join("/")} must be ignored; YAML ${p} wins`,
        );
      });
      asserted++;
    } finally {
      for (const envVar of envVars) delete process.env[envVar];
    }
  }
  assert.ok(asserted >= 9, "covered the representative removed-var set across all 8 sections + gc");
});

// ─── code-default ↔ template parity (the four-surface drift guard) ────────

test("parity: every scalar structural default in buildSettings matches templates/settings.yaml", () => {
  clearEnv();
  // Pure code defaults: load an EMPTY config (no user file, bypass template
  // fallback by pointing at a real empty temp file).
  const emptyPath = path.join(TMP_DATA_DIR, "settings", "empty.yaml");
  fs.writeFileSync(emptyPath, "{}\n");
  const codeDefaults = settings({ configPath: emptyPath, cmdProbe: () => false });
  // Template values: load the shipped template directly.
  const templateVals = settings({ configPath: __testing.TEMPLATE_PATH, cmdProbe: () => false });

  // Every scalar knob (excludes providers model-lists + chain + crossCuttingAreas,
  // which intentionally differ: code ships [], template ships the model lists).
  const scalarSections = [
    "consolidate",
    "flush",
    "hook",
    "embed",
    "recall",
    "compile",
    "gc",
    "gate",
    "wiki",
  ];
  for (const section of scalarSections) {
    for (const key of Object.keys(codeDefaults[section])) {
      assert.deepEqual(
        templateVals[section][key],
        codeDefaults[section][key],
        `DRIFT: ${section}.${key} differs — code default=${JSON.stringify(codeDefaults[section][key])}, template=${JSON.stringify(templateVals[section][key])}`,
      );
    }
  }
  fs.rmSync(emptyPath, { force: true });
});

test("parity: provider model lists live in the template, NOT in code defaults", () => {
  clearEnv();
  const emptyPath = path.join(TMP_DATA_DIR, "settings", "empty2.yaml");
  fs.writeFileSync(emptyPath, "{}\n");
  const codeDefaults = settings({ configPath: emptyPath, cmdProbe: () => false });
  const templateVals = settings({ configPath: __testing.TEMPLATE_PATH, cmdProbe: () => false });
  // Code ships empty model lists (no model name strings in code).
  assert.deepEqual([...codeDefaults.providers.anthropic.models], []);
  assert.deepEqual([...codeDefaults.providers.openai.models], []);
  // Template ships the actual lists.
  assert.ok(templateVals.providers.anthropic.models.length > 0, "template ships anthropic models");
  assert.ok(templateVals.providers.openai.models.length > 0, "template ships openai models");
  fs.rmSync(emptyPath, { force: true });
});

test("cosineBandFloor: valid value passes, invalid/out-of-range values fail-safe to null", () => {
  clearEnv();
  withYaml("consolidate:\n  cosineBandFloor: 0.9\n", () => {
    const s = settings();
    assert.equal(s.consolidate.cosineBandFloor, 0.9, "0.9 under the 0.97 threshold is accepted");
  });
  withYaml("consolidate:\n  cosineBandFloor: 0.5\n", () => {
    assert.equal(settings().consolidate.cosineBandFloor, null, "below 0.8 disables the band");
  });
  withYaml("consolidate:\n  cosineBandFloor: 0.98\n", () => {
    assert.equal(settings().consolidate.cosineBandFloor, null, ">= threshold disables the band");
  });
  withYaml("consolidate:\n  cosineBandFloor: ''\n", () => {
    assert.equal(settings().consolidate.cosineBandFloor, null, "empty string disables");
  });
  withYaml("consolidate: {}\n", () => {
    assert.equal(settings().consolidate.cosineBandFloor, null, "absent key defaults to disabled");
  });
  withYaml("consolidate:\n  cosineThreshold: 0.92\n  cosineBandFloor: 0.95\n", () => {
    assert.equal(
      settings().consolidate.cosineBandFloor,
      null,
      "floor above a lowered threshold disables",
    );
  });
  withYaml("consolidate:\n  cosineThreshold: 0.92\n  cosineBandFloor: 0.85\n", () => {
    assert.equal(
      settings().consolidate.cosineBandFloor,
      0.85,
      "floor under a lowered threshold is accepted",
    );
  });
});

test("recall.priorityBand: coerced via coerceFloat01 (valid kept; invalid / out-of-range -> default 0.05)", () => {
  withYaml("recall:\n  priorityBand: 0.12\n", () => {
    assert.equal(settings().recall.priorityBand, 0.12, "valid value in [0,1] is kept");
  });
  withYaml("recall:\n  priorityBand: nope\n", () => {
    assert.equal(settings().recall.priorityBand, 0.05, "non-number falls back to the default");
  });
  withYaml("recall:\n  priorityBand: 1.5\n", () => {
    assert.equal(settings().recall.priorityBand, 0.05, "out of [0,1] falls back to the default");
  });
  withYaml("recall: {}\n", () => {
    assert.equal(settings().recall.priorityBand, 0.05, "absent key defaults to 0.05");
  });
});

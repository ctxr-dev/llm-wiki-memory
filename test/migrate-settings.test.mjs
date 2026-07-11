import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { runScript } from "./harness.mjs";

const { migrate } = await import("../scripts/migrate-settings.mjs");

const tmpDirs = [];
function makeDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-settings-"));
  fs.mkdirSync(path.join(d, "settings"), { recursive: true });
  tmpDirs.push(d);
  return d;
}

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function writeEnv(dataDir, contents) {
  fs.writeFileSync(path.join(dataDir, "settings", ".env"), contents);
}
function writeLlmYaml(dataDir, contents) {
  fs.writeFileSync(path.join(dataDir, "settings", "llm.yaml"), contents);
}
function writeSettingsYaml(dataDir, contents) {
  fs.writeFileSync(path.join(dataDir, "settings", "settings.yaml"), contents);
}
function readYaml(dataDir, name) {
  return parseYaml(fs.readFileSync(path.join(dataDir, "settings", name), "utf8"));
}
function noop() {}

test("fresh install (no .env, no llm.yaml): migrate is a no-op", () => {
  const dir = makeDataDir();
  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, "fresh-install");
});

test("already-migrated install (settings.yaml exists, no removed env keys, no llm.yaml): no-op", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\n");
  fs.writeFileSync(path.join(dir, "settings", "settings.yaml"), "flush:\n  chunkTargetK: 5\n");
  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, false);
  assert.equal(result.reason, "already-migrated");
});

test("upgrade: old .env with consolidate threshold → migrated to settings.yaml", () => {
  const dir = makeDataDir();
  writeEnv(
    dir,
    [
      "MEMORY_LLM_PROVIDER=claude",
      "ANTHROPIC_API_KEY=sk-test",
      "MEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.88",
      "MEMORY_CONSOLIDATE_CLUSTER_TOP_K=20",
      "MEMORY_FLUSH_CHUNK_TARGET_K=7",
      "MEMORY_HOOK_MAX_TURNS=42",
      "MEMORY_EMBED_MODEL=Xenova/bge-small-en-v1.5",
      "MEMORY_CONSOLIDATE_ENABLED=true",
      "MEMORY_WRITE_GATE_SELF_IMPROVEMENT=off",
    ].join("\n") + "\n",
  );
  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, true);
  assert.ok(result.appliedEnvKeys.includes("MEMORY_CONSOLIDATE_COSINE_THRESHOLD"));
  assert.ok(result.appliedEnvKeys.includes("MEMORY_FLUSH_CHUNK_TARGET_K"));
  assert.ok(result.appliedEnvKeys.includes("MEMORY_HOOK_MAX_TURNS"));

  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.consolidate.cosineThreshold, 0.88);
  assert.equal(yaml.consolidate.clusterTopK, 20);
  assert.equal(yaml.flush.chunkTargetK, 7);
  assert.equal(yaml.hook.maxTurns, 42);
  assert.equal(yaml.embed.model, "Xenova/bge-small-en-v1.5");
  assert.equal(yaml.consolidate.enabled, true);
  assert.equal(yaml.gate.selfImprovementEnabled, false);

  // .env backed up.
  const bak = fs.readFileSync(path.join(dir, "settings", ".env.bak"), "utf8");
  assert.match(bak, /MEMORY_CONSOLIDATE_COSINE_THRESHOLD=0\.88/);

  // .env shrunk to strict subset: provider + secret stay; non-strict gone.
  const env = fs.readFileSync(path.join(dir, "settings", ".env"), "utf8");
  assert.match(env, /MEMORY_LLM_PROVIDER=claude/);
  assert.match(env, /ANTHROPIC_API_KEY=sk-test/);
  assert.doesNotMatch(env, /MEMORY_CONSOLIDATE_COSINE_THRESHOLD/);
  assert.doesNotMatch(env, /MEMORY_FLUSH_CHUNK_TARGET_K/);
  assert.doesNotMatch(env, /MEMORY_HOOK_MAX_TURNS/);
});

test("upgrade: old llm.yaml merged into settings.yaml, then removed", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=anthropic\n");
  writeLlmYaml(
    dir,
    `providers:\n  chain: [anthropic, openai]\n  anthropic:\n    models: [fixture-m1, fixture-m2]\nflush:\n  chunkTargetK: 4\n`,
  );
  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, true);

  const yaml = readYaml(dir, "settings.yaml");
  assert.deepEqual(yaml.providers.chain, ["anthropic", "openai"]);
  assert.deepEqual(yaml.providers.anthropic.models, ["fixture-m1", "fixture-m2"]);
  assert.equal(yaml.flush.chunkTargetK, 4);

  // Old llm.yaml is gone.
  assert.equal(fs.existsSync(path.join(dir, "settings", "llm.yaml")), false);
});

test("upgrade is idempotent — re-running on a migrated install is a no-op", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.91\n");
  const first = migrate(dir, { log: noop });
  assert.equal(first.migrated, true);
  const second = migrate(dir, { log: noop });
  assert.equal(second.migrated, false);
  assert.equal(second.reason, "already-migrated");
});

test("dryRun returns the would-be-written content without touching disk", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_FLUSH_CHUNK_TARGET_K=3\n");
  const result = migrate(dir, { dryRun: true, log: noop });
  assert.equal(result.migrated, true);
  assert.equal(result.dryRun, true);
  assert.match(result.settingsYamlText, /chunkTargetK: 3/);
  assert.match(result.newEnvText, /MEMORY_LLM_PROVIDER=claude/);
  assert.doesNotMatch(result.newEnvText, /MEMORY_FLUSH_CHUNK_TARGET_K/);
  // Disk untouched: no settings.yaml, no .env.bak.
  assert.equal(fs.existsSync(path.join(dir, "settings", "settings.yaml")), false);
  assert.equal(fs.existsSync(path.join(dir, "settings", ".env.bak")), false);
});

test("BOOL coercion: 'off' → false, 'true' → true; garbage skipped", () => {
  const dir = makeDataDir();
  writeEnv(
    dir,
    [
      "MEMORY_LLM_PROVIDER=claude",
      "MEMORY_CONSOLIDATE_ENABLED=off",
      "MEMORY_CONSOLIDATE_LLM_PASSES=true",
      "MEMORY_COMPILE_QUALITY_STRICT=garbage",
    ].join("\n") + "\n",
  );
  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, true);
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.consolidate.enabled, false);
  assert.equal(yaml.consolidate.llmPassesEnabled, true);
  // Garbage bool falls back to the template's default (false).
  assert.equal(yaml.compile.qualityStrict, false);
});

test("FLOAT coercion: cosine threshold parses as number", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.85\n");
  migrate(dir, { log: noop });
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(typeof yaml.consolidate.cosineThreshold, "number");
  assert.equal(yaml.consolidate.cosineThreshold, 0.85);
});

test("CSV → array coercion for crossCuttingAreas", () => {
  const dir = makeDataDir();
  writeEnv(
    dir,
    "MEMORY_LLM_PROVIDER=claude\nMEMORY_CROSS_CUTTING_AREAS=workspace,conventions,tooling\n",
  );
  migrate(dir, { log: noop });
  const yaml = readYaml(dir, "settings.yaml");
  assert.deepEqual(yaml.crossCuttingAreas, ["workspace", "conventions", "tooling"]);
});

// ─── regression: MEMORY_EMBED_CACHE_DIR + MEMORY_LLM_CONFIG_PATH rename ───

test("regression: upgrade preserves MEMORY_EMBED_CACHE_DIR through the .env rewrite", () => {
  const dir = makeDataDir();
  writeEnv(
    dir,
    "MEMORY_LLM_PROVIDER=anthropic\nMEMORY_EMBED_CACHE_DIR=/Users/dev/cache/transformers\n",
  );
  migrate(dir, { log: noop });
  const env = fs.readFileSync(path.join(dir, "settings", ".env"), "utf8");
  assert.match(env, /MEMORY_EMBED_CACHE_DIR=\/Users\/dev\/cache\/transformers/);
  assert.match(env, /MEMORY_LLM_PROVIDER=anthropic/);
});

test("regression: MEMORY_LLM_CONFIG_PATH renames to MEMORY_SETTINGS_PATH", () => {
  const dir = makeDataDir();
  writeEnv(
    dir,
    "MEMORY_LLM_PROVIDER=claude\nMEMORY_LLM_CONFIG_PATH=/custom/path/to/settings.yaml\n",
  );
  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, true);
  assert.ok(
    result.renamedKeys &&
      result.renamedKeys.some(
        (r) => r.oldName === "MEMORY_LLM_CONFIG_PATH" && r.newName === "MEMORY_SETTINGS_PATH",
      ),
    "renamedKeys array should record MEMORY_LLM_CONFIG_PATH → MEMORY_SETTINGS_PATH",
  );
  const env = fs.readFileSync(path.join(dir, "settings", ".env"), "utf8");
  assert.match(env, /MEMORY_SETTINGS_PATH=\/custom\/path\/to\/settings\.yaml/);
  assert.doesNotMatch(env, /MEMORY_LLM_CONFIG_PATH/);
});

test("regression: MEMORY_LLM_CONFIG_PATH rename triggers migration even with no other removed keys", () => {
  const dir = makeDataDir();
  // Only the rename — no other removed keys, no llm.yaml. Without the rename
  // handling the migrator would early-out as "fresh install".
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_LLM_CONFIG_PATH=/x.yaml\n");
  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, true);
  assert.equal(result.renamedKeys.length, 1);
});

// ─── env-serializer round-trip: raw RHS survives the .env rewrite verbatim ─

function parsedEnvValue(raw) {
  let v = String(raw ?? "").trim();
  if (!v) return "";
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end !== -1) return v.slice(1, end);
    return v;
  }
  if (v[0] === "#") return "";
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}

function rewrittenRhs(envText, key) {
  for (const line of envText.split(/\r?\n/)) {
    const trim = line.trim();
    if (!trim || trim.startsWith("#")) continue;
    const i = trim.indexOf("=");
    if (i === -1) continue;
    if (trim.slice(0, i).trim() === key) return trim.slice(i + 1);
  }
  return undefined;
}

test("round-trip: strict-subset values with ' #' and quoted-spaces survive the .env rewrite verbatim", () => {
  const dir = makeDataDir();
  const mockResponseRhs = '{"answer":"42"} # inline-comment-with-hash';
  const mockFileRhs = '"/tmp/seam fixtures/mock #1.json"';
  writeEnv(
    dir,
    [
      "MEMORY_LLM_PROVIDER=claude",
      // A strict-subset test seam whose value contains a literal ' #': the old
      // serializer emitted the PARSED value and truncated everything at ' #'.
      `MEMORY_LLM_MOCK_RESPONSE=${mockResponseRhs}`,
      // A quoted value with spaces (and a '#' inside the quotes): the old
      // serializer dropped the quotes, so the path would lose its quoting.
      `MEMORY_LLM_MOCK_FILE=${mockFileRhs}`,
      // Force a real migration so the .env actually gets rewritten.
      "MEMORY_FLUSH_CHUNK_TARGET_K=7",
    ].join("\n") + "\n",
  );

  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, true);

  const env = fs.readFileSync(path.join(dir, "settings", ".env"), "utf8");

  // The raw RHS text is re-emitted byte-for-byte (the fix): not the truncated
  // parsed value the old serializer produced.
  assert.equal(rewrittenRhs(env, "MEMORY_LLM_MOCK_RESPONSE"), mockResponseRhs);
  assert.equal(rewrittenRhs(env, "MEMORY_LLM_MOCK_FILE"), mockFileRhs);

  // The ' #' tail and the quote characters genuinely made it through — a
  // truncating/quote-stripping serializer would fail one of these.
  assert.match(env, /MEMORY_LLM_MOCK_RESPONSE=.*# inline-comment-with-hash/);
  assert.match(env, /MEMORY_LLM_MOCK_FILE="\/tmp\/seam fixtures\/mock #1\.json"/);

  // Round-trip: re-parsing the rewritten RHS yields the SAME parsed value as
  // parsing the original RHS — the migration no longer corrupts these seams.
  assert.equal(
    parsedEnvValue(rewrittenRhs(env, "MEMORY_LLM_MOCK_RESPONSE")),
    parsedEnvValue(mockResponseRhs),
  );
  assert.equal(parsedEnvValue(rewrittenRhs(env, "MEMORY_LLM_MOCK_RESPONSE")), '{"answer":"42"}');
  assert.equal(
    parsedEnvValue(rewrittenRhs(env, "MEMORY_LLM_MOCK_FILE")),
    parsedEnvValue(mockFileRhs),
  );
  assert.equal(
    parsedEnvValue(rewrittenRhs(env, "MEMORY_LLM_MOCK_FILE")),
    "/tmp/seam fixtures/mock #1.json",
  );
});

test("round-trip: a renamed strict key carries its RAW value forward under the new name", () => {
  const dir = makeDataDir();
  // Quoted path with spaces under the OLD name; after the rename it must
  // appear verbatim under MEMORY_SETTINGS_PATH (raw RHS, not parsed).
  const configPathRhs = '"/Users/dev/my settings/settings.yaml"';
  writeEnv(
    dir,
    ["MEMORY_LLM_PROVIDER=claude", `MEMORY_LLM_CONFIG_PATH=${configPathRhs}`].join("\n") + "\n",
  );

  const result = migrate(dir, { log: noop });
  assert.equal(result.migrated, true);
  assert.ok(
    result.renamedKeys.some(
      (r) => r.oldName === "MEMORY_LLM_CONFIG_PATH" && r.newName === "MEMORY_SETTINGS_PATH",
    ),
  );

  const env = fs.readFileSync(path.join(dir, "settings", ".env"), "utf8");
  assert.doesNotMatch(env, /MEMORY_LLM_CONFIG_PATH/);
  assert.equal(rewrittenRhs(env, "MEMORY_SETTINGS_PATH"), configPathRhs);
  assert.equal(
    parsedEnvValue(rewrittenRhs(env, "MEMORY_SETTINGS_PATH")),
    "/Users/dev/my settings/settings.yaml",
  );
});

// ─── precedence: a hand-edited existing settings.yaml beats stale env ─────

test("precedence: existing settings.yaml WINS over a conflicting removed env var (hand-edit preserved)", () => {
  const dir = makeDataDir();
  // The crash-window / re-run case: settings.yaml already exists with a
  // hand-edited value AND the old .env still carries the removed var.
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.50\n");
  writeSettingsYaml(dir, "consolidate:\n  cosineThreshold: 0.88\n");
  migrate(dir, { log: noop });
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(
    yaml.consolidate.cosineThreshold,
    0.88,
    "hand-edited settings.yaml must win over stale env",
  );
});

test("3-way merge: template + removed env + llm.yaml all present resolve coherently", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=anthropic\nMEMORY_HOOK_MAX_TURNS=42\n");
  writeLlmYaml(
    dir,
    "providers:\n  chain: [anthropic, openai]\n  anthropic:\n    models: [mA, mB]\nflush:\n  chunk_target_k: 4\n",
  );
  // No existing settings.yaml here → env + llm.yaml both apply.
  migrate(dir, { log: noop });
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.hook.maxTurns, 42, "env value migrated");
  assert.deepEqual(yaml.providers.chain, ["anthropic", "openai"], "llm.yaml chain migrated");
  assert.deepEqual(yaml.providers.anthropic.models, ["mA", "mB"], "llm.yaml models migrated");
  assert.equal(yaml.flush.chunkTargetK, 4, "llm.yaml snake_case flush key camelCased");
});

// ─── malformed value: dropped + warned, not silently vanished ─────────────

test("malformed numeric env value is dropped + reported in droppedEnvKeys (not silently lost)", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.9xyz\n");
  const result = migrate(dir, { log: noop });
  assert.ok(Array.isArray(result.droppedEnvKeys));
  assert.ok(
    result.droppedEnvKeys.some((d) => d.envKey === "MEMORY_CONSOLIDATE_COSINE_THRESHOLD"),
    "malformed value should be reported in droppedEnvKeys",
  );
  // settings.yaml keeps the template default (not the garbage value).
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.consolidate.cosineThreshold, 0.97);
});

// ─── round-trip: migrate → buildSettings → accessor returns migrated value ─

test("round-trip: migrated settings.yaml loads through settings() with correct accessor values", async () => {
  const dir = makeDataDir();
  writeEnv(
    dir,
    [
      "MEMORY_LLM_PROVIDER=claude",
      "MEMORY_CONSOLIDATE_ENABLED=on",
      "MEMORY_HOOK_EXITPLANMODE_DISABLE=yes",
      "MEMORY_CONSOLIDATE_INTERVAL_DAYS=0",
      "MEMORY_CROSS_CUTTING_AREAS=infra,billing",
      "MEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.85",
    ].join("\n") + "\n",
  );
  migrate(dir, { log: noop });
  // Point a FRESH settings module at the migrated dir and read via accessors.
  const prevDataDir = process.env.MEMORY_DATA_DIR;
  process.env.MEMORY_DATA_DIR = dir;
  try {
    const s = await import(`../scripts/lib/settings.mjs?roundtrip=${Date.now()}`);
    s.__clearSettingsForTest();
    assert.equal(
      s.consolidateEnabled(),
      true,
      "MEMORY_CONSOLIDATE_ENABLED=on → consolidate.enabled true",
    );
    assert.equal(
      s.hookExitPlanModeDisable(),
      true,
      "EXITPLANMODE_DISABLE=yes → hook.exitPlanModeDisable true",
    );
    assert.equal(
      s.consolidateIntervalDays(),
      0,
      "INTERVAL_DAYS=0 → consolidate.intervalDays 0 (disabled)",
    );
    assert.equal(s.consolidateCosineThreshold(), 0.85);
    assert.deepEqual([...s.crossCuttingAreas()], ["infra", "billing"]);
  } finally {
    if (prevDataDir === undefined) delete process.env.MEMORY_DATA_DIR;
    else process.env.MEMORY_DATA_DIR = prevDataDir;
  }
});

// ─── resilience: a malformed source YAML does NOT abort + revert the migration ─

test("malformed existing settings.yaml is ignored (warned), migration still proceeds", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_HOOK_MAX_TURNS=17\n");
  // A crash-truncated / typo'd existing settings.yaml.
  writeSettingsYaml(dir, "consolidate:\n  cosineThreshold: [oops\nflush: {{{\n");
  const warnings = [];
  let result;
  assert.doesNotThrow(() => {
    result = migrate(dir, { log: (m) => warnings.push(m) });
  }, "a malformed existing settings.yaml must not throw + abort the migration");
  assert.equal(result.migrated, true);
  // The env knob still migrated despite the bad existing YAML.
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.hook.maxTurns, 17);
  // And the operator was warned about the bad file.
  assert.ok(
    warnings.some((w) => /malformed/i.test(w)),
    "should warn about the malformed file",
  );
});

test("malformed old llm.yaml is ignored (warned), env migration still proceeds", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=anthropic\nMEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.8\n");
  writeLlmYaml(dir, "providers: [unterminated\n");
  const warnings = [];
  let result;
  assert.doesNotThrow(() => {
    result = migrate(dir, { log: (m) => warnings.push(m) });
  });
  assert.equal(result.migrated, true);
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.consolidate.cosineThreshold, 0.8);
  assert.ok(warnings.some((w) => /malformed/i.test(w)));
});

// ─── session-start self-heal: a live (no-bootstrap) upgrade migrates itself ──

// Suppress the hook's detached compile spawn without flipping the re-entry
// guard (which would ALSO skip the self-heal migration we're testing): seed
// the compile-state with today's UTC date so maybeTriggerCompile early-outs.
function seedCompileStateToday(dir) {
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(stateDir, ".compile-state.json"),
    JSON.stringify({ last_attempted_date: today }),
  );
}

test("session-start self-heals an un-migrated install (writes settings.yaml, surfaces migration loudly)", () => {
  const dir = makeDataDir();
  // Old-format install: removed env keys present, NO settings.yaml — exactly
  // the state a git-pull-and-restart (no bootstrap) leaves behind.
  writeEnv(
    dir,
    "MEMORY_LLM_PROVIDER=claude\nANTHROPIC_API_KEY=sk-test\nMEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.83\nMEMORY_FLUSH_CHUNK_TARGET_K=7\n",
  );
  assert.equal(fs.existsSync(path.join(dir, "settings", "settings.yaml")), false);
  seedCompileStateToday(dir);

  const r = runScript("scripts/hooks/session-start.mjs", [], {
    stdin: "{}",
    env: { MEMORY_DATA_DIR: dir },
  });
  assert.equal(r.status, 0, `hook exit 0: ${r.stderr}`);

  // Durable effect: the migrator ran and wrote the new layout.
  assert.equal(
    fs.existsSync(path.join(dir, "settings", "settings.yaml")),
    true,
    "settings.yaml created",
  );
  assert.equal(fs.existsSync(path.join(dir, "settings", ".env.bak")), true, ".env backed up");
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.consolidate.cosineThreshold, 0.83);
  assert.equal(yaml.flush.chunkTargetK, 7);
  // .env shrunk to the strict subset.
  const env = fs.readFileSync(path.join(dir, "settings", ".env"), "utf8");
  assert.match(env, /ANTHROPIC_API_KEY=sk-test/);
  assert.doesNotMatch(env, /MEMORY_CONSOLIDATE_COSINE_THRESHOLD/);
  // Loud: a real migration surfaces its steps on stderr so the operator sees it.
  assert.match(r.stderr, /\[migrate-settings\] migrated/);
});

test("session-start is SILENT on an already-migrated install (no migrate noise every session)", () => {
  const dir = makeDataDir();
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nANTHROPIC_API_KEY=sk-test\n");
  writeSettingsYaml(dir, "consolidate:\n  cosineThreshold: 0.9\n");
  seedCompileStateToday(dir);

  const r = runScript("scripts/hooks/session-start.mjs", [], {
    stdin: "{}",
    env: { MEMORY_DATA_DIR: dir },
  });
  assert.equal(r.status, 0, `hook exit 0: ${r.stderr}`);
  // The common path must not print the migrator's bookkeeping on every start.
  assert.doesNotMatch(r.stderr, /\[migrate-settings\]/);
  // And it left the existing config untouched.
  const yaml = readYaml(dir, "settings.yaml");
  assert.equal(yaml.consolidate.cosineThreshold, 0.9);
  assert.equal(
    fs.existsSync(path.join(dir, "settings", ".env.bak")),
    false,
    "no backup written on no-op",
  );
});

test("session-start self-heal is skipped inside a memory-spawned subprocess (re-entry guard)", () => {
  const dir = makeDataDir();
  // Un-migrated install, but the hook is invoked re-entrantly (as the memory
  // pipeline spawns it): the migration must NOT run — it's the operator's
  // interactive session that self-heals, not a background worker.
  writeEnv(dir, "MEMORY_LLM_PROVIDER=claude\nMEMORY_CONSOLIDATE_COSINE_THRESHOLD=0.83\n");
  seedCompileStateToday(dir);

  const r = runScript("scripts/hooks/session-start.mjs", [], {
    stdin: "{}",
    env: { MEMORY_DATA_DIR: dir, CLAUDE_INVOKED_BY: "memory_compile" },
  });
  assert.equal(r.status, 0, `hook exit 0: ${r.stderr}`);
  assert.equal(
    fs.existsSync(path.join(dir, "settings", "settings.yaml")),
    false,
    "re-entrant invocation must not self-heal",
  );
});

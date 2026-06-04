import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The non-strict MEMORY_* env helpers used to live in env.mjs. The
// 2026-06-03/v2 release moved every application-config knob into
// settings.yaml — coverage of those moved to test/settings.test.mjs. What
// stays here: the parsing primitives (envFloat / envBool) that the
// strict-subset env vars still rely on, plus the two LLM-shape getters
// (llmBaseUrl / llmModel) that operate on the strict subset.

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "env-new-knobs-"));
process.env.MEMORY_DATA_DIR = TMP_DATA_DIR;

const { envFloat, envBool, llmBaseUrl, llmModel } = await import("../scripts/lib/env.mjs");

after(() => {
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
});

function clearEnv(...names) {
  for (const n of names) delete process.env[n];
}

// ─── envFloat ────────────────────────────────────────────────────────────────

test("envFloat: unset -> fallback", () => {
  clearEnv("X_FLOAT");
  assert.equal(envFloat("X_FLOAT", 0.5), 0.5);
});

test("envFloat: empty string -> fallback", () => {
  process.env.X_FLOAT = "";
  assert.equal(envFloat("X_FLOAT", 0.5), 0.5);
});

test("envFloat: valid float parsed", () => {
  process.env.X_FLOAT = "0.42";
  assert.equal(envFloat("X_FLOAT", 0.5), 0.42);
});

test("envFloat: garbage -> fallback", () => {
  process.env.X_FLOAT = "not-a-number";
  assert.equal(envFloat("X_FLOAT", 0.5), 0.5);
});

test("envFloat: NaN literal -> fallback", () => {
  process.env.X_FLOAT = "NaN";
  assert.equal(envFloat("X_FLOAT", 0.5), 0.5);
});

test("envFloat: below min -> fallback", () => {
  process.env.X_FLOAT = "-1";
  assert.equal(envFloat("X_FLOAT", 0.5, { min: 0, max: 1 }), 0.5);
});

test("envFloat: above max -> fallback", () => {
  process.env.X_FLOAT = "2";
  assert.equal(envFloat("X_FLOAT", 0.5, { min: 0, max: 1 }), 0.5);
});

// ─── envBool ─────────────────────────────────────────────────────────────────

test("envBool: '1' / 'on' / 'true' / 'yes' -> true (case-insensitive)", () => {
  for (const v of ["1", "on", "true", "yes", "ON", "True", "YES"]) {
    process.env.X_BOOL = v;
    assert.equal(envBool("X_BOOL", false), true, v);
  }
});

test("envBool: '0' / 'off' / 'false' / 'no' -> false", () => {
  for (const v of ["0", "off", "false", "no", "OFF", "False", "NO"]) {
    process.env.X_BOOL = v;
    assert.equal(envBool("X_BOOL", true), false, v);
  }
});

test("envBool: empty -> fallback", () => {
  process.env.X_BOOL = "";
  assert.equal(envBool("X_BOOL", true), true);
});

test("envBool: garbage -> fallback", () => {
  process.env.X_BOOL = "garbage";
  assert.equal(envBool("X_BOOL", true), true);
});

// ─── strict-subset LLM helpers ───────────────────────────────────────────────

test("llmBaseUrl: unset -> empty string; set -> value", () => {
  clearEnv("MEMORY_LLM_BASE_URL");
  assert.equal(llmBaseUrl(), "");
  process.env.MEMORY_LLM_BASE_URL = "http://localhost:11434/v1";
  assert.equal(llmBaseUrl(), "http://localhost:11434/v1");
});

test("llmModel: unset -> empty string; set -> value", () => {
  clearEnv("MEMORY_LLM_MODEL");
  assert.equal(llmModel(), "");
  process.env.MEMORY_LLM_MODEL = "fixture-model-z";
  assert.equal(llmModel(), "fixture-model-z");
});

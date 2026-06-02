import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolate every test from any real .env file on disk by pointing
// MEMORY_DATA_DIR at a fresh temp dir (envValue falls back to reading
// <data>/settings/.env, which we don't want to leak in from the host).
// IMPORTANT: this assignment MUST happen BEFORE env.mjs is imported, since
// path constants like CONSOLIDATE_STATE_PATH are frozen at import time
// against whatever MEMORY_DATA_DIR is set to then.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "env-new-knobs-"));
process.env.MEMORY_DATA_DIR = TMP_DATA_DIR;

const {
  envFloat,
  envBool,
  consolidateIntervalDays,
  consolidateCosineThreshold,
  consolidateCosineLexicalThreshold,
  consolidateClusterTopK,
  consolidateClusterScoreThreshold,
  consolidateOrphanTtlDays,
  consolidateStaleAfterMonths,
  consolidateArchiveBodyMax,
  consolidateArchiveAgeDays,
  consolidatePassesEnv,
  consolidateLlmPassesEnabled,
  consolidateLlmMaxRetries,
  consolidateRefreshMaxPerRun,
  recallTouchMinHours,
  recallTouchEnabled,
  writeGateSelfImprovementEnabled,
  llmBaseUrl,
  llmModel,
  CONSOLIDATE_STATE_PATH,
} = await import("../scripts/lib/env.mjs");

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

test("envFloat: integer-shaped value parsed as float", () => {
  process.env.X_FLOAT = "3";
  assert.equal(envFloat("X_FLOAT", 0.5), 3);
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
  process.env.X_FLOAT = "-0.1";
  assert.equal(envFloat("X_FLOAT", 0.5, { min: 0, max: 1 }), 0.5);
});

test("envFloat: above max -> fallback", () => {
  process.env.X_FLOAT = "1.5";
  assert.equal(envFloat("X_FLOAT", 0.5, { min: 0, max: 1 }), 0.5);
});

test("envFloat: at min boundary (inclusive)", () => {
  process.env.X_FLOAT = "0";
  assert.equal(envFloat("X_FLOAT", 0.5, { min: 0, max: 1 }), 0);
});

test("envFloat: at max boundary (inclusive)", () => {
  process.env.X_FLOAT = "1";
  assert.equal(envFloat("X_FLOAT", 0.5, { min: 0, max: 1 }), 1);
});

test("envFloat: no bounds -> any finite value accepted", () => {
  process.env.X_FLOAT = "-1000.25";
  assert.equal(envFloat("X_FLOAT", 0.5), -1000.25);
});

test("envFloat: Infinity literal -> fallback (not finite within bounds)", () => {
  process.env.X_FLOAT = "Infinity";
  assert.equal(envFloat("X_FLOAT", 0.5, { min: 0, max: 1 }), 0.5);
});

// ─── envBool ─────────────────────────────────────────────────────────────────

test("envBool: unset -> fallback (true)", () => {
  clearEnv("X_BOOL");
  assert.equal(envBool("X_BOOL", true), true);
});

test("envBool: unset -> fallback (false)", () => {
  clearEnv("X_BOOL");
  assert.equal(envBool("X_BOOL", false), false);
});

test("envBool: empty string -> fallback", () => {
  process.env.X_BOOL = "";
  assert.equal(envBool("X_BOOL", true), true);
});

test("envBool: truthy values", () => {
  for (const v of ["1", "on", "true", "yes", "TRUE", "Yes", "ON"]) {
    process.env.X_BOOL = v;
    assert.equal(envBool("X_BOOL", false), true, `expected true for ${v}`);
  }
});

test("envBool: falsy values", () => {
  for (const v of ["0", "off", "false", "no", "FALSE", "No", "OFF"]) {
    process.env.X_BOOL = v;
    assert.equal(envBool("X_BOOL", true), false, `expected false for ${v}`);
  }
});

test("envBool: garbage -> fallback (don't guess)", () => {
  process.env.X_BOOL = "maybe";
  assert.equal(envBool("X_BOOL", true), true);
  process.env.X_BOOL = "maybe";
  assert.equal(envBool("X_BOOL", false), false);
});

test("envBool: whitespace surrounding is trimmed", () => {
  process.env.X_BOOL = "  true  ";
  assert.equal(envBool("X_BOOL", false), true);
});

// ─── consolidateIntervalDays ─────────────────────────────────────────────────

test("consolidateIntervalDays: unset -> default 1", () => {
  clearEnv("MEMORY_CONSOLIDATE_INTERVAL_DAYS");
  assert.equal(consolidateIntervalDays(), 1);
});

test("consolidateIntervalDays: 'off' -> 0", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "off";
  assert.equal(consolidateIntervalDays(), 0);
});

test("consolidateIntervalDays: 'false' -> 0", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "false";
  assert.equal(consolidateIntervalDays(), 0);
});

test("consolidateIntervalDays: 'OFF' (case-insensitive) -> 0", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "OFF";
  assert.equal(consolidateIntervalDays(), 0);
});

test("consolidateIntervalDays: garbage -> default", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "wat";
  assert.equal(consolidateIntervalDays(), 1);
});

test("consolidateIntervalDays: valid float accepted", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "0.5";
  assert.equal(consolidateIntervalDays(), 0.5);
});

test("consolidateIntervalDays: explicit 0 accepted", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "0";
  assert.equal(consolidateIntervalDays(), 0);
});

test("consolidateIntervalDays: negative -> default", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "-1";
  assert.equal(consolidateIntervalDays(), 1);
});

test("consolidateIntervalDays: integer accepted", () => {
  process.env.MEMORY_CONSOLIDATE_INTERVAL_DAYS = "7";
  assert.equal(consolidateIntervalDays(), 7);
});

// ─── consolidateCosineThreshold ──────────────────────────────────────────────

test("consolidateCosineThreshold: unset -> default 0.97", () => {
  clearEnv("MEMORY_CONSOLIDATE_COSINE_THRESHOLD");
  assert.equal(consolidateCosineThreshold(), 0.97);
});

test("consolidateCosineThreshold: in-range override", () => {
  process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD = "0.85";
  assert.equal(consolidateCosineThreshold(), 0.85);
});

test("consolidateCosineThreshold: out-of-range (>1) -> default", () => {
  process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD = "1.5";
  assert.equal(consolidateCosineThreshold(), 0.97);
});

test("consolidateCosineThreshold: out-of-range (<0) -> default", () => {
  process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD = "-0.1";
  assert.equal(consolidateCosineThreshold(), 0.97);
});

test("consolidateCosineThreshold: garbage -> default", () => {
  process.env.MEMORY_CONSOLIDATE_COSINE_THRESHOLD = "nope";
  assert.equal(consolidateCosineThreshold(), 0.97);
});

// ─── consolidateCosineLexicalThreshold ───────────────────────────────────────

test("consolidateCosineLexicalThreshold: unset -> default 0.995", () => {
  clearEnv("MEMORY_CONSOLIDATE_COSINE_LEXICAL_THRESHOLD");
  assert.equal(consolidateCosineLexicalThreshold(), 0.995);
});

test("consolidateCosineLexicalThreshold: in-range override", () => {
  process.env.MEMORY_CONSOLIDATE_COSINE_LEXICAL_THRESHOLD = "0.9";
  assert.equal(consolidateCosineLexicalThreshold(), 0.9);
});

test("consolidateCosineLexicalThreshold: out-of-range -> default", () => {
  process.env.MEMORY_CONSOLIDATE_COSINE_LEXICAL_THRESHOLD = "2";
  assert.equal(consolidateCosineLexicalThreshold(), 0.995);
});

// ─── consolidateClusterTopK ──────────────────────────────────────────────────

test("consolidateClusterTopK: unset -> default 12", () => {
  clearEnv("MEMORY_CONSOLIDATE_CLUSTER_TOP_K");
  assert.equal(consolidateClusterTopK(), 12);
});

test("consolidateClusterTopK: positive int accepted", () => {
  process.env.MEMORY_CONSOLIDATE_CLUSTER_TOP_K = "30";
  assert.equal(consolidateClusterTopK(), 30);
});

test("consolidateClusterTopK: non-positive -> default (envInt requires > 0)", () => {
  process.env.MEMORY_CONSOLIDATE_CLUSTER_TOP_K = "0";
  assert.equal(consolidateClusterTopK(), 12);
});

test("consolidateClusterTopK: garbage -> default", () => {
  process.env.MEMORY_CONSOLIDATE_CLUSTER_TOP_K = "abc";
  assert.equal(consolidateClusterTopK(), 12);
});

// ─── consolidateClusterScoreThreshold ────────────────────────────────────────

test("consolidateClusterScoreThreshold: unset -> default 0.75", () => {
  clearEnv("MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD");
  assert.equal(consolidateClusterScoreThreshold(), 0.75);
});

test("consolidateClusterScoreThreshold: in-range override", () => {
  process.env.MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD = "0.5";
  assert.equal(consolidateClusterScoreThreshold(), 0.5);
});

test("consolidateClusterScoreThreshold: out-of-range -> default", () => {
  process.env.MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD = "-1";
  assert.equal(consolidateClusterScoreThreshold(), 0.75);
});

// ─── consolidateOrphanTtlDays ────────────────────────────────────────────────

test("consolidateOrphanTtlDays: unset -> default 365", () => {
  clearEnv("MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS");
  assert.equal(consolidateOrphanTtlDays(), 365);
});

test("consolidateOrphanTtlDays: override", () => {
  process.env.MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS = "90";
  assert.equal(consolidateOrphanTtlDays(), 90);
});

test("consolidateOrphanTtlDays: garbage -> default", () => {
  process.env.MEMORY_CONSOLIDATE_ORPHAN_TTL_DAYS = "x";
  assert.equal(consolidateOrphanTtlDays(), 365);
});

// ─── consolidateStaleAfterMonths ─────────────────────────────────────────────

test("consolidateStaleAfterMonths: unset -> default 6", () => {
  clearEnv("MEMORY_CONSOLIDATE_STALE_AFTER_MONTHS");
  assert.equal(consolidateStaleAfterMonths(), 6);
});

test("consolidateStaleAfterMonths: override", () => {
  process.env.MEMORY_CONSOLIDATE_STALE_AFTER_MONTHS = "3";
  assert.equal(consolidateStaleAfterMonths(), 3);
});

// ─── consolidateArchiveBodyMax ───────────────────────────────────────────────

test("consolidateArchiveBodyMax: unset -> default 1200", () => {
  clearEnv("MEMORY_CONSOLIDATE_ARCHIVE_BODY_MAX");
  assert.equal(consolidateArchiveBodyMax(), 1200);
});

test("consolidateArchiveBodyMax: override", () => {
  process.env.MEMORY_CONSOLIDATE_ARCHIVE_BODY_MAX = "500";
  assert.equal(consolidateArchiveBodyMax(), 500);
});

// ─── consolidateArchiveAgeDays ───────────────────────────────────────────────

test("consolidateArchiveAgeDays: unset -> default 30", () => {
  clearEnv("MEMORY_CONSOLIDATE_ARCHIVE_AGE_DAYS");
  assert.equal(consolidateArchiveAgeDays(), 30);
});

test("consolidateArchiveAgeDays: override", () => {
  process.env.MEMORY_CONSOLIDATE_ARCHIVE_AGE_DAYS = "7";
  assert.equal(consolidateArchiveAgeDays(), 7);
});

// ─── consolidatePassesEnv ────────────────────────────────────────────────────

test("consolidatePassesEnv: unset -> 'all'", () => {
  clearEnv("MEMORY_CONSOLIDATE_PASSES");
  assert.equal(consolidatePassesEnv(), "all");
});

test("consolidatePassesEnv: empty string -> 'all'", () => {
  process.env.MEMORY_CONSOLIDATE_PASSES = "";
  assert.equal(consolidatePassesEnv(), "all");
});

test("consolidatePassesEnv: CSV passes through", () => {
  process.env.MEMORY_CONSOLIDATE_PASSES = "dedupe,refresh";
  assert.equal(consolidatePassesEnv(), "dedupe,refresh");
});

test("consolidatePassesEnv: 'all' literal passes through", () => {
  process.env.MEMORY_CONSOLIDATE_PASSES = "all";
  assert.equal(consolidatePassesEnv(), "all");
});

test("consolidatePassesEnv: trims surrounding whitespace", () => {
  process.env.MEMORY_CONSOLIDATE_PASSES = "  dedupe  ";
  assert.equal(consolidatePassesEnv(), "dedupe");
});

// ─── consolidateLlmPassesEnabled ─────────────────────────────────────────────

test("consolidateLlmPassesEnabled: unset -> true", () => {
  clearEnv("MEMORY_CONSOLIDATE_LLM_PASSES");
  assert.equal(consolidateLlmPassesEnabled(), true);
});

test("consolidateLlmPassesEnabled: 'false' -> false", () => {
  process.env.MEMORY_CONSOLIDATE_LLM_PASSES = "false";
  assert.equal(consolidateLlmPassesEnabled(), false);
});

test("consolidateLlmPassesEnabled: '0' -> false", () => {
  process.env.MEMORY_CONSOLIDATE_LLM_PASSES = "0";
  assert.equal(consolidateLlmPassesEnabled(), false);
});

test("consolidateLlmPassesEnabled: 'true' -> true", () => {
  process.env.MEMORY_CONSOLIDATE_LLM_PASSES = "true";
  assert.equal(consolidateLlmPassesEnabled(), true);
});

test("consolidateLlmPassesEnabled: garbage -> default true", () => {
  process.env.MEMORY_CONSOLIDATE_LLM_PASSES = "maybe";
  assert.equal(consolidateLlmPassesEnabled(), true);
});

// ─── consolidateLlmMaxRetries ────────────────────────────────────────────────

test("consolidateLlmMaxRetries: unset -> default 2", () => {
  clearEnv("MEMORY_CONSOLIDATE_LLM_MAX_RETRIES");
  assert.equal(consolidateLlmMaxRetries(), 2);
});

test("consolidateLlmMaxRetries: override", () => {
  process.env.MEMORY_CONSOLIDATE_LLM_MAX_RETRIES = "5";
  assert.equal(consolidateLlmMaxRetries(), 5);
});

// ─── consolidateRefreshMaxPerRun ─────────────────────────────────────────────

test("consolidateRefreshMaxPerRun: unset -> default 25", () => {
  clearEnv("MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN");
  assert.equal(consolidateRefreshMaxPerRun(), 25);
});

test("consolidateRefreshMaxPerRun: override", () => {
  process.env.MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN = "100";
  assert.equal(consolidateRefreshMaxPerRun(), 100);
});

// ─── recallTouchMinHours ─────────────────────────────────────────────────────

test("recallTouchMinHours: unset -> default 24", () => {
  clearEnv("MEMORY_RECALL_TOUCH_MIN_HOURS");
  assert.equal(recallTouchMinHours(), 24);
});

test("recallTouchMinHours: override", () => {
  process.env.MEMORY_RECALL_TOUCH_MIN_HOURS = "6";
  assert.equal(recallTouchMinHours(), 6);
});

test("recallTouchMinHours: garbage -> default", () => {
  process.env.MEMORY_RECALL_TOUCH_MIN_HOURS = "x";
  assert.equal(recallTouchMinHours(), 24);
});

// ─── recallTouchEnabled ──────────────────────────────────────────────────────

test("recallTouchEnabled: unset -> default true", () => {
  clearEnv("MEMORY_RECALL_TOUCH");
  assert.equal(recallTouchEnabled(), true);
});

test("recallTouchEnabled: 'false' -> false", () => {
  process.env.MEMORY_RECALL_TOUCH = "false";
  assert.equal(recallTouchEnabled(), false);
});

test("recallTouchEnabled: 'off' -> false", () => {
  process.env.MEMORY_RECALL_TOUCH = "off";
  assert.equal(recallTouchEnabled(), false);
});

test("recallTouchEnabled: 'yes' -> true", () => {
  process.env.MEMORY_RECALL_TOUCH = "yes";
  assert.equal(recallTouchEnabled(), true);
});

// ─── writeGateSelfImprovementEnabled ─────────────────────────────────────────

test("writeGateSelfImprovementEnabled: unset -> default true", () => {
  clearEnv("MEMORY_WRITE_GATE_SELF_IMPROVEMENT");
  assert.equal(writeGateSelfImprovementEnabled(), true);
});

test("writeGateSelfImprovementEnabled: 'false' -> false (escape hatch)", () => {
  process.env.MEMORY_WRITE_GATE_SELF_IMPROVEMENT = "false";
  assert.equal(writeGateSelfImprovementEnabled(), false);
});

test("writeGateSelfImprovementEnabled: '0' -> false", () => {
  process.env.MEMORY_WRITE_GATE_SELF_IMPROVEMENT = "0";
  assert.equal(writeGateSelfImprovementEnabled(), false);
});

test("writeGateSelfImprovementEnabled: garbage -> default true", () => {
  process.env.MEMORY_WRITE_GATE_SELF_IMPROVEMENT = "perhaps";
  assert.equal(writeGateSelfImprovementEnabled(), true);
});

// ─── llmBaseUrl ──────────────────────────────────────────────────────────────

test("llmBaseUrl: unset -> empty string", () => {
  clearEnv("MEMORY_LLM_BASE_URL");
  assert.equal(llmBaseUrl(), "");
});

test("llmBaseUrl: override", () => {
  process.env.MEMORY_LLM_BASE_URL = "http://localhost:11434/v1";
  assert.equal(llmBaseUrl(), "http://localhost:11434/v1");
});

// ─── llmModel ────────────────────────────────────────────────────────────────

test("llmModel: unset -> empty string", () => {
  clearEnv("MEMORY_LLM_MODEL");
  assert.equal(llmModel(), "");
});

test("llmModel: override", () => {
  process.env.MEMORY_LLM_MODEL = "llama3.1:8b";
  assert.equal(llmModel(), "llama3.1:8b");
});

// ─── CONSOLIDATE_STATE_PATH ──────────────────────────────────────────────────

test("CONSOLIDATE_STATE_PATH: is an absolute path", () => {
  assert.equal(path.isAbsolute(CONSOLIDATE_STATE_PATH), true);
});

test("CONSOLIDATE_STATE_PATH: contains 'state/.consolidate.json'", () => {
  assert.ok(
    CONSOLIDATE_STATE_PATH.includes(path.join("state", ".consolidate.json")),
    `expected path to contain state/.consolidate.json, got: ${CONSOLIDATE_STATE_PATH}`,
  );
});

test("CONSOLIDATE_STATE_PATH: is rooted under TMP_DATA_DIR (proves env override took effect)", () => {
  const expected = path.join(TMP_DATA_DIR, "state", ".consolidate.json");
  assert.equal(
    CONSOLIDATE_STATE_PATH,
    expected,
    `expected CONSOLIDATE_STATE_PATH to equal ${expected}, got: ${CONSOLIDATE_STATE_PATH}`,
  );
});

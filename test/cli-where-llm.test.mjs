import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(SRC, "scripts", "cli.mjs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-where-llm-"));
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function runWhere(extraEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, "where"], {
    cwd: SRC,
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_DATA_DIR: dataDir,
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: '{"ok":true}',
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, `cli exited non-zero; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("`where` output includes an llm block with mock provider available", () => {
  const parsed = runWhere();
  assert.ok(parsed.llm, "result.llm exists");
  assert.equal(parsed.llm.provider, "mock", "provider is mock");
  assert.equal(parsed.llm.available, true, "mock provider is available when MEMORY_LLM_MOCK_RESPONSE is set");
});

test("`where` output preserves the existing top-level fields", () => {
  const parsed = runWhere();
  for (const key of ["memoryDir", "dataDir", "wiki", "embedCache", "projectModule", "skill"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, key),
      `result.${key} present in where output`,
    );
  }
});

test("`where` reports mock provider as unavailable when no MEMORY_LLM_MOCK_RESPONSE is set", () => {
  const parsed = runWhere({ MEMORY_LLM_MOCK_RESPONSE: "" });
  assert.equal(parsed.llm.provider, "mock");
  assert.equal(parsed.llm.available, false, "mock provider is unavailable without a canned response");
});

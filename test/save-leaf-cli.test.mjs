import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";
import { DEFAULT_MAX_PLAN_BYTES } from "../scripts/hooks/exit-plan-mode-spec.mjs";

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

function bodyFile(bytesApprox) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-saveleaf-"));
  const file = path.join(dir, "big-doc.md");
  const block = "### Section\n\n- [ ] a step with enough prose to be representative\n\n";
  let text = "# A large document\n\n## 0. Plain-language version\n\nProbe.\n\n";
  while (Buffer.byteLength(text) < bytesApprox) text += block;
  fs.writeFileSync(file, text);
  return { file, size: Buffer.byteLength(text) };
}

test("the plan-body cap is 1MB (the old 256KB was sized for an HTTP bridge that is gone)", () => {
  assert.equal(DEFAULT_MAX_PLAN_BYTES, 1_048_576);
});

test("save-leaf persists a body far larger than a client will inline", () => {
  const { file, size } = bodyFile(80_000);
  assert.ok(size > 46_279, "probe must exceed the payload size that failed to parse inline");
  const r = runScript("scripts/cli.mjs", [
    "save-leaf",
    "--file",
    file,
    "--dataset",
    "plans",
    "--area=workspace",
    "--atom-type=plan",
  ]);
  assert.equal(r.status, 0, `exit 0: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.bytes, size, "the whole file was persisted, not a truncation");
});

test("save-leaf refuses the write-gated category so the CLI is not a consent bypass", () => {
  const { file } = bodyFile(500);
  const r = runScript("scripts/cli.mjs", [
    "save-leaf",
    "--file",
    file,
    "--dataset",
    "self_improvement",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /write-gated|save_lesson/);
});

test("save-leaf reports a usage error when --file or --dataset is missing", () => {
  for (const args of [["save-leaf"], ["save-leaf", "--dataset", "plans"]]) {
    const r = runScript("scripts/cli.mjs", args);
    assert.equal(r.status, 64, `usage exit for ${args.join(" ")}`);
    assert.match(r.stderr, /usage: llm-wiki-memory save-leaf/);
  }
});

test("save-leaf fails clearly on a missing or empty file", () => {
  const missing = runScript("scripts/cli.mjs", [
    "save-leaf", "--file", "/definitely/not/here.md", "--dataset", "plans",
  ]);
  assert.equal(missing.status, 66);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-empty-"));
  const empty = path.join(dir, "empty.md");
  fs.writeFileSync(empty, "   \n");
  const r = runScript("scripts/cli.mjs", ["save-leaf", "--file", empty, "--dataset", "plans"]);
  assert.equal(r.status, 65);
});

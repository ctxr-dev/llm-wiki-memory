import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeEnvFile } from "../scripts/bootstrap/setup-env.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(SRC, "templates", "env.example");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "setup-env-"));
const envPath = (d) => path.join(d, "settings", ".env");
const read = (f) => fs.readFileSync(f, "utf8");

test("fresh install: provider line replaced (whole line, anchored); no other line changes", () => {
  const d = tmp();
  const r = writeEnvFile({ dataDir: d, templatePath: TEMPLATE, provider: "mock" });
  assert.equal(r.action, "wrote");
  const out = read(envPath(d));
  const tmpl = read(TEMPLATE);
  assert.match(out, /^MEMORY_LLM_PROVIDER=mock$/m);
  // Byte-parity check: exactly the provider line differs from the template.
  const diff = out.split("\n").filter((l, i) => l !== tmpl.split("\n")[i]);
  assert.deepEqual(diff, ["MEMORY_LLM_PROVIDER=mock"], "only the provider line changed");
  fs.rmSync(d, { recursive: true, force: true });
});

test("fresh install with baseUrlHint: appended (commented template line does NOT match)", () => {
  const d = tmp();
  writeEnvFile({
    dataDir: d,
    templatePath: TEMPLATE,
    provider: "openai-compatible",
    baseUrlHint: "http://localhost:11434/v1",
  });
  const out = read(envPath(d));
  assert.match(
    out,
    /\nMEMORY_LLM_BASE_URL=http:\/\/localhost:11434\/v1\n$/,
    "appended with leading+trailing newline",
  );
  // The commented template line is untouched (append, not replace).
  assert.match(out, /^#\s*MEMORY_LLM_BASE_URL=/m);
  fs.rmSync(d, { recursive: true, force: true });
});

test("baseUrlHint replaces an EXISTING uncommented base-url line instead of appending", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "settings"), { recursive: true });
  const tpl = path.join(d, "tpl.env");
  fs.writeFileSync(tpl, "MEMORY_LLM_PROVIDER=claude\nMEMORY_LLM_BASE_URL=OLD\n");
  writeEnvFile({ dataDir: d, templatePath: tpl, provider: "openai", baseUrlHint: "NEW" });
  const out = read(envPath(d));
  assert.match(out, /^MEMORY_LLM_BASE_URL=NEW$/m);
  assert.doesNotMatch(out, /OLD/);
  assert.equal((out.match(/MEMORY_LLM_BASE_URL=/g) || []).length, 1, "no duplicate base-url line");
  fs.rmSync(d, { recursive: true, force: true });
});

test("CREATE-ONLY: an existing .env is NEVER modified; the existing provider is reported", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "settings"), { recursive: true });
  const original = "MEMORY_LLM_PROVIDER=anthropic\n# user edits here\n";
  fs.writeFileSync(envPath(d), original);
  const r = writeEnvFile({ dataDir: d, templatePath: TEMPLATE, provider: "mock" });
  assert.equal(r.action, "kept");
  assert.equal(r.existingProvider, "anthropic");
  assert.equal(read(envPath(d)), original, "existing .env byte-identical (never rewritten)");
  fs.rmSync(d, { recursive: true, force: true });
});

test("existing-provider parse strips quotes + whitespace", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "settings"), { recursive: true });
  fs.writeFileSync(envPath(d), 'MEMORY_LLM_PROVIDER="codex"  \n');
  const r = writeEnvFile({ dataDir: d, templatePath: TEMPLATE, provider: "mock" });
  assert.equal(r.existingProvider, "codex");
  fs.rmSync(d, { recursive: true, force: true });
});

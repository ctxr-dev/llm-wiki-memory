import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

const ws = setupWorkspace();
after(() => cleanup(ws.dataDir));

const SRC = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-absorb-src-")));
after(() => fs.rmSync(SRC, { recursive: true, force: true }));
function seed(rel, body) {
  const p = path.join(SRC, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
seed("docs/one.md", "# One\n\nFirst doc.\n" + "x ".repeat(60));
seed("docs/sub/two.md", "# Two\n\nSecond doc.\n" + "y ".repeat(60));

const env = {
  MEMORY_DATA_DIR: ws.dataDir,
  MEMORY_EMBED_BACKEND: "lexical",
  MEMORY_LLM_PROVIDER: "mock",
  MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ area: "billing", atom_type: "reference" }),
};
function absorb(args) {
  return runScript("scripts/cli.mjs", ["absorb", ...args], { env });
}
function countLeaves(root) {
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && e.name !== "index.md") n += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return n;
}
const KNOW = path.join(ws.wiki, "knowledge");

test("cli absorb --dry-run: reports proposals, writes nothing", () => {
  const r = absorb([path.join(SRC, "docs"), "--category=knowledge", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.absorbed, 2);
  assert.equal(countLeaves(KNOW), 0, "dry run wrote no leaves");
});

test("cli absorb: a directory tree → full leaves for each markdown file", () => {
  const r = absorb([path.join(SRC, "docs"), "--category=knowledge"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.absorbed, 2, r.stdout);
  assert.equal(out.matched, 2);
  assert.equal(countLeaves(KNOW), 2);
});

test("cli absorb: --category=knowledge idempotent re-run (no new leaves)", () => {
  const r = absorb([path.join(SRC, "docs"), "--category=knowledge"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(countLeaves(KNOW), 2, "still two leaves after re-run");
});

test("cli absorb --help: prints usage, exits 0 (never mutates)", () => {
  const r = absorb(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("cli absorb: the space form of a value flag fails loud (D3)", () => {
  const r = absorb([path.join(SRC, "docs"), "--category", "knowledge"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--category requires the equals form/);
});

test("cli absorb: a missing --category is refused", () => {
  const r = absorb([path.join(SRC, "docs")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--category=<name> is required/);
});

test("cli absorb: no path argument is refused", () => {
  const r = absorb(["--category=knowledge"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /at least one <path> is required/);
});

test("cli absorb: a typo'd flag fails loud (never silently a real write)", () => {
  const r = absorb([path.join(SRC, "docs"), "--category=knowledge", "--dryrun"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag '--dryrun'/);
});

test("cli absorb: an empty value on a flag is refused", () => {
  const r = absorb([path.join(SRC, "docs"), "--category="]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--category= requires a non-empty value/);
});

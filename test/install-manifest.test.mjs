import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MANIFEST_VERSION,
  manifestPath,
  sha256,
  readManifest,
  writeManifest,
} from "../scripts/lib/install-manifest.mjs";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});
function ws() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "manifest-")));
  tmps.push(d);
  return d;
}

test("sha256: deterministic and content-sensitive", () => {
  assert.equal(sha256("abc"), sha256("abc"));
  assert.notEqual(sha256("abc"), sha256("abd"));
});

test("manifestPath: under <ws>/.llm-wiki-memory/state/", () => {
  assert.equal(
    manifestPath("/w"),
    path.join("/w", ".llm-wiki-memory", "state", ".install-manifest.json"),
  );
});

test("write/read: round-trips, creating the state dir", () => {
  const w = ws();
  const arts = [
    { kind: "file", path: ".claude/skills/llm-wiki-memory-x.md", sha256: sha256("x") },
    { kind: "block", path: "AGENTS.md", marker: "llm-wiki-memory" },
    { kind: "config", path: ".mcp.json", key: "mcpServers.llm-wiki-memory" },
  ];
  const written = writeManifest(w, arts);
  assert.equal(written.version, MANIFEST_VERSION);
  assert.ok(fs.existsSync(manifestPath(w)), "manifest file created");
  const read = readManifest(w);
  assert.ok(read);
  assert.equal(read.artifacts.length, 3);
  assert.equal(read.workspaceDir, path.resolve(w));
});

test("readManifest: null on absent / corrupt / wrong-version", () => {
  const w = ws();
  assert.equal(readManifest(w), null, "absent → null");
  fs.mkdirSync(path.dirname(manifestPath(w)), { recursive: true });
  fs.writeFileSync(manifestPath(w), "{not json");
  assert.equal(readManifest(w), null, "corrupt → null");
  fs.writeFileSync(manifestPath(w), JSON.stringify({ version: 999, artifacts: [] }));
  assert.equal(readManifest(w), null, "wrong version → null");
});

test("writeManifest: byte-stable regardless of input artifact order (deterministic sort)", () => {
  const w = ws();
  const a = { kind: "file", path: "a.md", sha256: sha256("a") };
  const b = { kind: "block", path: "b.md", marker: "llm-wiki-memory" };
  const c = { kind: "config", path: "c.json", key: "k" };
  writeManifest(w, [a, b, c]);
  const s1 = fs.readFileSync(manifestPath(w), "utf8");
  writeManifest(w, [c, b, a]);
  const s2 = fs.readFileSync(manifestPath(w), "utf8");
  assert.equal(s1, s2, "same artifact set in any order → byte-identical manifest");
  writeManifest(w, [b, a, c]);
  assert.equal(fs.readFileSync(manifestPath(w), "utf8"), s1, "another re-write stays byte-stable");
});

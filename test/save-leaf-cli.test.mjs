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
    "save-leaf",
    "--file",
    "/definitely/not/here.md",
    "--dataset",
    "plans",
  ]);
  assert.equal(missing.status, 66);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-empty-"));
  const empty = path.join(dir, "empty.md");
  fs.writeFileSync(empty, "   \n");
  const r = runScript("scripts/cli.mjs", ["save-leaf", "--file", empty, "--dataset", "plans"]);
  assert.equal(r.status, 65);
});

import { splitLeafFrontmatter } from "../scripts/lib/leaf-frontmatter.mjs";

const LEAF = [
  "---",
  "id: probe",
  "focus: 'A probe leaf'",
  "memory:",
  "  atom_type: project-lore",
  "  project_module: repos",
  "  area: bumblebee",
  "  language: scala",
  "  task_type: debugging",
  "  status: active",
  "  priority: P2",
  "  tags: 'a,b'",
  "  subject:",
  "    - general",
  "---",
  "",
  "# A probe leaf",
  "",
  "Body prose.",
  "",
].join("\n");

test("splitting a leaf strips its frontmatter so a re-save cannot stack a second block", () => {
  const { body } = splitLeafFrontmatter(LEAF);
  assert.ok(!body.includes("id: probe"), "frontmatter must not survive into the body");
  assert.ok(body.startsWith("# A probe leaf"), `body starts at the heading: ${body.slice(0, 40)}`);
});

test("splitting a leaf inherits the facets that decide placement, plus language and priority", () => {
  const { inherited } = splitLeafFrontmatter(LEAF);
  assert.equal(inherited.area, "bumblebee");
  assert.equal(inherited.atom_type, "project-lore");
  assert.equal(inherited.task_type, "debugging");
  assert.equal(inherited.language, "scala");
  assert.equal(inherited.priority, "P2");
  assert.equal(inherited.tags, "a,b");
  assert.deepEqual(inherited.subject, ["general"]);
});

test("a body with no frontmatter is passed through untouched and inherits nothing", () => {
  const plain = "# Just a body\n\nprose\n";
  const { body, inherited } = splitLeafFrontmatter(plain);
  assert.equal(body, plain);
  assert.deepEqual(inherited, {});
});

test("keys outside the memory block are not mistaken for facets", () => {
  const { inherited } = splitLeafFrontmatter(LEAF);
  assert.equal(inherited.id, undefined);
  assert.equal(inherited.focus, undefined);
  assert.equal(inherited.status, undefined);
  assert.equal(inherited.project_module, undefined);
});

test("re-saving an edited leaf in place keeps it at the same documentId", () => {
  const first = runScript("scripts/cli.mjs", [
    "save-leaf",
    "--file",
    (() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-inplace-"));
      const f = path.join(dir, "placement-probe.md");
      fs.writeFileSync(f, "# Placement probe\n\nOriginal prose.\n");
      return f;
    })(),
    "--dataset",
    "knowledge",
    "--name",
    "placement-probe.md",
    "--area=bumblebee",
    "--atom-type=project-lore",
    "--task-type=debugging",
    "--language=scala",
  ]);
  assert.equal(first.status, 0, `first save: ${first.stderr}`);
  const created = JSON.parse(first.stdout).created.document.id;
  assert.match(created, /^knowledge\/bumblebee\/project-lore\//, `placed by facets: ${created}`);

  const leafPath = path.join(dataDir, "wiki", created);
  fs.appendFileSync(leafPath, "\n## Related\n\n- a back-reference\n");

  // The failure this guards: re-saving with NO facet flags used to fall back to
  // defaults, relocating the leaf and changing its id.
  const second = runScript("scripts/cli.mjs", [
    "save-leaf",
    "--file",
    leafPath,
    "--dataset",
    "knowledge",
  ]);
  assert.equal(second.status, 0, `second save: ${second.stderr}`);
  const out2 = JSON.parse(second.stdout);
  assert.equal(out2.created.document.id, created, "documentId must not change");
  assert.equal(out2.placement, "unchanged");
  assert.equal(out2.frontmatterStripped, true);

  const saved = fs.readFileSync(path.join(dataDir, "wiki", created), "utf8");
  assert.equal(saved.match(/^memory:$/gm).length, 1, "exactly one memory block");
  assert.match(saved, /language: scala/, "language survives a re-save");
  assert.match(saved, /priority: P2/, "priority survives a re-save");
  assert.match(saved, /back-reference/, "the body edit is persisted");
});

test("--dry-run reports the resolved facets and writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-dry-"));
  const f = path.join(dir, "dry-probe.md");
  fs.writeFileSync(f, LEAF);
  const r = runScript("scripts/cli.mjs", [
    "save-leaf",
    "--file",
    f,
    "--dataset",
    "knowledge",
    "--dry-run",
  ]);
  assert.equal(r.status, 0, `dry-run: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.metadata.area, "bumblebee");
  assert.equal(out.frontmatterStripped, true);
  const written = runScript("scripts/cli.mjs", ["doctor"]);
  assert.ok(
    !fs
      .readdirSync(path.join(dataDir, "wiki", "knowledge", "bumblebee", "project-lore", "general"))
      .includes("dry-probe.md"),
    "a dry run must not write the leaf",
  );
  assert.ok(written.status === 0 || written.status === 3, "doctor still runs after a dry run");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanBodyReferences } from "../scripts/lib/doctor-body-refs.mjs";

function wiki(leaves) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-bodyrefs-"));
  for (const [rel, text] of Object.entries(leaves)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

function leaf(title, body) {
  return `---\nid: probe\nfocus: '${title}'\nmemory:\n  area: infra\n---\n\n${body}\n`;
}

const TARGET = "knowledge/infra/reference/general/target.md";
const TARGET_TITLE = "The target leaf about Kafka partitioning";

test("a body reference to a document that does not exist is reported", () => {
  const root = wiki({
    "knowledge/a/reference/general/src.md": leaf("Source", "See `brain:knowledge/gone/away.md`."),
  });
  const { brokenBodyRefs } = scanBodyReferences(root);
  assert.equal(brokenBodyRefs.length, 1);
  assert.deepEqual(brokenBodyRefs[0].broken, ["knowledge/gone/away.md"]);
});

test("a reference that resolves is not reported", () => {
  const root = wiki({
    [TARGET]: leaf(TARGET_TITLE, "Target body."),
    "knowledge/a/reference/general/src.md": leaf("Source", `See \`brain:${TARGET}\`.`),
  });
  assert.deepEqual(scanBodyReferences(root).brokenBodyRefs, []);
});

test("a reference inside a fenced block is literal, so it is not a broken reference", () => {
  const root = wiki({
    "knowledge/a/reference/general/src.md": leaf(
      "Source",
      "Example:\n\n```\nbrain:knowledge/does/not/exist.md\n```\n",
    ),
  });
  assert.deepEqual(scanBodyReferences(root).brokenBodyRefs, []);
});

test("the raw capture layers are exempt, so an example reference in daily is not a defect", () => {
  const root = wiki({
    "daily/2026/08/20/note.md": leaf("Note", "shape is `brain:knowledge/infra/foo.md`"),
    "absorb/imported/doc.md": leaf("Imported", "`brain:knowledge/infra/bar.md`"),
  });
  const { brokenBodyRefs } = scanBodyReferences(root);
  assert.deepEqual(brokenBodyRefs, []);
});

test("a label equal to the target's title is not drift", () => {
  const root = wiki({
    [TARGET]: leaf(TARGET_TITLE, "Target body."),
    "knowledge/a/reference/general/src.md": leaf("Source", `- [${TARGET_TITLE}](brain:${TARGET})`),
  });
  assert.deepEqual(scanBodyReferences(root).labelDrift, []);
});

test("a label that is a shortened form of a long title is not drift", () => {
  const root = wiki({
    [TARGET]: leaf(TARGET_TITLE, "Target body."),
    "knowledge/a/reference/general/src.md": leaf("Source", `- [The target leaf](brain:${TARGET})`),
  });
  assert.deepEqual(scanBodyReferences(root).labelDrift, []);
});

test("a label differing only by case and punctuation is not drift", () => {
  const root = wiki({
    [TARGET]: leaf(TARGET_TITLE, "Target body."),
    "knowledge/a/reference/general/src.md": leaf(
      "Source",
      `- [the target leaf, about kafka partitioning](brain:${TARGET})`,
    ),
  });
  assert.deepEqual(scanBodyReferences(root).labelDrift, []);
});

test("an entity name naming the target in prose is not drift", () => {
  const root = wiki({
    "knowledge/hodor/reference/general/hodor.md": leaf("hodor — risk-analysis orchestration", "x"),
    "knowledge/a/reference/general/src.md": leaf(
      "Source",
      "handled by [hodor](brain:knowledge/hodor/reference/general/hodor.md)",
    ),
  });
  assert.deepEqual(scanBodyReferences(root).labelDrift, []);
});

test("a paraphrased label is reported as drift, with both the label and the real title", () => {
  const root = wiki({
    [TARGET]: leaf(TARGET_TITLE, "Target body."),
    "knowledge/a/reference/general/src.md": leaf(
      "Source",
      `- [Upstream write semantics](brain:${TARGET})`,
    ),
  });
  const { labelDrift } = scanBodyReferences(root);
  assert.equal(labelDrift.length, 1);
  assert.equal(labelDrift[0].label, "Upstream write semantics");
  assert.equal(labelDrift[0].title, TARGET_TITLE);
  assert.equal(labelDrift[0].ref, TARGET);
});

test("a label pointing at a missing target is a broken reference, not drift", () => {
  const root = wiki({
    "knowledge/a/reference/general/src.md": leaf(
      "Source",
      "- [Anything at all](brain:knowledge/gone/away.md)",
    ),
  });
  const report = scanBodyReferences(root);
  assert.equal(report.brokenBodyRefs.length, 1);
  assert.deepEqual(report.labelDrift, []);
});

test("frontmatter is not scanned, so a reference-shaped value there is ignored", () => {
  const root = wiki({
    "knowledge/a/reference/general/src.md":
      "---\nid: probe\nfocus: 'Source'\nsource:\n  origin: brain:knowledge/not/real.md\n---\n\nBody.\n",
  });
  assert.deepEqual(scanBodyReferences(root).brokenBodyRefs, []);
});

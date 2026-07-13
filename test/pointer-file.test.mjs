// Direct unit coverage for isOurPointer — the guard that decides whether a
// prefixed `.md` may be pruned. It recognizes our pointers by the layout-independent
// fallback-note SIGNATURE (not the install path, which varies by layout), so it works
// for a repo-dev checkout and never blind-deletes a user file or EISDIRs on a dir.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOurPointer } from "../scripts/lib/pointer-file.mjs";
import { pointerBody } from "../scripts/wire-memory-surfaces.mjs";
import { POINTER_FALLBACK_NOTE } from "../scripts/lib/memory-surface-constants.mjs";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ptr-")));
  tmps.push(d);
  return d;
}
const ptr = (/** @type {string} */ ref) => `@${ref}\n\n${POINTER_FALLBACK_NOTE}\n${ref}\n`;

test("isOurPointer: a pointer body with the fallback note → true (standard install path)", () => {
  const d = tmp();
  const f = path.join(d, "p.md");
  fs.writeFileSync(f, ptr("~/.llm-wiki-memory/src/templates/skills/x.md"));
  assert.equal(isOurPointer(f), true);
});

test("isOurPointer: LAYOUT-INDEPENDENT — a repo-dev-checkout pointer (path NOT under .llm-wiki-memory/src) → true", () => {
  const d = tmp();
  const f = path.join(d, "p.md");
  // A plain `git clone` at ~/repos/llm-wiki-memory yields this ref — no .llm-wiki-memory/src fragment.
  fs.writeFileSync(f, ptr("~/repos/llm-wiki-memory/templates/skills/x.md"));
  assert.equal(isOurPointer(f), true, "recognized by the note, not the install path");
});

test("isOurPointer: a user's real-content file at a reserved name → false (never pruned)", () => {
  const d = tmp();
  const f = path.join(d, "llm-wiki-memory-notes.md");
  fs.writeFileSync(f, "# my own notes\nnothing to do with the tool\n");
  assert.equal(isOurPointer(f), false);
});

test("isOurPointer: a file that mentions the install PATH but lacks the note → false (path alone is insufficient)", () => {
  const d = tmp();
  const f = path.join(d, "doc.md");
  fs.writeFileSync(f, "Run the CLI at ~/.llm-wiki-memory/src/scripts/cli.mjs for details.\n");
  assert.equal(isOurPointer(f), false, "the bare path is no longer the discriminator");
});

test("isOurPointer: a doc that MENTIONS the fallback note but is not an @-include → false (needs both signals)", () => {
  const d = tmp();
  const f = path.join(d, "llm-wiki-memory-cheatsheet.md");
  fs.writeFileSync(
    f,
    `# My notes\nThe pointer says: "${POINTER_FALLBACK_NOTE}" and then the path.\nMore of my content.\n`,
  );
  assert.equal(isOurPointer(f), false, "a note-mention without a leading @-include is not ours");
});

test("isOurPointer: a file starting with @ but WITHOUT the note → false (needs BOTH signals, R5)", () => {
  const d = tmp();
  const f = path.join(d, "llm-wiki-memory-notes.md");
  fs.writeFileSync(f, "@see other-file\nmy own notes that happen to start with an @-ref\n");
  assert.equal(isOurPointer(f), false, "a leading @ without the fallback note is not ours");
});

test("isOurPointer / pointerBody: the real pointerBody output IS recognized (drift pin)", () => {
  const d = tmp();
  const f = path.join(d, "llm-wiki-memory-real.md");
  fs.writeFileSync(f, pointerBody("~/.llm-wiki-memory/src/templates/skills/x.md"));
  assert.ok(
    pointerBody("~/x").includes(POINTER_FALLBACK_NOTE),
    "pointerBody must carry the note constant (guards against a wording drift breaking recognition)",
  );
  assert.equal(
    isOurPointer(f),
    true,
    "a body produced by the REAL pointerBody is recognized as ours",
  );
});

test("isOurPointer: a symlink → true (pre-D wiring); a directory → false (no crash)", () => {
  const d = tmp();
  const link = path.join(d, "link.md");
  fs.symlinkSync("/some/target.md", link);
  assert.equal(isOurPointer(link), true, "any symlink at a pointer slot is ours");
  const dir = path.join(d, "dir.md");
  fs.mkdirSync(dir);
  assert.equal(isOurPointer(dir), false, "a directory is never a pointer");
});

test("isOurPointer: an absent path → false (no throw)", () => {
  assert.equal(isOurPointer(path.join(tmp(), "does-not-exist.md")), false);
});

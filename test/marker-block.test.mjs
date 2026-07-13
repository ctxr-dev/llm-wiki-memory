// Direct unit coverage for stripManagedBlocks — the shared marker-fenced-block
// remover used by both uninstall and wire. The invariant: NEVER delete non-marker
// content; remove well-formed pairs whole; drop stray/orphan marker LINES only;
// converge (a second pass is a no-op).

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripManagedBlocks } from "../scripts/lib/marker-block.mjs";

const S = "<!-- BEGIN X -->";
const E = "<!-- END X -->";

test("stripManagedBlocks: removes a well-formed pair, keeps surrounding content", () => {
  assert.equal(stripManagedBlocks(`a\n${S}\ninner\n${E}\nb`, S, E), "a\nb");
});

test("stripManagedBlocks: no markers → content returned unchanged (=== identity)", () => {
  const c = "just\nuser\ncontent\n";
  assert.equal(stripManagedBlocks(c, S, E), c);
});

test("stripManagedBlocks: an orphan START (no END) drops ONLY the marker line, keeps all content after it", () => {
  assert.equal(stripManagedBlocks(`a\n${S}\nkeep1\nkeep2`, S, E), "a\nkeep1\nkeep2");
});

test("stripManagedBlocks: a stray END alone drops only the END line", () => {
  assert.equal(stripManagedBlocks(`keep\n${E}\nkeep2`, S, E), "keep\nkeep2");
});

test("stripManagedBlocks: END…START…END — the well-formed pair is removed, the stray END + interior kept", () => {
  // first END is stray (dropped); then START..END is a well-formed pair (removed).
  assert.equal(stripManagedBlocks(`x\n${E}\ny\n${S}\nz\n${E}\nw`, S, E), "x\ny\nw");
});

test("stripManagedBlocks: nested START (START START END) — outer START is a stray, inner pair removed", () => {
  assert.equal(stripManagedBlocks(`${S}\n${S}\ninner\n${E}\ntail`, S, E), "tail");
});

test("stripManagedBlocks: two sequential well-formed blocks are both removed", () => {
  assert.equal(stripManagedBlocks(`${S}\n1\n${E}\nmid\n${S}\n2\n${E}`, S, E), "mid");
});

test("stripManagedBlocks: CRLF markers are recognized; kept lines retain their \\r", () => {
  assert.equal(stripManagedBlocks(`a\r\n${S}\r\nb\r\n${E}\r\nc\r\n`, S, E), "a\r\nc\r\n");
});

test("stripManagedBlocks: a marker with trailing text on the same line is NOT a marker (kept as content)", () => {
  const c = `${S} note\nbody\n${E} note`;
  assert.equal(
    stripManagedBlocks(c, S, E),
    c,
    "neither pseudo-marker line matches; nothing removed",
  );
});

test("stripManagedBlocks: converges — a second pass over the output is a no-op", () => {
  const once = stripManagedBlocks(`a\n${S}\norphan-leftover\nuser`, S, E);
  assert.equal(stripManagedBlocks(once, S, E), once, "idempotent");
});

test("stripManagedBlocks: markers INSIDE a ``` fence are PRESERVED (a documented example is not stripped)", () => {
  const doc = "Here is what it injects:\n```\n" + `${S}\nEXAMPLE BODY\n${E}\n` + "```\ntail prose";
  assert.equal(
    stripManagedBlocks(doc, S, E),
    doc,
    "the fenced example (and its interior) is untouched",
  );
});

test("stripManagedBlocks: a fenced example is kept while our BARE block elsewhere is still removed", () => {
  const kept = "```\n" + `${S}\nexample\n${E}\n` + "```";
  const doc = `${kept}\n${S}\nreal\n${E}\ntail`;
  assert.equal(
    stripManagedBlocks(doc, S, E),
    `${kept}\ntail`,
    "fenced example kept, bare block removed",
  );
});

test("stripManagedBlocks: ~~~ fences are also honored", () => {
  const doc = "~~~\n" + `${S}\nex\n${E}\n` + "~~~";
  assert.equal(stripManagedBlocks(doc, S, E), doc, "tilde-fenced markers preserved");
});

test("stripManagedBlocks: an UNCLOSED fence upstream does NOT hide our real block (no accumulation, R5)", () => {
  // A dangling ``` fences nothing — our bare block after it must still be removed.
  const doc = "# Doc\n```bash\necho hi\n" + `${S}\nreal\n${E}`;
  const stripped = stripManagedBlocks(doc, S, E);
  assert.doesNotMatch(stripped, /BEGIN X|END X/, "the block after an unclosed fence IS removed");
  assert.match(stripped, /echo hi/, "the unclosed-fence content is preserved as ordinary text");
  assert.equal(stripManagedBlocks(stripped, S, E), stripped, "converges");
});

test("stripManagedBlocks: a fence BETWEEN a START and the real END is skipped, block removed to the real END (R5)", () => {
  const doc = `${S}\n\`\`\`\n${E}\n\`\`\`\n${E}\ntail`;
  assert.equal(
    stripManagedBlocks(doc, S, E),
    "tail",
    "the fenced END is skipped; the real trailing END closes the block",
  );
});

test("stripManagedBlocks: a NESTED fence (4-tick outer wrapping a 3-tick example) preserves the markers (R5)", () => {
  const doc = "keep1\n````markdown\n```\n" + `${S}\nMUST SURVIVE\n${E}\n` + "```\n````\nkeep2";
  assert.equal(stripManagedBlocks(doc, S, E), doc, "the nested-fenced example is fully preserved");
});

test("stripManagedBlocks: a ~~~ line inside a ``` fence does NOT close it (char-aware, R5)", () => {
  const doc = "```\n" + `${S}\n~~~\n${E}\n` + "```\ntail";
  assert.equal(
    stripManagedBlocks(doc, S, E),
    doc,
    "the ~~~ inside a ``` fence is literal; markers preserved",
  );
});

test("stripManagedBlocks: a ```js info-string fence opens and a bare ``` closes it", () => {
  const doc = "```js\n" + `${S}\nex\n${E}\n` + "```\ntail";
  assert.equal(
    stripManagedBlocks(doc, S, E),
    doc,
    "an info-string open is closed by a bare fence; markers preserved",
  );
});

test("stripManagedBlocks: an INTERIOR info-string fence does NOT close an open fence (R6)", () => {
  // ```json (matching char + adequate run) but WITH an info string cannot close; the
  // real bare ``` closes → the markers between stay fenced (preserved), not deleted.
  const doc = "```\n" + `${S}\n` + "```json\n" + `${E}\n` + "```\ntail";
  assert.equal(
    stripManagedBlocks(doc, S, E),
    doc,
    "an info-string line cannot close a fence; markers preserved",
  );
});

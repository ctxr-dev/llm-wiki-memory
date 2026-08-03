// The recognition rules behind a generator that OVERWRITES and DELETES files. "Is this
// file ours?" decides whether authored content survives, so it is tested against literal
// inputs rather than only against a tree where everything already happens to be correct.
//
// Every case below is a real failure mode: a substring test for the pointer marker
// overwrote a shadow that carried a pointer AND 30 lines of authored procedure, and
// deleted an authored rule whose prose merely mentioned a relative `@`-import.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeRuleShadow,
  claudeSkillShadow,
  cursorShadow,
  deriveDescription,
  isPointerBody,
  pointerTarget,
  readDescription,
  yamlString,
} from "../scripts/lib/dev-surface-pointers.mjs";

test("the generator recognises its OWN output as a pointer", () => {
  assert.equal(isPointerBody(claudeRuleShadow("testing")), true);
  assert.equal(isPointerBody(claudeSkillShadow("write-migration", "desc")), true);
  assert.equal(isPointerBody(cursorShadow("testing", "desc", "rules")), true);
  assert.equal(isPointerBody(cursorShadow("run-tests-safely", "desc", "skills")), true);
});

test("a pointer PLUS authored content is NOT ours — the exact file that was destroyed", () => {
  const body = `---\nname: write-migration\ndescription: "d"\n---\n\n@../../../.agents/skills/write-migration.md\n\n## Procedure\n\n1. Pick the slot.\n2. Write detect() first.\n`;
  assert.equal(isPointerBody(body), false, "content beyond the pointer means hands off");
});

test("prose that MENTIONS a pointer is not a pointer", () => {
  for (const body of [
    "# How the wiring works\n\nA shadow body is `@../../.agents/rules/<n>.md`, nothing else.\n",
    "# Note\n\nSee @.agents/rules/testing.md for the canonical text, then edit it.\n",
    "# Local rule\n\n@../../docs/commands.md\n",
  ]) {
    assert.equal(isPointerBody(body), false, `must not claim: ${body.slice(0, 40)}`);
  }
});

test("a truncated or empty stub is not ours (so it is never silently deleted)", () => {
  assert.equal(isPointerBody(""), false);
  assert.equal(isPointerBody("---\nname: x\n---\n"), false, "frontmatter with no pointer");
  assert.equal(isPointerBody("<!-- Shadow stub: lost -->\n"), false, "note without the pointer");
  assert.equal(isPointerBody("\n\n   \n"), false, "whitespace only");
});

test("two pointers are not a well-formed shadow", () => {
  const body = "@../../.agents/rules/a.md\n@../../.agents/rules/b.md\n";
  assert.equal(isPointerBody(body), false);
});

test("CRLF line endings are recognised, not treated as foreign", () => {
  assert.equal(isPointerBody(claudeRuleShadow("testing").replace(/\n/g, "\r\n")), true);
});

test("pointerTarget extracts the canonical path from each emitted form", () => {
  assert.equal(pointerTarget(claudeRuleShadow("testing")), "../../.agents/rules/testing.md");
  assert.equal(
    pointerTarget(claudeSkillShadow("write-migration", "d")),
    "../../../.agents/skills/write-migration.md",
  );
  assert.equal(pointerTarget(cursorShadow("testing", "d", "rules")), ".agents/rules/testing.md");
  assert.equal(pointerTarget("# not a shadow\n"), "");
});

// ─── descriptions ────────────────────────────────────────────────────────────

test("a description containing ': ' is emitted as valid YAML", () => {
  // Every skill H1 begins "Skill: …", and an unquoted plain scalar containing ": " made
  // four shipped shadows unparseable — so those skills loaded in no client at all.
  const body = claudeSkillShadow("s", "Skill: triage findings — do the thing.");
  assert.match(body, /^description: "Skill: triage findings — do the thing\."$/m);
  assert.equal(yamlString('a "quoted" value'), '"a \\"quoted\\" value"');
});

test("readDescription round-trips a quoted value and reads an unquoted one", () => {
  assert.equal(
    readDescription(claudeSkillShadow("s", 'has "quotes" and: colons')),
    'has "quotes" and: colons',
  );
  assert.equal(readDescription("---\ndescription: plain value\n---\n"), "plain value");
});

test("readDescription treats an EMPTY or block-indicator value as absent", () => {
  // The old regex captured the NEXT key on an empty value, re-emitting
  // `description: alwaysApply: true` — invalid YAML, and sticky forever after.
  assert.equal(readDescription("---\ndescription:\nalwaysApply: true\n---\n"), "");
  assert.equal(readDescription("---\ndescription: >\n  folded text\n---\n"), "");
  assert.equal(readDescription("---\ndescription: |\n  literal text\n---\n"), "");
  assert.equal(readDescription("---\nname: x\n---\n"), "");
  assert.equal(readDescription("no frontmatter at all"), "");
});

test("readDescription handles CRLF instead of silently discarding the human's text", () => {
  assert.equal(
    readDescription('---\r\ndescription: "kept"\r\nalwaysApply: true\r\n---\r\n'),
    "kept",
  );
});

test("deriveDescription skips list items and never cuts mid-word", () => {
  const bulletLed =
    "# Skill: run the test suite safely\n\n1. Sweep stale workspaces first.\n\nProse here.\n";
  const derived = deriveDescription(bulletLed, ".agents/skills/run-tests-safely.md");
  assert.ok(!/— 1\./.test(derived), `a list marker is not a description: ${derived}`);
  assert.match(derived, /Prose here\./);

  const long = `# Title\n\n${"word ".repeat(120)}\n`;
  const cut = deriveDescription(long, ".agents/rules/x.md");
  assert.ok(!/wor Canonical/.test(cut), "must not cut mid-word");
  assert.match(cut, /Canonical file is \.agents\/rules\/x\.md\.$/);
});

test("deriveDescription always names the canonical file", () => {
  assert.match(
    deriveDescription("# T\n\nOne sentence. Two.\n", ".agents/rules/t.md"),
    /^T — One sentence\. Canonical file is \.agents\/rules\/t\.md\.$/,
  );
});

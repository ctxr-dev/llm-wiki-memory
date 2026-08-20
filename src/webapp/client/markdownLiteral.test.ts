import { test, expect } from "vitest";
import {
  LITERAL_LANG,
  deliteralize,
  denseEqual,
  escapeFences,
  isEditableLossless,
  literalize,
  splitBlocks,
  unescapeFences,
  wrapLiteral,
} from "./markdownLiteral";
import { roundTripMarkdown } from "./losslessGuard";

/**
 * Every construct the real corpus proved the editor cannot round-trip on its own.
 * Each MUST survive an edit session intact; a regression here silently corrupts notes.
 */
const HOSTILE: Record<string, string> = {
  "indented code (4-space)": "Intro\n\n    1. Step one\n       - detail\n    2. Step two\n",
  "indented fence": "Intro\n\n    ```\n    <type>[scope]: <desc>\n\n    [body]\n    ```\n",
  "indented fence with lang": "Text\n\n    ```diff\n    === NEW: a/b.scala\n    + added\n    ```\n",
  "html block": "Before\n\n<pre>\n  tree ├─ node\n</pre>\n\nAfter\n",
  "html with attributes": '<pre class="x">\n<a href="f.md#L12">f.md :12</a>\n</pre>\n',
  table: "| a | b |\n|---|---|\n| 1 | 2 |\n",
  "nested ordered list": "1. one\n   1. nested\n2. two\n",
  "task list nested": "- [x] top\n  - [x] 1.1 nested item\n",
  footnote: "Text with a note[^1]\n\n[^1]: the note body\n",
  "hard break": "line one  \nline two\n",
  "closed atx heading": "## Heading ##\n",
  "setext heading": "Title\n=====\n",
  "backticks inside literal": "    ```\n    ```\n    nested fences\n    ```\n    ```\n",
  "escape marker in source": "A ⟪ literal marker ⟫ in prose\n\n    indented to force wrapping\n",
  "mermaid fence": "```mermaid\nflowchart LR\n  A-->B\n```\n",
  "deep indent": "        deeply indented text\n",
  "mixed tabs": "\ttab indented\n",
  "blockquote with list": "> quoted\n> - item\n",
};

test.each(Object.entries(HOSTILE))(
  "an edit session preserves every line: %s",
  (_name, markdown) => {
    expect(isEditableLossless(markdown)).toBe(true);
    const carried = roundTripMarkdown(literalize(markdown));
    expect(denseEqual(deliteralize(carried), markdown)).toBe(true);
  },
);

test("deliteralize inverts literalize line-for-line (trailing whitespace aside)", () => {
  for (const markdown of Object.values(HOSTILE)) {
    const back = deliteralize(literalize(markdown));
    expect(back.replace(/\r\n/g, "\n").trimEnd()).toBe(markdown.replace(/\r\n/g, "\n").trimEnd());
  }
});

test("escapeFences/unescapeFences round-trip any backtick run and the marker itself", () => {
  const cases = ["```", "````", "   ```js", "⟪", "⟪E⟫", "⟪F3⟫", "a ⟪ b ⟫ c", "```\n⟪\n````\n"];
  for (const c of cases) expect(unescapeFences(escapeFences(c))).toBe(c);
});

test("a document the editor already handles is passed through untouched", () => {
  const plain = "# Title\n\nSome **bold** prose and a [link](https://example.com).\n\n- one\n- two";
  expect(literalize(plain)).toBe(plain);
});

test("literal wrapping uses a letter-only language tag (Lexical truncates at a hyphen)", () => {
  expect(LITERAL_LANG).toMatch(/^[a-z]+$/);
  const wrapped = wrapLiteral("    indented");
  expect(roundTripMarkdown(wrapped)).toContain(LITERAL_LANG);
});

test("splitBlocks never cuts inside a fence", () => {
  const md = "para\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\ntail";
  const blocks = splitBlocks(md);
  expect(blocks.some((b) => b.includes("const a") && b.includes("const b"))).toBe(true);
  expect(blocks).toHaveLength(3);
});

test("denseEqual accepts blank-line reflow but rejects a dropped line", () => {
  expect(denseEqual("a\n\n\nb", "a\nb")).toBe(true);
  expect(denseEqual("a\nb", "a")).toBe(false);
  expect(denseEqual("a\nb", "a\nB")).toBe(false);
});

test("literalize escalates until the encoding verifiably carries the document", () => {
  /**
   * Indented fences inside indented code: blocks that survive alone but shift once the
   * editor parses the whole document. The escalation must still preserve them.
   */
  const pathological = [
    "# Log",
    "",
    "    ### section",
    "    ```",
    "    <type>[scope]: <desc>",
    "    ```",
    "",
    "    ```diff",
    "    === MODIFICATION: a/b.scala",
    "    + line",
    "    ```",
    "",
    "tail prose",
  ].join("\n");
  expect(isEditableLossless(pathological)).toBe(true);
  const back = deliteralize(roundTripMarkdown(literalize(pathological)));
  expect(denseEqual(back, pathological)).toBe(true);
  expect(back).toContain("    === MODIFICATION: a/b.scala");
});

test("the rich editor is never refused: no input leaves isEditableLossless false", () => {
  const inputs = [
    "",
    "\n\n\n",
    "```lwmliteral\nalready looks like our own encoding\n```",
    "    ```\n    ```\n",
    "<div><pre>x</pre></div>",
    "| a |\n|---|\n| ⟪F3⟫ |",
  ];
  for (const md of inputs) expect(isEditableLossless(md)).toBe(true);
});

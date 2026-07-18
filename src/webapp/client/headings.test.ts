import { test, expect } from "vitest";
import { extractToc, slugify } from "./headings";

test("extractToc pulls headings, tracks depth, and skips fenced code", () => {
  const md = "# Title\n\ntext\n\n## Section One\n\n```js\n# not a heading\n```\n\n### Deep\n";
  const items = extractToc(md);
  expect(items.map((i) => i.text)).toEqual(["Title", "Section One", "Deep"]);
  expect(items.map((i) => i.depth)).toEqual([1, 2, 3]);
  expect(items[1].slug).toBe("section-one");
});

test("slugify lowercases and strips punctuation like github-slugger", () => {
  expect(slugify("Hello, World!")).toBe("hello-world");
  expect(slugify("Section One")).toBe("section-one");
});

test("extractToc dedupes repeated headings the way rehype-slug does", () => {
  const items = extractToc("## Setup\n\n### step\n\n## Setup\n");
  expect(items.map((i) => i.slug)).toEqual(["setup", "step", "setup-1"]);
});

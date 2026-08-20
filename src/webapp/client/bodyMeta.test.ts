import { test, expect } from "vitest";
import { splitBodyMeta } from "./bodyMeta";

test("splits a heading, a contiguous metadata list, and the prose", () => {
  const body =
    "# Title\n\n- type: decision\n- area: backend\n- tags: kafka, streaming\n\nProse begins here.\n\nMore prose.";
  const result = splitBodyMeta(body);
  expect(result.heading).toBe("# Title");
  expect(result.metaList).toEqual([
    "- type: decision",
    "- area: backend",
    "- tags: kafka, streaming",
  ]);
  expect(result.prose).toBe("Prose begins here.\n\nMore prose.");
});

test("a leaf with no metadata preamble is returned unchanged", () => {
  const body = "# Title\n\nJust prose, no key: value list.";
  const result = splitBodyMeta(body);
  expect(result.heading).toBeNull();
  expect(result.metaList).toEqual([]);
  expect(result.prose).toBe(body);
});

test("a body without a leading heading is returned unchanged", () => {
  const body = "- type: decision\n- area: backend\n\nProse.";
  const result = splitBodyMeta(body);
  expect(result.heading).toBeNull();
  expect(result.metaList).toEqual([]);
  expect(result.prose).toBe(body);
});

test("stops the metadata run at the first non key:value line", () => {
  const body = "# Title\n\n- priority: P1\nsudden prose\n- not: captured";
  const result = splitBodyMeta(body);
  expect(result.metaList).toEqual(["- priority: P1"]);
  expect(result.prose).toBe("sudden prose\n- not: captured");
});

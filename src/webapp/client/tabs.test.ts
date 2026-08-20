import { test, expect } from "vitest";
import { parseTabs } from "./tabs";

test("parseTabs returns the stored string array", () => {
  expect(parseTabs(JSON.stringify(["a/b.md", "c.md"]))).toEqual(["a/b.md", "c.md"]);
});

test("parseTabs is empty for null, invalid JSON, or a non-array value", () => {
  expect(parseTabs(null)).toEqual([]);
  expect(parseTabs("")).toEqual([]);
  expect(parseTabs("{not json")).toEqual([]);
  expect(parseTabs("42")).toEqual([]);
  expect(parseTabs('{"a":1}')).toEqual([]);
});

test("parseTabs drops non-string array members", () => {
  expect(parseTabs('["ok", 5, null, "fine"]')).toEqual(["ok", "fine"]);
});

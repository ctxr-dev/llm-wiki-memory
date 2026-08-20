import { test, expect } from "vitest";
import { navItems } from "./navItems";

test("tags dirs then docs into one ordered list", () => {
  const result = navItems({
    category: "knowledge",
    path: "",
    dirs: [{ name: "backend", label: "Backend", count: 3 }],
    docs: [{ id: "knowledge/a.md", name: "a.md", title: "Alpha", active: true }],
  });
  expect(result).toEqual([
    { kind: "dir", name: "backend", label: "Backend", count: 3 },
    { kind: "doc", id: "knowledge/a.md", name: "a.md", title: "Alpha", active: true },
  ]);
});

test("returns an empty list for undefined children", () => {
  expect(navItems(undefined)).toEqual([]);
});

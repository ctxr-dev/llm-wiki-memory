import { test, expect } from "vitest";
import { relabel, categoryLabel } from "./nav-labels.mjs";

test("relabel maps sentinel facet dirs to Unspecified", () => {
  for (const sentinel of ["unscoped", "unknown", "untyped", "general", "misc"]) {
    expect(relabel(sentinel)).toBe("Unspecified");
  }
});

test("relabel humanizes real slugs and leaves numeric segments intact", () => {
  expect(relabel("backend")).toBe("Backend");
  expect(relabel("bug-root-cause")).toBe("Bug Root Cause");
  expect(relabel("2026")).toBe("2026");
  expect(relabel("07")).toBe("07");
});

test("categoryLabel prettifies a category name", () => {
  expect(categoryLabel("self_improvement")).toBe("Self Improvement");
  expect(categoryLabel("knowledge")).toBe("Knowledge");
});

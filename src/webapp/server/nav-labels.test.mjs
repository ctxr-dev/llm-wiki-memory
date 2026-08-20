import { test, expect } from "vitest";
import { relabel, categoryLabel, locationOf } from "./nav-labels.mjs";

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

test("locationOf renders a readable breadcrumb from a doc id, dropping the filename", () => {
  expect(locationOf("knowledge/backend/decision/architecture/alpha.md")).toBe(
    "Knowledge › Backend › Decision › Architecture",
  );
});

test("locationOf omits sentinel segments but keeps the category label", () => {
  expect(locationOf("knowledge/unscoped/untyped/general/orphan.md")).toBe("Knowledge");
});

test("locationOf drops the issue-topology digit shards but keeps tracker + lifecycle", () => {
  expect(locationOf("issues/JIRA/DEV/122/64/8/in-progress/DEV-122648-fix.plan.md")).toBe(
    "Issues › JIRA › DEV › In Progress",
  );
});

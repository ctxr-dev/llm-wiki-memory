import { test, expect } from "vitest";
import { docCrumbs, locationLabel, crumbLabel } from "./crumbs";

test("builds clickable crumbs from a doc id, dropping the filename", () => {
  const crumbs = docCrumbs("knowledge/backend/decision/architecture/kafka.md");
  expect(crumbs.map((crumb) => crumb.label)).toEqual([
    "Knowledge",
    "Backend",
    "Decision",
    "Architecture",
  ]);
  expect(crumbs[0]).toEqual({ label: "Knowledge", category: "knowledge", path: "" });
  expect(crumbs[3].path).toBe("backend/decision/architecture");
});

test("omits sentinel segments but keeps the category crumb", () => {
  const crumbs = docCrumbs("knowledge/unscoped/untyped/general/orphan.md");
  expect(crumbs.map((crumb) => crumb.label)).toEqual(["Knowledge"]);
});

test("a bare category id yields no crumbs", () => {
  expect(docCrumbs("kafka.md")).toEqual([]);
});

test("crumbLabel humanizes a category + path into a breadcrumb string", () => {
  expect(crumbLabel("knowledge", "")).toBe("Knowledge");
  expect(crumbLabel("knowledge", "backend/decision")).toBe("Knowledge › Backend › Decision");
  expect(crumbLabel("knowledge", "unscoped/general")).toBe("Knowledge");
  expect(crumbLabel("issues", "JIRA/DEV/122/64/8/in-progress")).toBe(
    "Issues › JIRA › DEV › In Progress",
  );
});

test("locationLabel joins prettified segments, dropping sentinels and issue digit shards", () => {
  expect(locationLabel("knowledge/backend/decision/architecture/kafka.md")).toBe(
    "Knowledge › Backend › Decision › Architecture",
  );
  expect(locationLabel("knowledge/unscoped/untyped/general/orphan.md")).toBe("Knowledge");
  expect(locationLabel("issues/JIRA/DEV/122/64/8/in-progress/DEV-122648-fix.plan.md")).toBe(
    "Issues › JIRA › DEV › In Progress",
  );
});

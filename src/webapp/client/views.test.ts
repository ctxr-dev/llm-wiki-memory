import { test, expect } from "vitest";
import { availableViews } from "./views";

test("availableViews always includes docs and follows the wiki's layout for boards", () => {
  expect(
    availableViews(["knowledge", "self_improvement", "plans", "investigations", "issues"]),
  ).toEqual(["docs", "plans", "issues"]);
  expect(availableViews(["knowledge", "plans"])).toEqual(["docs", "plans"]);
  expect(availableViews(["knowledge", "issues"])).toEqual(["docs", "issues"]);
  expect(availableViews(["shared_notes"])).toEqual(["docs"]);
  expect(availableViews([])).toEqual(["docs"]);
  expect(availableViews(undefined)).toEqual(["docs"]);
});

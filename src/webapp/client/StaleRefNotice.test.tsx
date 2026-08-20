import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StaleRefNotice } from "./StaleRefNotice";

const REQUESTED = "issues/JIRA/DEV/134/9/6/in-progress/DEV-134096-cleanup.plan.md";
const RESOLVED = "issues/JIRA/DEV/134/9/6/pending/DEV-134096-cleanup.plan.md";

test("names both ids, so the substitution is checkable instead of silent", () => {
  render(<StaleRefNotice requestedId={REQUESTED} resolvedId={RESOLVED} />);
  const notice = screen.getByRole("status");
  expect(notice.textContent).toContain(REQUESTED);
  expect(notice.textContent).toContain(RESOLVED);
});

/**
 * The tab, the URL and the saved tab list all name the served leaf by the time this renders,
 * so a notice that only said "this moved" would leave the requested id recorded nowhere.
 */
test("warns that a same-named plan is not proof of identity", () => {
  render(<StaleRefNotice requestedId={REQUESTED} resolvedId={RESOLVED} />);
  const text = screen.getByRole("status").textContent ?? "";
  expect(text).toMatch(/no longer exists/i);
  expect(text).toMatch(/keep their name/i);
  expect(text).toMatch(/check/i);
});

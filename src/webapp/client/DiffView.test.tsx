import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView } from "./DiffView";

test("marks added and removed lines", () => {
  const { container } = render(<DiffView oldText={"a\nb\nc\n"} newText={"a\nB\nc\n"} />);
  expect(container.textContent).toContain("+ B");
  expect(container.textContent).toContain("- b");
});

test("reports no changes when the body is identical", () => {
  render(<DiffView oldText="same" newText="same" />);
  expect(screen.getByText(/No changes/)).toBeTruthy();
});

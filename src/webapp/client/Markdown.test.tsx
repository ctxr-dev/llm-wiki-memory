import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

test("renders gfm tables, slugged headings, and inline code", () => {
  const md = "## Heading Here\n\nSome `inline` code.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
  render(<Markdown body={md} />);
  const heading = screen.getByText("Heading Here");
  expect(heading.tagName).toBe("H2");
  expect(heading.id).toBe("heading-here");
  expect(screen.getByText("inline").tagName).toBe("CODE");
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByText("1").tagName).toBe("TD");
});

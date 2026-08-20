import { test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PriorityBadge } from "./PriorityBadge";
import { PRIORITY_META } from "./facets";

afterEach(() => cleanup());

test("renders a colored badge for each known priority", () => {
  render(<PriorityBadge priority="P0" />);
  const badge = screen.getByText("P0");
  expect(badge.className).toContain(PRIORITY_META.P0.classes.split(" ")[0]);
  expect(badge.getAttribute("title")).toBe(PRIORITY_META.P0.explanation);
});

test("falls back to plain text for an unknown value", () => {
  render(<PriorityBadge priority="P9" />);
  const node = screen.getByText("P9");
  expect(node.className).not.toContain("bg-");
  expect(node.getAttribute("title")).toBeNull();
});

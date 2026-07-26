import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import { WikiIcon } from "./WikiIcon";

test("renders the brain-chip icon for the home wiki", () => {
  const { container } = render(<WikiIcon kind="home" />);
  expect(container.querySelector('[data-icon="brain"]')).toBeTruthy();
  expect(container.querySelector('[data-icon="git"]')).toBeNull();
});

test("renders the git icon for a repo (added) wiki", () => {
  const { container } = render(<WikiIcon kind="added" />);
  expect(container.querySelector('[data-icon="git"]')).toBeTruthy();
  expect(container.querySelector('[data-icon="brain"]')).toBeNull();
});

test("the icon is decorative (aria-hidden) and inherits color via currentColor", () => {
  const { container } = render(<WikiIcon kind="home" />);
  const svg = container.querySelector("svg") as SVGElement;
  expect(svg.getAttribute("aria-hidden")).toBe("true");
  expect(svg.querySelector('path[stroke="currentColor"]')).toBeTruthy();
  expect(svg.querySelector('path[stroke="#000000"]')).toBeNull();
});

test("applies a custom size class", () => {
  const { container } = render(<WikiIcon kind="added" className="h-5 w-5" />);
  expect((container.querySelector("svg") as SVGElement).getAttribute("class")).toContain("h-5");
});

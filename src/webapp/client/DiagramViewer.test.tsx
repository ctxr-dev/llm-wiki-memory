import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  DiagramFrame,
  clampZoom,
  fitZoom,
  svgNaturalSize,
  zoomFromWheel,
  ZOOM_MIN,
  ZOOM_MAX,
} from "./DiagramViewer";

const NATURAL = { width: 2000, height: 400 };

function renderFrame(natural = NATURAL) {
  return render(
    <DiagramFrame
      label="diagram"
      natural={natural}
      preview={<div data-testid="preview">preview</div>}
      full={<div data-testid="full">full</div>}
    />,
  );
}

function openFrame(natural = NATURAL) {
  const view = renderFrame(natural);
  fireEvent.click(screen.getByRole("button", { name: "open diagram full screen" }));
  return view;
}

test("zoom is clamped to the supported range", () => {
  expect(clampZoom(1)).toBe(1);
  expect(clampZoom(1e6)).toBe(ZOOM_MAX);
  expect(clampZoom(0)).toBe(ZOOM_MIN);
});

test("fit shrinks a diagram wider than the viewport but never enlarges a small one", () => {
  const wide = fitZoom({ width: 4000, height: 200 }, { width: 1000, height: 800 });
  expect(wide).toBeLessThan(1);
  expect(fitZoom({ width: 50, height: 50 }, { width: 1000, height: 800 })).toBe(1);
});

test("fit accounts for BOTH axes, so a very tall diagram is bounded by height", () => {
  const tall = fitZoom({ width: 100, height: 4000 }, { width: 1000, height: 800 });
  const byHeight = fitZoom({ width: 1, height: 4000 }, { width: 1000, height: 800 });
  expect(tall).toBeCloseTo(byHeight, 5);
  expect(tall).toBeLessThan(1);
});

test("fit is degenerate-safe for a zero-sized or missing viewBox", () => {
  expect(fitZoom({ width: 0, height: 0 }, { width: 800, height: 600 })).toBe(1);
  expect(svgNaturalSize("<svg></svg>")).toBeNull();
  expect(svgNaturalSize('<svg viewBox="0 0 nope 4"></svg>')).toBeNull();
  expect(svgNaturalSize('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
});

test("natural size is read from the svg viewBox", () => {
  expect(svgNaturalSize('<svg viewBox="0 0 1024 768">')).toEqual({ width: 1024, height: 768 });
  expect(svgNaturalSize('<svg viewBox="0 0 12.5 7.5">')).toEqual({ width: 12.5, height: 7.5 });
});

test("an unmodified wheel is left to the browser, so native scrolling is not duplicated", () => {
  expect(zoomFromWheel({ deltaY: 120, ctrlKey: false, metaKey: false })).toBeNull();
  expect(zoomFromWheel({ deltaY: -120, ctrlKey: false, metaKey: false })).toBeNull();
});

test("ctrl or cmd wheel zooms, in both directions", () => {
  const inward = zoomFromWheel({ deltaY: -120, ctrlKey: true, metaKey: false });
  const outward = zoomFromWheel({ deltaY: 120, ctrlKey: false, metaKey: true });
  expect(inward).toBeGreaterThan(1);
  expect(outward).toBeLessThan(1);
  expect(outward).toBeCloseTo(1 / (inward ?? 1), 6);
});

test("the expand control is present and labelled before the overlay is opened", () => {
  renderFrame();
  expect(screen.getByRole("button", { name: "open diagram full screen" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the expand control is hidden until hover or keyboard focus", () => {
  renderFrame();
  const cls = screen.getByRole("button", { name: "open diagram full screen" }).className;
  expect(cls).toContain("opacity-0");
  expect(cls).toContain("group-hover:opacity-100");
  expect(cls).toContain("focus-visible:opacity-100");
});

test("opening shows the diagram in a full-window dialog", () => {
  openFrame();
  const dialog = screen.getByRole("dialog", { name: "diagram" });
  expect(dialog.className).toContain("fixed");
  expect(dialog.className).toContain("inset-0");
  expect(screen.getByTestId("full")).toBeTruthy();
});

test("escape closes the overlay", () => {
  openFrame();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the close button closes the overlay", () => {
  openFrame();
  fireEvent.click(screen.getByRole("button", { name: "close diagram" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a wide diagram opens already fitted, not at 100%", () => {
  openFrame({ width: 6000, height: 400 });
  const shown = Number(screen.getByText(/%$/).textContent?.replace("%", ""));
  expect(shown).toBeLessThan(100);
  expect(shown).toBeGreaterThan(0);
});

test("zoom in and out move the level, and fit returns to the fitted level", () => {
  openFrame({ width: 6000, height: 400 });
  const level = () => Number(screen.getByText(/%$/).textContent?.replace("%", ""));
  const fitted = level();
  fireEvent.click(screen.getByRole("button", { name: "zoom in" }));
  const zoomedIn = level();
  expect(zoomedIn).toBeGreaterThan(fitted);
  fireEvent.click(screen.getByRole("button", { name: "zoom out" }));
  expect(level()).toBeLessThan(zoomedIn);
  fireEvent.click(screen.getByRole("button", { name: "zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "fit to window" }));
  expect(level()).toBe(fitted);
});

test("keyboard shortcuts zoom and refit while the overlay is open", () => {
  openFrame({ width: 6000, height: 400 });
  const level = () => Number(screen.getByText(/%$/).textContent?.replace("%", ""));
  const fitted = level();
  fireEvent.keyDown(window, { key: "+" });
  expect(level()).toBeGreaterThan(fitted);
  fireEvent.keyDown(window, { key: "0" });
  expect(level()).toBe(fitted);
});

test("closing the overlay removes its key handler, so later keys do not act on it", () => {
  openFrame({ width: 6000, height: 400 });
  fireEvent.click(screen.getByRole("button", { name: "close diagram" }));
  fireEvent.keyDown(window, { key: "+" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

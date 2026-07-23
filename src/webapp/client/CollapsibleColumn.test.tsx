import { test, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { CollapsibleColumn } from "./CollapsibleColumn";

function mockMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: "",
    onchange: null,
    addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: () => mql });
  return {
    cross(next: boolean) {
      act(() => {
        mql.matches = next;
        listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent));
      });
    },
  };
}

function renderColumn(railContext?: string) {
  return render(
    <CollapsibleColumn
      ariaLabel="wikis"
      railLabel="Wikis"
      railContext={railContext}
      expandedWidthClass="w-56"
      collapseBelowPx={768}
      header={<span>My Header</span>}
    >
      <div>Body content</div>
    </CollapsibleColumn>,
  );
}

beforeEach(() => mockMatchMedia(false));
afterEach(() => cleanup());

test("expands when the viewport is wide", () => {
  mockMatchMedia(false);
  renderColumn();
  expect(screen.getByText("My Header")).toBeTruthy();
  expect(screen.getByText("Body content")).toBeTruthy();
  expect(screen.getByLabelText("collapse Wikis")).toBeTruthy();
});

test("collapses to a rail when the viewport is narrow, showing the label + context", () => {
  mockMatchMedia(true);
  renderColumn("My Wiki");
  expect(screen.getByLabelText("expand Wikis")).toBeTruthy();
  expect(screen.queryByText("Body content")).toBeNull();
  expect(screen.getByText("Wikis")).toBeTruthy();
  expect(screen.getByText("My Wiki")).toBeTruthy();
});

test("manual collapse/expand works within a stable width", () => {
  mockMatchMedia(false);
  renderColumn();
  fireEvent.click(screen.getByLabelText("collapse Wikis"));
  expect(screen.queryByText("Body content")).toBeNull();
  fireEvent.click(screen.getByLabelText("expand Wikis"));
  expect(screen.getByText("Body content")).toBeTruthy();
});

test("a width crossing overrides the in-session manual state", () => {
  const media = mockMatchMedia(true);
  renderColumn();
  fireEvent.click(screen.getByLabelText("expand Wikis"));
  expect(screen.getByText("Body content")).toBeTruthy();
  media.cross(true);
  expect(screen.queryByText("Body content")).toBeNull();
  expect(screen.getByLabelText("expand Wikis")).toBeTruthy();
  media.cross(false);
  expect(screen.getByText("Body content")).toBeTruthy();
});

test("focus moves to the counterpart control after toggling (keyboard continuity)", () => {
  mockMatchMedia(false);
  renderColumn();
  fireEvent.click(screen.getByLabelText("collapse Wikis"));
  expect(screen.getByLabelText("expand Wikis")).toBe(document.activeElement);
  fireEvent.click(screen.getByLabelText("expand Wikis"));
  expect(screen.getByLabelText("collapse Wikis")).toBe(document.activeElement);
});

test("a responsive crossing does NOT steal focus, even after a manual toggle", () => {
  const media = mockMatchMedia(false);
  renderColumn();
  fireEvent.click(screen.getByLabelText("collapse Wikis"));
  (document.activeElement as HTMLElement | null)?.blur();
  media.cross(false);
  expect(screen.getByLabelText("collapse Wikis")).not.toBe(document.activeElement);
});

test("a change to expandToken force-expands a collapsed column", () => {
  mockMatchMedia(true);
  const column = (token: number) => (
    <CollapsibleColumn
      ariaLabel="browse"
      railLabel="Categories"
      expandedWidthClass="w-64"
      collapseBelowPx={768}
      expandToken={token}
      header={<span>Cats</span>}
    >
      <div>Body content</div>
    </CollapsibleColumn>
  );
  const { rerender } = render(column(1));
  expect(screen.getByLabelText("expand Categories")).toBeTruthy();
  rerender(column(2));
  expect(screen.getByText("Body content")).toBeTruthy();
});

test("renders as the requested element for a right-side column", () => {
  mockMatchMedia(false);
  const { container } = render(
    <CollapsibleColumn
      as="aside"
      side="right"
      ariaLabel="table of contents and related"
      railLabel="TOC & Related Docs"
      expandedWidthClass="w-56"
      collapseBelowPx={1024}
      header={<span />}
    >
      <div>Body content</div>
    </CollapsibleColumn>,
  );
  expect(container.querySelector("aside")).toBeTruthy();
  expect(screen.getByLabelText("collapse TOC & Related Docs")).toBeTruthy();
});

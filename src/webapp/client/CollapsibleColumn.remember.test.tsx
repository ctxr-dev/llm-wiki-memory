import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CollapsibleColumn } from "./CollapsibleColumn";
import { mockMatchMedia } from "./matchMedia.testkit";

/**
 * The remember-my-choice contrwhich is deliberately asymmetric:
 * the automatic rules may always TAKE space from a column, and may only give it
 * back to one the user has not explicitly closed.
 */

function renderColumn(token?: number) {
  return render(
    <CollapsibleColumn
      ariaLabel="wikis"
      railLabel="Wikis"
      storageKey="wikis"
      expandedWidthClass="w-56"
      collapseBelowPx={768}
      expandToken={token}
      header={<span>My Header</span>}
    >
      <div>Body content</div>
    </CollapsibleColumn>,
  );
}

const isExpanded = () => screen.queryByText("Body content") !== null;

/**
 * jsdom ships no localStorage; the repo's convention (see theme.test.ts) is a
 * Map-backed stub. It has to persist across the cleanup/re-render that stands in
 * for a page reload, so it is created once per test and torn down after.
 */
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("an untouched column still follows the width, exactly as before", () => {
  const media = mockMatchMedia(false);
  renderColumn();
  expect(isExpanded()).toBe(true);
  media.cross(true);
  expect(isExpanded()).toBe(false);
  media.cross(false);
  expect(isExpanded()).toBe(true);
  expect(localStorage.getItem("lwm-column:wikis")).toBeNull();
});

test("a column the user COLLAPSED is never reopened by a width change", () => {
  const media = mockMatchMedia(false);
  renderColumn();
  fireEvent.click(screen.getByLabelText("collapse Wikis"));
  expect(isExpanded()).toBe(false);
  media.cross(true);
  expect(isExpanded()).toBe(false);
  /** The old behaviour reopened here. It must not. */
  media.cross(false);
  expect(isExpanded()).toBe(false);
});

test("a column the user EXPANDED may still be collapsed when space runs out", () => {
  /**
   * The one exception: holding a column open in a viewport too narrow to show
   * the document is not honouring the choice, it is breaking the page.
   */
  const media = mockMatchMedia(true);
  renderColumn();
  fireEvent.click(screen.getByLabelText("expand Wikis"));
  expect(isExpanded()).toBe(true);
  media.cross(true);
  expect(isExpanded()).toBe(false);
});

test("and it reopens once the room comes back, because that was the choice", () => {
  const media = mockMatchMedia(true);
  renderColumn();
  fireEvent.click(screen.getByLabelText("expand Wikis"));
  media.cross(true);
  expect(isExpanded()).toBe(false);
  media.cross(false);
  expect(isExpanded()).toBe(true);
});

test("the choice survives a reload", () => {
  const media = mockMatchMedia(false);
  renderColumn();
  fireEvent.click(screen.getByLabelText("collapse Wikis"));
  expect(localStorage.getItem("lwm-column:wikis")).toBe("collapsed");
  cleanup();

  mockMatchMedia(false);
  renderColumn();
  expect(isExpanded()).toBe(false);
  media.cross(false);
  expect(isExpanded()).toBe(false);
});

test("an expanded choice survives a reload into a narrow viewport, still collapsed", () => {
  mockMatchMedia(false);
  renderColumn();
  fireEvent.click(screen.getByLabelText("collapse Wikis"));
  fireEvent.click(screen.getByLabelText("expand Wikis"));
  expect(localStorage.getItem("lwm-column:wikis")).toBe("expanded");
  cleanup();

  const media = mockMatchMedia(true);
  renderColumn();
  expect(isExpanded()).toBe(false);
  media.cross(false);
  expect(isExpanded()).toBe(true);
});

test("expandToken does NOT reopen a column the user collapsed", () => {
  /**
   * Selecting a wiki normally reveals its categories. That is exactly the kind of
   * helpful automatic expand the user was overriding when they shut the column.
   */
  mockMatchMedia(true);
  const { rerender } = renderColumn(1);
  fireEvent.click(screen.getByLabelText("expand Wikis"));
  fireEvent.click(screen.getByLabelText("collapse Wikis"));
  expect(isExpanded()).toBe(false);

  rerender(
    <CollapsibleColumn
      ariaLabel="wikis"
      railLabel="Wikis"
      storageKey="wikis"
      expandedWidthClass="w-56"
      collapseBelowPx={768}
      expandToken={2}
      header={<span>My Header</span>}
    >
      <div>Body content</div>
    </CollapsibleColumn>,
  );
  expect(isExpanded()).toBe(false);
});

test("expandToken still reopens an untouched column", () => {
  mockMatchMedia(true);
  const { rerender } = renderColumn(1);
  expect(isExpanded()).toBe(false);
  rerender(
    <CollapsibleColumn
      ariaLabel="wikis"
      railLabel="Wikis"
      storageKey="wikis"
      expandedWidthClass="w-56"
      collapseBelowPx={768}
      expandToken={2}
      header={<span>My Header</span>}
    >
      <div>Body content</div>
    </CollapsibleColumn>,
  );
  expect(isExpanded()).toBe(true);
  /** An automatic expand is not a user choice and must not be remembered as one. */
  expect(localStorage.getItem("lwm-column:wikis")).toBeNull();
});

test("a corrupt stored value is ignored rather than wedging the column", () => {
  localStorage.setItem("lwm-column:wikis", "sideways");
  const media = mockMatchMedia(false);
  renderColumn();
  expect(isExpanded()).toBe(true);
  media.cross(true);
  expect(isExpanded()).toBe(false);
});

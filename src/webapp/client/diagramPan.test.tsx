import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiagramFrame } from "./DiagramViewer";
import { movedBeyondThreshold, panTarget } from "./diagramPan";

const ORIGIN = { pointerX: 100, pointerY: 50, scrollLeft: 300, scrollTop: 200 };

function pointer(element: HTMLElement, type: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  fireEvent(element, event);
  return event;
}

function openViewer() {
  render(
    <DiagramFrame
      label="diagram"
      natural={{ width: 4000, height: 3000 }}
      preview={<div data-testid="preview">preview</div>}
      full={<div data-testid="full">full</div>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "open diagram full screen" }));
  return screen
    .getByRole("dialog", { name: "diagram" })
    .querySelector("div.overflow-auto") as HTMLDivElement;
}

test("dragging moves the content with the pointer, so scroll goes the opposite way", () => {
  expect(panTarget(ORIGIN, 140, 80)).toEqual({ scrollLeft: 260, scrollTop: 170 });
  expect(panTarget(ORIGIN, 60, 20)).toEqual({ scrollLeft: 340, scrollTop: 230 });
});

test("a pan that has not moved yet leaves the scroll position untouched", () => {
  expect(panTarget(ORIGIN, ORIGIN.pointerX, ORIGIN.pointerY)).toEqual({
    scrollLeft: ORIGIN.scrollLeft,
    scrollTop: ORIGIN.scrollTop,
  });
});

test("the drag threshold ignores a jitter but catches a real movement on either axis", () => {
  expect(movedBeyondThreshold(ORIGIN, 101, 51)).toBe(false);
  expect(movedBeyondThreshold(ORIGIN, 104, 50)).toBe(true);
  expect(movedBeyondThreshold(ORIGIN, 100, 46)).toBe(true);
});

test("the scroll area advertises a grab cursor before a drag starts", () => {
  expect(openViewer().className).toContain("cursor-grab");
});

test("the cursor becomes grabbing while dragging and returns to grab afterwards", () => {
  const scroller = openViewer();
  pointer(scroller, "pointerdown", { clientX: 100, clientY: 50 });
  expect(scroller.className).toContain("cursor-grabbing");
  pointer(scroller, "pointerup");
  expect(scroller.className).toContain("cursor-grab");
  expect(scroller.className).not.toContain("cursor-grabbing");
});

test("a cancelled pointer stops the pan instead of leaving it stuck", () => {
  const scroller = openViewer();
  pointer(scroller, "pointerdown", { clientX: 100, clientY: 50 });
  pointer(scroller, "pointercancel");
  expect(scroller.className).not.toContain("cursor-grabbing");
});

test("dragging scrolls the container by the pointer delta", () => {
  const scroller = openViewer();
  scroller.scrollLeft = 300;
  scroller.scrollTop = 200;
  pointer(scroller, "pointerdown", { clientX: 100, clientY: 50 });
  pointer(scroller, "pointermove", { clientX: 140, clientY: 80 });
  expect(scroller.scrollLeft).toBe(260);
  expect(scroller.scrollTop).toBe(170);
});

test("a pointer move with no drag in progress does not scroll", () => {
  const scroller = openViewer();
  scroller.scrollLeft = 300;
  pointer(scroller, "pointermove", { clientX: 140, clientY: 80 });
  expect(scroller.scrollLeft).toBe(300);
});

test.each([
  ["left", 0],
  ["middle", 1],
  ["right", 2],
])("the %s button pans", (_name, button) => {
  const scroller = openViewer();
  scroller.scrollLeft = 300;
  pointer(scroller, "pointerdown", { button, clientX: 100, clientY: 50 });
  pointer(scroller, "pointermove", { button, clientX: 60, clientY: 50 });
  expect(scroller.scrollLeft).toBe(340);
});

test("pointerdown prevents the default so middle-click autoscroll and selection do not fight the pan", () => {
  const scroller = openViewer();
  expect(pointer(scroller, "pointerdown", { clientX: 10, clientY: 10 }).defaultPrevented).toBe(
    true,
  );
});

test("the context menu is suppressed so a right-button drag can pan", () => {
  const scroller = openViewer();
  expect(pointer(scroller, "contextmenu").defaultPrevented).toBe(true);
});

test("a click that ends a real drag is swallowed, so panning over a link does not follow it", () => {
  const scroller = openViewer();
  const onClick = vi.fn();
  scroller.addEventListener("click", onClick);
  pointer(scroller, "pointerdown", { clientX: 100, clientY: 50 });
  pointer(scroller, "pointermove", { clientX: 200, clientY: 50 });
  pointer(scroller, "pointerup");
  fireEvent.click(scroller);
  expect(onClick).not.toHaveBeenCalled();
});

test("a click without a drag still reaches its target", () => {
  const scroller = openViewer();
  const onClick = vi.fn();
  scroller.addEventListener("click", onClick);
  pointer(scroller, "pointerdown", { clientX: 100, clientY: 50 });
  pointer(scroller, "pointerup");
  fireEvent.click(scroller);
  expect(onClick).toHaveBeenCalled();
});

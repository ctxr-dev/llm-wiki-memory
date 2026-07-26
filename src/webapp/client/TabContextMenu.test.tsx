import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TabContextMenu } from "./TabContextMenu";

afterEach(() => cleanup());

function renderMenu(overrides = {}) {
  const props = {
    x: 10,
    y: 20,
    isPinned: false,
    orientation: "horizontal" as const,
    onCloseTab: vi.fn(),
    onCloseOthers: vi.fn(),
    onTogglePin: vi.fn(),
    onCopyReference: vi.fn(),
    onSetOrientation: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<TabContextMenu {...props} />);
  return props;
}

test("Close and Close Others each invoke their action and dismiss", () => {
  const props = renderMenu();
  fireEvent.click(screen.getByText("Close"));
  expect(props.onCloseTab).toHaveBeenCalled();
  expect(props.onDismiss).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("Close Others"));
  expect(props.onCloseOthers).toHaveBeenCalled();
  expect(props.onDismiss).toHaveBeenCalledTimes(2);
});

test("the pin item reflects the pinned state and toggles", () => {
  const props = renderMenu({ isPinned: true });
  expect(screen.getByText("Unpin")).toBeTruthy();
  fireEvent.click(screen.getByText("Unpin"));
  expect(props.onTogglePin).toHaveBeenCalled();
});

test("an unpinned tab offers 'Pin to Start'", () => {
  renderMenu({ isPinned: false });
  expect(screen.getByText("Pin to Start")).toBeTruthy();
});

test("Copy reference invokes the handler and dismisses", () => {
  const props = renderMenu();
  fireEvent.click(screen.getByText("Copy reference"));
  expect(props.onCopyReference).toHaveBeenCalled();
  expect(props.onDismiss).toHaveBeenCalled();
});

test("orientation options mark the current one and switch on click", () => {
  const props = renderMenu({ orientation: "horizontal" });
  expect(
    screen.getByRole("menuitemradio", { name: /Horizontal/ }).getAttribute("aria-checked"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Vertical/ }));
  expect(props.onSetOrientation).toHaveBeenCalledWith("vertical");
});

test("Escape dismisses the menu", () => {
  const props = renderMenu();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(props.onDismiss).toHaveBeenCalled();
});

test("a mousedown outside the menu dismisses it", () => {
  const props = renderMenu();
  fireEvent.mouseDown(document.body);
  expect(props.onDismiss).toHaveBeenCalled();
});

test("the menu is positioned at the cursor coordinates", () => {
  renderMenu({ x: 123, y: 456 });
  const menu = screen.getByRole("menu");
  expect(menu.style.left).toBe("123px");
  expect(menu.style.top).toBe("456px");
});

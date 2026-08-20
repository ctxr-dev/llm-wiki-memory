import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

test("renders a labelled dialog with a title and a close button", () => {
  render(
    <Modal label="add wiki" title="Add a wiki" onClose={vi.fn()}>
      <p>body</p>
    </Modal>,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.getAttribute("aria-label")).toBe("add wiki");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(screen.getByText("Add a wiki")).toBeTruthy();
  expect(screen.getByLabelText("close")).toBeTruthy();
});

test("Escape and the close button both call onClose", () => {
  const onClose = vi.fn();
  render(
    <Modal label="add wiki" title="t" onClose={onClose}>
      <p>body</p>
    </Modal>,
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(screen.getByLabelText("close"));
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("clicking the backdrop closes; clicking inside the surface does NOT", () => {
  const onClose = vi.fn();
  render(
    <Modal label="m" onClose={onClose}>
      <p>inside</p>
    </Modal>,
  );
  fireEvent.click(screen.getByText("inside"));
  expect(onClose).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  fireEvent.click(dialog.parentElement as HTMLElement);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("without a title there is no header/close button", () => {
  render(
    <Modal label="m" onClose={vi.fn()}>
      <p>body</p>
    </Modal>,
  );
  expect(screen.queryByLabelText("close")).toBeNull();
});

test("focuses its own surface on mount so Escape works even with no autofocused control", () => {
  render(
    <Modal label="m" onClose={vi.fn()}>
      <p>body</p>
    </Modal>,
  );
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
});

test("does NOT steal focus from an autofocused control inside", () => {
  render(
    <Modal label="m" onClose={vi.fn()}>
      <input autoFocus data-testid="inp" />
    </Modal>,
  );
  expect(document.activeElement).toBe(screen.getByTestId("inp"));
});

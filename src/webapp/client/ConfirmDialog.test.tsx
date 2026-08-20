import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

test("renders the message + confirm/cancel and wires their handlers", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      label="remove wiki"
      title="Remove wiki?"
      message="This removes Repo from the sidebar."
      confirmLabel="Remove"
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByText("This removes Repo from the sidebar.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("Escape / backdrop / close cancel (never confirm)", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<ConfirmDialog label="c" message="m" onConfirm={onConfirm} onCancel={onCancel} />);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

test("a danger confirm is a filled-red button; a non-danger one is primary", () => {
  const { rerender } = render(
    <ConfirmDialog
      label="c"
      message="m"
      confirmLabel="Yes"
      danger
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Yes" }).className).toMatch(/bg-red-600/);
  rerender(
    <ConfirmDialog
      label="c"
      message="m"
      confirmLabel="Yes"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Yes" }).className).toMatch(/bg-slate-800/);
});

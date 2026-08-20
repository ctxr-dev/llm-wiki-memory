import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DeleteDialog } from "./DeleteDialog";

afterEach(() => cleanup());

test("the Delete button is armed only after the word delete is typed", () => {
  const onConfirm = vi.fn();
  render(<DeleteDialog name="kafka.md" onConfirm={onConfirm} onCancel={vi.fn()} />);
  const del = screen.getByRole("button", { name: "Delete" });
  expect(del.hasAttribute("disabled")).toBe(true);
  fireEvent.click(del);
  expect(onConfirm).not.toHaveBeenCalled();

  fireEvent.change(screen.getByPlaceholderText("delete"), { target: { value: "delete" } });
  expect(del.hasAttribute("disabled")).toBe(false);
  fireEvent.click(del);
  expect(onConfirm).toHaveBeenCalled();
});

test("Enter confirms only when armed (case-insensitive)", () => {
  const onConfirm = vi.fn();
  render(<DeleteDialog name="kafka.md" onConfirm={onConfirm} onCancel={vi.fn()} />);
  const input = screen.getByPlaceholderText("delete");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "DELETE" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onConfirm).toHaveBeenCalled();
});

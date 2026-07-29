import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Select } from "./Select";

afterEach(() => cleanup());

const OPTS = ["P0", "P1", "P2"];

test("shows the current value, and the placeholder when empty", () => {
  const { rerender } = render(
    <Select value="P1" options={OPTS} ariaLabel="priority" onChange={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: "priority" }).textContent).toContain("P1");
  rerender(<Select value="" options={OPTS} ariaLabel="priority" onChange={vi.fn()} />);
  expect(screen.getByRole("button", { name: "priority" }).textContent).toContain("—");
});

test("opens, lists options, and selecting one calls onChange then closes", () => {
  const onChange = vi.fn();
  render(<Select value="" options={OPTS} ariaLabel="priority" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "priority" }));
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: "P2" }));
  expect(onChange).toHaveBeenCalledWith("P2");
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("the placeholder row clears the value", () => {
  const onChange = vi.fn();
  render(<Select value="P1" options={OPTS} ariaLabel="priority" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "priority" }));
  fireEvent.click(screen.getByRole("option", { name: "—" }));
  expect(onChange).toHaveBeenCalledWith("");
});

test("the selected option is aria-selected", () => {
  render(<Select value="P1" options={OPTS} ariaLabel="priority" onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "priority" }));
  expect(screen.getByRole("option", { name: "P1" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("option", { name: "P0" }).getAttribute("aria-selected")).toBe("false");
});

test("Escape closes the list", () => {
  render(<Select value="" options={OPTS} ariaLabel="priority" onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "priority" }));
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("valueLabel renders the trigger and optionLabel renders each row", () => {
  render(
    <Select
      value="P1"
      options={OPTS}
      ariaLabel="priority"
      valueLabel={(value) => <span data-testid="val">badge-{value}</span>}
      optionLabel={(value) => <span>opt-{value}</span>}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByTestId("val").textContent).toBe("badge-P1");
  fireEvent.click(screen.getByRole("button", { name: "priority" }));
  expect(screen.getByRole("option", { name: "opt-P0" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "opt-P2" })).toBeTruthy();
});

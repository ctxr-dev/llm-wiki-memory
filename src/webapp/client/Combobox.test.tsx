import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Combobox, filterOptions } from "./Combobox";

afterEach(() => cleanup());

test("filterOptions matches case-insensitively and returns all for an empty query", () => {
  const options = ["backend", "frontend", "infra"];
  expect(filterOptions(options, "")).toEqual(options);
  expect(filterOptions(options, "END")).toEqual(["backend", "frontend"]);
  expect(filterOptions(options, "front")).toEqual(["frontend"]);
});

test("typing filters suggestions and clicking one selects it", () => {
  const onChange = vi.fn();
  render(<Combobox value="ba" options={["backend", "frontend"]} onChange={onChange} />);
  fireEvent.focus(screen.getByRole("combobox"));
  const options = screen.getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["backend"]);
  fireEvent.click(options[0]);
  expect(onChange).toHaveBeenCalledWith("backend");
});

test("free text is emitted as-is so custom values are allowed", () => {
  const onChange = vi.fn();
  render(<Combobox value="" options={["backend"]} onChange={onChange} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "payments" } });
  expect(onChange).toHaveBeenCalledWith("payments");
});

test("ArrowDown highlights a suggestion and Enter selects it", () => {
  const onChange = vi.fn();
  render(<Combobox value="" options={["backend", "frontend"]} onChange={onChange} />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("backend");
});

test("the toggle button opens the suggestion list", () => {
  render(<Combobox value="" options={["backend"]} onChange={vi.fn()} />);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Toggle suggestions" }));
  expect(screen.getByRole("listbox")).toBeTruthy();
});

test("shows the humanized label when idle and the raw value while focused", () => {
  render(
    <Combobox
      value="bug-root-cause"
      options={["bug-root-cause"]}
      labelFor={(candidate) => candidate.replace(/-/g, " ")}
      onChange={vi.fn()}
    />,
  );
  const input = screen.getByRole("combobox") as HTMLInputElement;
  expect(input.value).toBe("bug root cause");
  fireEvent.focus(input);
  expect(input.value).toBe("bug-root-cause");
  fireEvent.blur(input);
  expect(input.value).toBe("bug root cause");
});

test("labelFor humanizes the suggestion display but selecting stores the raw value", () => {
  const onChange = vi.fn();
  render(
    <Combobox
      value=""
      options={["bug-root-cause"]}
      labelFor={(candidate) => candidate.replace(/-/g, " ")}
      onChange={onChange}
    />,
  );
  fireEvent.focus(screen.getByRole("combobox"));
  const option = screen.getAllByRole("option")[0];
  expect(option.textContent).toBe("bug root cause");
  fireEvent.click(option);
  expect(onChange).toHaveBeenCalledWith("bug-root-cause");
});

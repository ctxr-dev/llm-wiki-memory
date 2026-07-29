import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FrontmatterForm } from "./FrontmatterForm";

test("renders facet fields, bubbles edits, and shows task_type only for self_improvement", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <FrontmatterForm
      category="knowledge"
      memory={{ area: "backend", atom_type: "decision" }}
      onChange={onChange}
    />,
  );
  const area = screen.getByDisplayValue("Backend") as HTMLInputElement;
  expect(area.value).toBe("Backend");
  expect(screen.queryByText("Task type")).toBeNull();

  fireEvent.change(area, { target: { value: "frontend" } });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ area: "frontend" }));

  rerender(<FrontmatterForm category="self_improvement" memory={{}} onChange={onChange} />);
  expect(screen.getByText("Task type")).toBeTruthy();
});

test("the priority dropdown shows colored badges with explanations", () => {
  render(<FrontmatterForm category="knowledge" memory={{ priority: "P1" }} onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Priority" }));
  const p0 = screen.getByText("P0");
  expect(p0.className).toContain("bg-red-100");
  expect(screen.getByText(/Hard constraint/)).toBeTruthy();
});

test("shows a config-driven info icon only for facets that have a description", () => {
  const facets = { meta: { area: { description: "the sub-module" } }, areas: [], subjects: [] };
  render(<FrontmatterForm category="knowledge" memory={{}} onChange={vi.fn()} facets={facets} />);
  expect(screen.getByLabelText("About Area")).toBeTruthy();
  expect(screen.queryByLabelText("About Subject")).toBeNull();
});

test("subject is edited as tags: typing plus Enter stores it as an array", () => {
  const onChange = vi.fn();
  render(<FrontmatterForm category="knowledge" memory={{}} onChange={onChange} />);
  const input = screen.getByLabelText(/subject/i);
  fireEvent.change(input, { target: { value: "architecture" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subject: ["architecture"] }));
});

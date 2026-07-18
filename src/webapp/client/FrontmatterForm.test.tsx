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
  const area = screen.getByDisplayValue("backend") as HTMLInputElement;
  expect(area.value).toBe("backend");
  expect(screen.queryByText("task_type")).toBeNull();

  fireEvent.change(area, { target: { value: "frontend" } });
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ area: "frontend" }));

  rerender(<FrontmatterForm category="self_improvement" memory={{}} onChange={onChange} />);
  expect(screen.getByText("task_type")).toBeTruthy();
});

test("subject is edited as a comma-separated list and stored as an array", () => {
  const onChange = vi.fn();
  render(<FrontmatterForm category="knowledge" memory={{}} onChange={onChange} />);
  const subject = screen.getByLabelText(/subject/i);
  fireEvent.change(subject, { target: { value: "architecture, testing" } });
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ subject: ["architecture", "testing"] }),
  );
});

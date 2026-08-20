import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TagInput, addTag, removeTag, suggestTags } from "./TagInput";

afterEach(() => cleanup());

test("addTag trims, dedupes, and drops empty values", () => {
  expect(addTag(["a"], " b ")).toEqual(["a", "b"]);
  expect(addTag(["a"], "a")).toEqual(["a"]);
  expect(addTag(["a"], "   ")).toEqual(["a"]);
});

test("removeTag removes the matching value", () => {
  expect(removeTag(["a", "b"], "a")).toEqual(["b"]);
});

test("suggestTags excludes chosen tags and filters case-insensitively", () => {
  expect(suggestTags(["architecture", "testing"], ["testing"], "")).toEqual(["architecture"]);
  expect(suggestTags(["architecture", "testing"], [], "TEST")).toEqual(["testing"]);
});

test("Enter adds a chip and the remove button deletes it", () => {
  const onChange = vi.fn();
  const { rerender } = render(<TagInput value={[]} options={[]} onChange={onChange} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "architecture" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(["architecture"]);

  onChange.mockClear();
  rerender(<TagInput value={["architecture"]} options={[]} onChange={onChange} />);
  fireEvent.click(screen.getByLabelText("Remove architecture"));
  expect(onChange).toHaveBeenCalledWith([]);
});

test("a comma commits the current draft as a tag", () => {
  const onChange = vi.fn();
  render(<TagInput value={[]} options={[]} onChange={onChange} />);
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "infra" } });
  fireEvent.keyDown(input, { key: "," });
  expect(onChange).toHaveBeenCalledWith(["infra"]);
});

test("Backspace on an empty draft removes the last chip", () => {
  const onChange = vi.fn();
  render(<TagInput value={["a", "b"]} options={[]} onChange={onChange} />);
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Backspace" });
  expect(onChange).toHaveBeenCalledWith(["a"]);
});

test("pasting a comma-separated string adds each value as its own tag", () => {
  const onChange = vi.fn();
  render(<TagInput value={["a"]} options={[]} onChange={onChange} />);
  fireEvent.paste(screen.getByRole("combobox"), {
    clipboardData: { getData: () => "b, c" },
  });
  expect(onChange).toHaveBeenCalledWith(["a", "b", "c"]);
});

test("ArrowDown highlights a suggestion and Enter adds it", () => {
  const onChange = vi.fn();
  render(<TagInput value={[]} options={["architecture", "testing"]} onChange={onChange} />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith(["architecture"]);
});

test("clicking a suggestion adds it as a tag", () => {
  const onChange = vi.fn();
  render(<TagInput value={[]} options={["architecture", "testing"]} onChange={onChange} />);
  fireEvent.focus(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "architecture" }));
  expect(onChange).toHaveBeenCalledWith(["architecture"]);
});

test("labelFor humanizes chip + suggestion display while storing raw values", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <TagInput
      value={["bug-root-cause"]}
      options={[]}
      labelFor={(candidate) => candidate.replace(/-/g, " ")}
      onChange={onChange}
    />,
  );
  expect(screen.getByText("bug root cause")).toBeTruthy();
  expect(screen.getByLabelText("Remove bug root cause")).toBeTruthy();

  rerender(
    <TagInput
      value={[]}
      options={["testing"]}
      labelFor={(candidate) => candidate.toUpperCase()}
      onChange={onChange}
    />,
  );
  fireEvent.focus(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "TESTING" }));
  expect(onChange).toHaveBeenCalledWith(["testing"]);
});

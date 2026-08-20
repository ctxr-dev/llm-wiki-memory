import { test, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FieldLabel } from "./FieldLabel";

afterEach(() => cleanup());

test("humanizes the facet key and associates the label with its input", () => {
  render(<FieldLabel facet="atom_type" htmlFor="fm-atom_type" />);
  const label = screen.getByText("Atom type");
  expect(label.getAttribute("for")).toBe("fm-atom_type");
});

test("shows an info icon with the description only when one is provided", () => {
  const { rerender } = render(<FieldLabel facet="area" htmlFor="fm-area" />);
  expect(screen.queryByLabelText("About Area")).toBeNull();
  rerender(<FieldLabel facet="area" htmlFor="fm-area" description="the sub-module" />);
  const icon = screen.getByLabelText("About Area");
  expect(icon.getAttribute("title")).toBe("the sub-module");
});

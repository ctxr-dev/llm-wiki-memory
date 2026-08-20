import { test, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "./Button";

test("defaults to type=button (never an implicit form submit) and is clickable", () => {
  const onClick = vi.fn();
  render(<Button onClick={onClick}>Go</Button>);
  const btn = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
  expect(btn.type).toBe("button");
  expect(btn.className).toMatch(/cursor-pointer/);
  fireEvent.click(btn);
  expect(onClick).toHaveBeenCalled();
});

test("forwards type, disabled, title, aria-label and merges className", () => {
  render(
    <Button type="submit" disabled title="tip" aria-label="save it" className="extra-x">
      Save
    </Button>,
  );
  const btn = screen.getByRole("button", { name: "save it" }) as HTMLButtonElement;
  expect(btn.type).toBe("submit");
  expect(btn.disabled).toBe(true);
  expect(btn.title).toBe("tip");
  expect(btn.className).toMatch(/extra-x/);
});

test("forwards a ref to the underlying button (focus management)", () => {
  const ref = createRef<HTMLButtonElement>();
  render(<Button ref={ref}>x</Button>);
  expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  ref.current?.focus();
  expect(document.activeElement).toBe(ref.current);
});

test("an icon-only button takes its accessible name from aria-label; the icon is aria-hidden", () => {
  render(<Button aria-label="close" icon={<svg data-testid="glyph" />} />);
  expect(screen.getByRole("button", { name: "close" })).toBeTruthy();
  const glyphWrap = screen.getByTestId("glyph").parentElement;
  expect(glyphWrap?.getAttribute("aria-hidden")).toBe("true");
});

test("the row variant applies no action chrome (bg/border) but stays clickable", () => {
  render(
    <Button variant="row" className="bespoke-row">
      row
    </Button>,
  );
  const btn = screen.getByRole("button", { name: "row" });
  expect(btn.className).toMatch(/bespoke-row/);
  expect(btn.className).toMatch(/cursor-pointer/);
  expect(btn.className).not.toMatch(/\bbg-slate-800\b/);
});

import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Markdown } from "./Markdown";
import type { Wiki } from "./api";

const home: Wiki = {
  id: "home-id",
  kind: "home",
  root: "/ws/.llm-wiki-memory/wiki",
  mountDir: "/ws",
  projectModule: "ws-module",
  ownership: "wiki",
  label: "Main Brain",
  categories: ["knowledge"],
};

test("renders gfm tables, slugged headings, and inline code", () => {
  const md = "## Heading Here\n\nSome `inline` code.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n";
  render(<Markdown body={md} />);
  const heading = screen.getByText("Heading Here");
  expect(heading.tagName).toBe("H2");
  expect(heading.id).toBe("heading-here");
  expect(screen.getByText("inline").tagName).toBe("CODE");
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByText("1").tagName).toBe("TD");
});

test("a bare reference token becomes an in-app link that calls onOpenRef", () => {
  const onOpenRef = vi.fn();
  render(
    <Markdown body="See brain:knowledge/a.md for details." wikis={[home]} onOpenRef={onOpenRef} />,
  );
  const link = screen.getByText("brain:knowledge/a.md");
  expect(link.tagName).toBe("A");
  fireEvent.click(link);
  expect(onOpenRef).toHaveBeenCalledWith("home-id", "knowledge/a.md");
});

test("a markdown-link reference navigates in-app and keeps its label", () => {
  const onOpenRef = vi.fn();
  render(<Markdown body="[the doc](brain:knowledge/a.md)" wikis={[home]} onOpenRef={onOpenRef} />);
  const link = screen.getByText("the doc");
  expect(link.tagName).toBe("A");
  fireEvent.click(link);
  expect(onOpenRef).toHaveBeenCalledWith("home-id", "knowledge/a.md");
});

test("an http autolink is left as a normal external link (href preserved, not intercepted)", () => {
  render(<Markdown body="visit http://example.com/x now" wikis={[home]} onOpenRef={vi.fn()} />);
  const link = screen.getByText("http://example.com/x") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("http://example.com/x");
  expect(link.className).not.toContain("emerald");
});

test("a colon token that is not a resolvable reference is left as plain text", () => {
  render(<Markdown body="the meeting is at 12:30 today" wikis={[home]} onOpenRef={vi.fn()} />);
  expect(screen.getByText(/the meeting is at 12:30 today/)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

test("a reference inside inline code is NOT linkified", () => {
  render(<Markdown body="literally `brain:knowledge/a.md`" wikis={[home]} onOpenRef={vi.fn()} />);
  const code = screen.getByText("brain:knowledge/a.md");
  expect(code.tagName).toBe("CODE");
  expect(screen.queryByRole("link")).toBeNull();
});

test("a reference used as a link label does not become a nested link", () => {
  render(
    <Markdown body="[brain:knowledge/a.md](http://x.example)" wikis={[home]} onOpenRef={vi.fn()} />,
  );
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(1);
  expect((links[0] as HTMLAnchorElement).getAttribute("href")).toBe("http://x.example");
});

test("a degenerate token with no path before .md is not linkified", () => {
  render(<Markdown body="see brain:.md here" wikis={[home]} onOpenRef={vi.fn()} />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/see brain:.md here/)).toBeTruthy();
});

test("with no wikis passed, references are inert (backward compatible)", () => {
  render(<Markdown body="See brain:knowledge/a.md here" />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/See brain:knowledge\/a.md here/)).toBeTruthy();
});

test("renders safe raw HTML (a <pre> block) instead of escaping it", () => {
  render(<Markdown body={"<pre>root\n  └─ leaf</pre>"} />);
  const text = screen.getByText(/root/);
  expect(text.closest("pre")).toBeTruthy();
});

test("strips dangerous raw HTML: script tags are removed", () => {
  const { container } = render(<Markdown body={"ok<script>window.x = 1</script>"} />);
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText(/ok/)).toBeTruthy();
});

test("strips remote iframes from raw HTML", () => {
  const { container } = render(
    <Markdown body={'<iframe src="https://evil.example"></iframe>after'} />,
  );
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByText(/after/)).toBeTruthy();
});

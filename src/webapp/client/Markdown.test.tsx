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

const repo: Wiki = {
  ...home,
  id: "repo-id",
  kind: "added",
  projectModule: "Riskified/webhooks",
  ownership: "repo",
  label: "Webhooks",
};

const REF = "brain:knowledge/a.md";

function renderRef() {
  const onOpenRef = vi.fn();
  render(<Markdown body={`See ${REF} for details.`} wikis={[home]} onOpenRef={onOpenRef} />);
  return { onOpenRef, link: screen.getByText(REF) };
}

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
  const { onOpenRef, link } = renderRef();
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
  expect(link.className).not.toContain("wiki-ref");
  expect(link.getAttribute("data-wiki-ref")).toBeNull();
});

test("a colon token that is not a resolvable reference is left as plain text", () => {
  render(<Markdown body="the meeting is at 12:30 today" wikis={[home]} onOpenRef={vi.fn()} />);
  expect(screen.getByText(/the meeting is at 12:30 today/)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

test("a whole inline-code reference becomes a link that still renders a code element", () => {
  const onOpenRef = vi.fn();
  render(<Markdown body={`Escalations: \`${REF}\``} wikis={[home]} onOpenRef={onOpenRef} />);
  const code = screen.getByText(REF);
  expect(code.tagName).toBe("CODE");
  const link = code.closest("a");
  expect(link?.getAttribute("href")).toBe("#brain:knowledge/a.md");
  expect(link?.className).toContain("wiki-ref");
  fireEvent.click(code);
  expect(onOpenRef).toHaveBeenCalledWith("home-id", "knowledge/a.md");
});

test("a reference inside a longer code span stays literal code with no link", () => {
  render(<Markdown body={`run \`grep ${REF} file.txt\``} wikis={[home]} onOpenRef={vi.fn()} />);
  expect(screen.getByText(`grep ${REF} file.txt`).tagName).toBe("CODE");
  expect(screen.queryByRole("link")).toBeNull();
});

test("a reference inside a fenced code block stays literal", () => {
  render(<Markdown body={`\`\`\`\n${REF}\n\`\`\`\n`} wikis={[home]} onOpenRef={vi.fn()} />);
  const code = screen.getByText(REF);
  expect(code.tagName).toBe("CODE");
  expect(code.closest("pre")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

test("an inline-code span whose source resolves to no wiki stays literal code", () => {
  render(<Markdown body="see `nope:knowledge/a.md`" wikis={[home]} onOpenRef={vi.fn()} />);
  expect(screen.getByText("nope:knowledge/a.md").tagName).toBe("CODE");
  expect(screen.queryByRole("link")).toBeNull();
});

test("a code span whose ref is followed by more text stays literal code with no link", () => {
  render(<Markdown body={`run \`${REF} file.txt\``} wikis={[home]} onOpenRef={vi.fn()} />);
  expect(screen.getByText(`${REF} file.txt`).tagName).toBe("CODE");
  expect(screen.queryByRole("link")).toBeNull();
});

test.each([
  ["a source prefix with no document id at all", "brain:knowledge/a"],
  ["the grammar placeholder written in the authoring rule", "brain:<docId>"],
  ["a suffix with no name before .md", "brain:.md"],
  ["prose that merely starts with a source prefix", "brain: notes"],
  ["a ref trailed by a parenthetical", `${REF} (superseded)`],
])("an inline-code span holding %s stays literal code", (_case, content) => {
  render(<Markdown body={`see \`${content}\``} wikis={[home]} onOpenRef={vi.fn()} />);
  expect(screen.getByText(content).tagName).toBe("CODE");
  expect(screen.queryByRole("link")).toBeNull();
});

test("a repo-wiki source containing a slash survives sanitize in prose and in code", () => {
  const onOpenRef = vi.fn();
  const body = "See Riskified/webhooks:knowledge/a.md and `Riskified/webhooks:knowledge/b.md`.";
  render(<Markdown body={body} wikis={[home, repo]} onOpenRef={onOpenRef} />);
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(2);
  expect(links[0].getAttribute("href")).toBe("#Riskified/webhooks:knowledge/a.md");
  expect(links[1].getAttribute("href")).toBe("#Riskified/webhooks:knowledge/b.md");
  fireEvent.click(links[0]);
  expect(onOpenRef).toHaveBeenCalledWith("repo-id", "knowledge/a.md");
});

test("a token that is not defined in the document stays plain text", () => {
  render(<Markdown body="Priority P1 applies to this note." wikis={[home]} />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(/Priority P1 applies to this note./)).toBeTruthy();
});

test("a reference used as a link label does not become a nested link", () => {
  render(
    <Markdown body="[brain:knowledge/a.md](http://x.example)" wikis={[home]} onOpenRef={vi.fn()} />,
  );
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(1);
  expect((links[0] as HTMLAnchorElement).getAttribute("href")).toBe("http://x.example");
});

test("a reference inside a reference-style link label keeps the whole label in one link", () => {
  const body = `[see ${REF} now for detail][d]\n\n[d]: http://x.example\n`;
  render(<Markdown body={body} wikis={[home]} onOpenRef={vi.fn()} />);
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("href")).toBe("http://x.example");
  expect(links[0].textContent).toContain(`see ${REF} now for detail`);
});

test("a reference-style link whose whole label is a reference keeps an accessible name", () => {
  const body = `[${REF}][d]\n\n[d]: http://x.example\n`;
  render(<Markdown body={body} wikis={[home]} onOpenRef={vi.fn()} />);
  const link = screen.getByRole("link", { name: new RegExp(REF) });
  expect(link.getAttribute("href")).toBe("http://x.example");
  expect(link.querySelector("a")).toBeNull();
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

test("with no wikis passed, an inline-code reference stays literal code", () => {
  render(<Markdown body={`See \`${REF}\` here`} />);
  expect(screen.getByText(REF).tagName).toBe("CODE");
  expect(screen.queryByRole("link")).toBeNull();
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

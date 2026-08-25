import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Markdown } from "./Markdown";

const SVG_BODY = `# Diagram

<svg viewBox="0 0 200 100" role="img" aria-label="flow">
  <defs>
    <linearGradient id="grad"><stop offset="0" stop-color="#eb6c36" /></linearGradient>
  </defs>
  <rect x="1" y="1" width="198" height="98" fill="url(#grad)" stroke-width="2" stroke-linecap="round" />
  <text x="100" y="55" text-anchor="middle" font-size="12">usher</text>
</svg>

Trailing prose.
`;

test("an inline svg renders with its shapes and presentation attributes intact", () => {
  const { container } = render(<Markdown body={SVG_BODY} />);
  const svg = container.querySelector("svg");
  expect(svg).toBeTruthy();
  expect(svg?.getAttribute("viewBox")).toBe("0 0 200 100");
  expect(svg?.getAttribute("aria-label")).toBe("flow");
  const rect = container.querySelector("rect");
  expect(rect?.getAttribute("stroke-width")).toBe("2");
  expect(rect?.getAttribute("stroke-linecap")).toBe("round");
  expect(container.querySelector("text")?.textContent).toBe("usher");
});

test("an svg gradient reference survives, because ids are not rewritten", () => {
  const { container } = render(<Markdown body={SVG_BODY} />);
  expect(container.querySelector("linearGradient")?.getAttribute("id")).toBe("grad");
  expect(container.querySelector("rect")?.getAttribute("fill")).toBe("url(#grad)");
});

test("a block svg gets the same zoom and fullscreen frame that raw pre gets", () => {
  render(<Markdown body={SVG_BODY} />);
  expect(screen.getByRole("button", { name: "open diagram full screen" })).toBeTruthy();
});

test("opening a framed svg fills the dialog rather than showing it at 100%", () => {
  render(<Markdown body={SVG_BODY} />);
  fireEvent.click(screen.getByRole("button", { name: "open diagram full screen" }));
  expect(screen.getByRole("dialog", { name: "diagram" })).toBeTruthy();
  const shown = Number(screen.getByText(/%$/).textContent?.replace("%", ""));
  expect(shown).toBeGreaterThan(100);
});

test("rich html blocks render as real elements", () => {
  const md = `<section class="wrap">
<figure><figcaption>Cap</figcaption></figure>
<details><summary>More</summary><p>Hidden</p></details>
</section>
`;
  const { container } = render(<Markdown body={md} />);
  expect(container.querySelector("section.wrap")).toBeTruthy();
  expect(container.querySelector("figcaption")?.textContent).toBe("Cap");
  expect(container.querySelector("details summary")?.textContent).toBe("More");
});

test("a script tag is removed entirely, not unwrapped into visible text", () => {
  const { container } = render(<Markdown body={`<p>ok</p>\n<script>alert(1)</script>\n`} />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).not.toContain("alert(1)");
  expect(container.textContent).toContain("ok");
});

test("event handler attributes are stripped from otherwise allowed elements", () => {
  const md = `<div onclick="alert(1)" onmouseover="alert(2)">hover</div>\n`;
  const { container } = render(<Markdown body={md} />);
  const div = container.querySelector("div.md-body > div");
  expect(div?.getAttribute("onclick")).toBeNull();
  expect(div?.getAttribute("onmouseover")).toBeNull();
});

test("iframes and forms do not survive", () => {
  const md = `<iframe src="https://evil.example"></iframe>\n\n<form action="/x"><input type="text" /></form>\n`;
  const { container } = render(<Markdown body={md} />);
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector("form")).toBeNull();
});

test("a javascript url is neutralised on links", () => {
  const { container } = render(<Markdown body={`[click](javascript:alert(1))\n`} />);
  const href = container.querySelector("a")?.getAttribute("href");
  expect(href ?? "").not.toContain("javascript:");
});

test("a data image renders with its source intact and is framed", () => {
  const src = "data:image/png;base64,iVBORw0KGgo=";
  const { container } = render(<Markdown body={`![chart](${src})\n`} />);
  expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
  expect(screen.getByRole("button", { name: "open diagram full screen" })).toBeTruthy();
});

test("a non-image data url is still refused on an image source", () => {
  const { container } = render(
    <Markdown body={`![x](data:text/html;base64,PHNjcmlwdD4=)\n`} />,
  );
  expect(container.querySelector("img")?.getAttribute("src")).toBe("");
});

test("an image inside a sentence stays inline and is not framed", () => {
  const { container } = render(<Markdown body={`See ![i](https://e.com/a.png) here.\n`} />);
  expect(container.querySelector("img")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "open diagram full screen" })).toBeNull();
});

test("a container opts into the diagram frame by class", () => {
  render(<Markdown body={`<div class="diagram"><p>hand built</p></div>\n`} />);
  expect(screen.getByRole("button", { name: "open diagram full screen" })).toBeTruthy();
});

test("an ordinary container is not framed", () => {
  render(<Markdown body={`<div class="note"><p>plain</p></div>\n`} />);
  expect(screen.queryByRole("button", { name: "open diagram full screen" })).toBeNull();
});

test("existing markdown behaviour is unchanged by the richer html support", () => {
  const md = "## H\n\n| A |\n|---|\n| 1 |\n\n```mermaid\nflowchart LR\n  a-->b\n```\n";
  const { container } = render(<Markdown body={md} />);
  expect(screen.getByText("H").tagName).toBe("H2");
  expect(container.querySelector("table")).toBeTruthy();
});

test("author class names survive on tags the default schema used to restrict", () => {
  const md = `<section class="wrap"><ul class="grid"><li class="cell">x</li></ul></section>\n`;
  const { container } = render(<Markdown body={md} />);
  expect(container.querySelector("section")?.getAttribute("class")).toBe("wrap");
  expect(container.querySelector("ul")?.getAttribute("class")).toBe("grid");
  expect(container.querySelector("li")?.getAttribute("class")).toBe("cell");
});

test("a section can opt into the diagram frame by class", () => {
  render(<Markdown body={`<section class="diagram"><p>hand built</p></section>\n`} />);
  expect(screen.getByRole("button", { name: "open diagram full screen" })).toBeTruthy();
});

test("an svg inside a heading or caption is left inline", () => {
  const md = `## Title <svg viewBox="0 0 4 2"><rect /></svg>\n`;
  const { container } = render(<Markdown body={md} />);
  expect(container.querySelector("h2 svg")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "open diagram full screen" })).toBeNull();
});

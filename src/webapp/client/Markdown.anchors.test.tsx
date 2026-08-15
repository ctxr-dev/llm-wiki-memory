import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
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

const REF = "brain:knowledge/a.md";

const DEF_TOKEN_DOC = "## E1 — netty upgrade\n\nThe fix for E1 is queued.\n";

function clickAnchor(anchor: HTMLElement, init?: MouseEventInit): Event {
  const event = createEvent.click(anchor, init);
  fireEvent(anchor, event);
  return event;
}

function renderRef() {
  const onOpenRef = vi.fn();
  render(<Markdown body={`See ${REF} for details.`} wikis={[home]} onOpenRef={onOpenRef} />);
  return { onOpenRef, link: screen.getByText(REF) };
}

function stubScrollIntoView() {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  return scrollIntoView;
}

test("a wiki-ref anchor carries the app hash route and names its wiki in the tooltip", () => {
  const { link } = renderRef();
  expect(link.getAttribute("href")).toBe("#brain:knowledge/a.md");
  expect(link.getAttribute("data-wiki-ref")).toBe(REF);
  expect(link.getAttribute("title")).toContain("Main Brain");
  expect(link.getAttribute("title")).toContain("Cmd-click");
  expect(link.getAttribute("target")).toBeNull();
});

test("a plain click on a wiki ref opens it in the app and prevents native navigation", () => {
  const { onOpenRef, link } = renderRef();
  const event = clickAnchor(link);
  expect(onOpenRef).toHaveBeenCalledWith("home-id", "knowledge/a.md");
  expect(event.defaultPrevented).toBe(true);
});

test("modifier and middle clicks on a wiki ref are left to the browser", () => {
  const { onOpenRef, link } = renderRef();
  const inits: MouseEventInit[] = [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ];
  for (const init of inits) {
    expect(clickAnchor(link, init).defaultPrevented).toBe(false);
  }
  expect(onOpenRef).not.toHaveBeenCalled();
});

test("a percent-encoded reference href is decoded once before it is opened or re-encoded", () => {
  const onOpenRef = vi.fn();
  render(<Markdown body="See `brain:knowledge/café.md`" wikis={[home]} onOpenRef={onOpenRef} />);
  const link = screen.getByText("brain:knowledge/café.md").closest("a") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("#brain:knowledge/caf%C3%A9.md");
  expect(link.getAttribute("data-wiki-ref")).toBe("brain:knowledge/café.md");
  fireEvent.click(link);
  expect(onOpenRef).toHaveBeenCalledWith("home-id", "knowledge/café.md");
});

test("external links open a browser tab; wiki refs and fragment links never do", () => {
  const body = `## Heading Here\n\nhttp://example.com/x then ${REF} and [jump](#heading-here)`;
  render(<Markdown body={body} wikis={[home]} />);
  const external = screen.getByText("http://example.com/x");
  const wikiRef = screen.getByText(REF);
  const fragment = screen.getByText("jump");
  expect(external.getAttribute("target")).toBe("_blank");
  expect(external.getAttribute("rel")).toBe("noopener noreferrer");
  expect(external.className).toContain("external-link");
  expect(external.className).not.toContain("wiki-ref");
  expect(external.getAttribute("data-wiki-ref")).toBeNull();
  expect(wikiRef.className).toContain("wiki-ref");
  expect(wikiRef.className).not.toContain("external-link");
  expect(fragment.getAttribute("href")).toBe("#heading-here");
  expect(fragment.getAttribute("target")).toBeNull();
  expect(fragment.getAttribute("rel")).toBeNull();
});

test("a relative link opens a browser tab so the app's tabs survive the click", () => {
  render(<Markdown body="[source](../hodor/Utils.scala#L88)" wikis={[home]} />);
  const link = screen.getByText("source");
  expect(link.getAttribute("href")).toBe("../hodor/Utils.scala#L88");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});

test("a fragment link scrolls in-page instead of overwriting the document's hash route", () => {
  const scrollIntoView = stubScrollIntoView();
  render(<Markdown body={"## Heading Here\n\n[jump](#heading-here)"} wikis={[home]} />);
  expect(clickAnchor(screen.getByText("jump")).defaultPrevented).toBe(true);
  expect(scrollIntoView).toHaveBeenCalled();
  expect(screen.getByText("Heading Here").getAttribute("tabindex")).toBe("-1");
});

test("a raw-HTML anchor keeps the sanitize-approved attributes its author wrote", () => {
  const body = '<p><a href="./x.scala#L131" title="hint" id="anchor-1">label</a></p>';
  render(<Markdown body={body} wikis={[home]} />);
  const link = screen.getByText("label");
  expect(link.getAttribute("id")).toBe("anchor-1");
  expect(link.getAttribute("title")).toBe("hint");
});

test("a raw-HTML id survives sanitize unprefixed so in-document links still reach it", () => {
  render(<Markdown body={'<p id="pid">para</p>\n\n[jump](#pid)'} wikis={[home]} />);
  expect(screen.getByText("para").getAttribute("id")).toBe("pid");
  expect(screen.getByText("jump").getAttribute("href")).toBe("#pid");
});

test("a footnote marker points at the id the footnote definition actually carries", () => {
  const { container } = render(<Markdown body={"text[^1]\n\n[^1]: a note\n"} />);
  const marker = container.querySelector("sup a") as HTMLAnchorElement;
  const target = container.querySelector(marker.getAttribute("href") ?? "");
  expect(target).not.toBeNull();
  expect(target?.textContent).toContain("a note");
});

test("an occurrence of a heading-defined token links to that heading and scrolls to it", () => {
  const scrollIntoView = stubScrollIntoView();
  render(<Markdown body={DEF_TOKEN_DOC} />);
  const heading = screen.getByText("E1 — netty upgrade");
  expect(heading.id.length).toBeGreaterThan(0);
  const occurrence = screen.getByText("E1");
  expect(occurrence.tagName).toBe("A");
  expect(occurrence.getAttribute("href")).toBe(`#${heading.id}`);
  expect(occurrence.getAttribute("data-def-token")).toBe("E1");
  expect(clickAnchor(occurrence).defaultPrevented).toBe(true);
  expect(scrollIntoView).toHaveBeenCalled();
  expect(heading.className).toContain("def-token-flash");
});

test("a table-row definition anchors later occurrences at its def- id and flashes it", () => {
  const scrollIntoView = stubScrollIntoView();
  const md = [
    "| Item | Detail |",
    "| --- | --- |",
    "| **E1** | netty upgrade |",
    "",
    "Register: E1 still needs an owner.",
  ].join("\n");
  render(<Markdown body={md} />);
  const [definition, occurrence] = screen.getAllByText("E1");
  expect(definition.tagName).toBe("STRONG");
  expect(definition.id).toBe("def-e1");
  expect(occurrence.tagName).toBe("A");
  expect(occurrence.getAttribute("href")).toBe("#def-e1");
  clickAnchor(occurrence);
  expect(scrollIntoView).toHaveBeenCalled();
  expect(definition.className).toContain("def-token-flash");
});

test("a definition-token jump moves focus to the definition for keyboard users", () => {
  stubScrollIntoView();
  render(<Markdown body={DEF_TOKEN_DOC} />);
  const heading = screen.getByText("E1 — netty upgrade");
  clickAnchor(screen.getByText("E1"));
  expect(heading.getAttribute("tabindex")).toBe("-1");
  expect(document.activeElement).toBe(heading);
});

test("modifier and middle clicks on a definition token stay in-page instead of opening a tab", () => {
  const scrollIntoView = stubScrollIntoView();
  render(<Markdown body={DEF_TOKEN_DOC} />);
  const occurrence = screen.getByText("E1");
  const inits: MouseEventInit[] = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }];
  for (const init of inits) {
    expect(clickAnchor(occurrence, init).defaultPrevented).toBe(true);
  }
  const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
  fireEvent(occurrence, middle);
  expect(middle.defaultPrevented).toBe(true);
  expect(scrollIntoView).toHaveBeenCalledTimes(inits.length + 1);
});

test("unmounting cancels a pending flash so no stale highlight outlives the document", () => {
  stubScrollIntoView();
  const { unmount } = render(<Markdown body={DEF_TOKEN_DOC} />);
  const heading = screen.getByText("E1 — netty upgrade");
  clickAnchor(screen.getByText("E1"));
  expect(heading.className).toContain("def-token-flash");
  unmount();
  expect(heading.className).not.toContain("def-token-flash");
});

test("every anchor kind carries dark-theme variant classes", () => {
  const body = `## E1 — first\n\nSee ${REF}, E1 and http://example.com/x.\n`;
  render(<Markdown body={body} wikis={[home]} />);
  const wikiRef = screen.getByText(REF);
  const defToken = screen.getByText("E1");
  const external = screen.getByText("http://example.com/x");
  for (const anchor of [wikiRef, defToken, external]) {
    expect(anchor.tagName).toBe("A");
    expect(anchor.className).toContain("dark:");
  }
  expect(wikiRef.className).toContain("dark:bg-indigo-950");
  expect(defToken.className).toContain("dark:text-amber-400");
  expect(external.className).toContain("dark:text-sky-400");
});

test("anchor icons centre by flex auto-margin, not a hand-tuned baseline offset", () => {
  const { container } = render(
    <Markdown body={`[label](${REF}) and [ext](https://x.example)`} wikis={[home]} />,
  );
  const icons = [...container.querySelectorAll("a svg")];
  expect(icons).toHaveLength(2);
  for (const icon of icons) {
    expect(icon.getAttribute("class")).toContain("my-auto");
    expect(icon.getAttribute("class")).not.toMatch(/align-\[/);
    expect(icon.getAttribute("class")).toMatch(/h-\[[\d.]+em\] w-\[[\d.]+em\]/);
    expect(icon.getAttribute("class")).not.toMatch(/\bm[rl]-(?!\[3px\])/);
  }
});

test("an icon-bearing anchor is a flex box, which is what makes my-auto centre the icon", () => {
  const { container } = render(
    <Markdown body={`[label](${REF}) and [ext](https://x.example)`} wikis={[home]} />,
  );
  for (const anchor of [...container.querySelectorAll("a")]) {
    expect(anchor.className).toContain("inline-flex");
  }
});

test("both anchor kinds size their icon identically, so alignment cannot drift apart", () => {
  const { container } = render(
    <Markdown body={`[label](${REF}) and [ext](https://x.example)`} wikis={[home]} />,
  );
  const sizes = [...container.querySelectorAll("a svg")].map(
    (icon) => (icon.getAttribute("class") ?? "").match(/h-\[[\d.]+em\] w-\[[\d.]+em\]/)?.[0],
  );
  expect(sizes[0]).toBeDefined();
  expect(sizes[0]).toBe(sizes[1]);
});

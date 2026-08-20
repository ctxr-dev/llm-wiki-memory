import { describe, test, expect } from "vitest";
import { applyDefTokens, findDefinitions, rehypeDefTokens } from "./rehypeDefTokens";
import { DEF_TOKEN_ATTR, DEF_TOKEN_CLASS } from "./defTokens";
import type { HastNode } from "./defTokens";

function txt(value: string): HastNode {
  return { type: "text", value };
}

function el(
  tagName: string,
  children: HastNode[],
  properties: Record<string, unknown> = {},
): HastNode {
  return { type: "element", tagName, properties, children };
}

function doc(children: HastNode[]): HastNode {
  return { type: "root", children };
}

function strong(value: string): HastNode {
  return el("strong", [txt(value)]);
}

function cells(...contents: HastNode[][]): HastNode {
  return el(
    "tr",
    contents.map((content) => el("td", content)),
  );
}

function definitionRow(token: string, description: string): HastNode {
  return cells([strong(token)], [txt(description)]);
}

function table(rows: HastNode[]): HastNode {
  return el("table", [el("tbody", rows)]);
}

const SERIALIZED_ATTRS = ["id", "href", "className", DEF_TOKEN_ATTR];

function attrsOf(properties: Record<string, unknown> = {}): string {
  return SERIALIZED_ATTRS.filter((key) => properties[key] !== undefined)
    .map((key) => {
      const raw = properties[key];
      const value = Array.isArray(raw) ? raw.join(" ") : String(raw);
      return ` ${key === "className" ? "class" : key}="${value}"`;
    })
    .join("");
}

function html(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  const inner = (node.children ?? []).map(html).join("");
  if (node.type !== "element") return inner;
  return `<${node.tagName}${attrsOf(node.properties)}>${inner}</${node.tagName}>`;
}

function tokenAnchors(node: HastNode): HastNode[] {
  const found: HastNode[] = [];
  const walk = (current: HastNode) => {
    if (current.properties?.[DEF_TOKEN_ATTR] !== undefined) found.push(current);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return found;
}

function anchorHtml(token: string, targetId: string): string {
  return `<a href="#${targetId}" class="${DEF_TOKEN_CLASS}" ${DEF_TOKEN_ATTR}="${token}">${token}</a>`;
}

describe("definitions", () => {
  test("a first-cell strong that is exactly a token is a definition and gets the def id", () => {
    const tree = doc([
      table([definitionRow("E1", "netty-codec-http, -http2")]),
      el("p", [txt("escalate via E1 today")]),
    ]);
    expect(applyDefTokens(tree).get("E1")).toBe("def-e1");
    expect(html(tree)).toContain('<strong id="def-e1">E1</strong>');
    expect(tokenAnchors(tree).map(html)).toEqual([anchorHtml("E1", "def-e1")]);
  });

  test("a header-cell definition works the same way as a body-cell one", () => {
    const header = el("tr", [el("th", [strong("T1")]), el("th", [txt("Toolkit")])]);
    const tree = doc([el("table", [el("thead", [header])])]);
    expect(applyDefTokens(tree).get("T1")).toBe("def-t1");
  });

  test("whitespace text nodes between cells do not hide the first-cell definition", () => {
    const row = el("tr", [
      txt("\n  "),
      el("td", [txt("\n"), strong("E1")]),
      txt("\n  "),
      el("td", [txt("netty")]),
    ]);
    expect(applyDefTokens(doc([table([row])])).get("E1")).toBe("def-e1");
  });

  test("a strong that is not the first element child of the first cell is not a definition", () => {
    const row = el("tr", [el("td", [el("em", [txt("note")]), strong("E1")]), el("td", [txt("x")])]);
    const tree = doc([table([row]), el("p", [txt("see E1")])]);
    expect(applyDefTokens(tree).size).toBe(0);
    expect(tokenAnchors(tree)).toHaveLength(0);
  });

  test("a raw-HTML <b> defines a token exactly as <strong> does", () => {
    const row = el("tr", [el("td", [el("b", [txt("E1")])]), el("td", [txt("netty")])]);
    const tree = doc([table([row]), el("p", [txt("escalate via E1 today")])]);
    expect(applyDefTokens(tree).get("E1")).toBe("def-e1");
    expect(html(tree)).toContain('<b id="def-e1">E1</b>');
    expect(tokenAnchors(tree).map(html)).toEqual([anchorHtml("E1", "def-e1")]);
  });

  test.each(["h1", "h2", "h3", "h4", "h5", "h6"])("%s defines a token", (tag) => {
    const tree = doc([el(tag, [txt("T1 — Toolkit")]), el("p", [txt("ship per T1")])]);
    expect(applyDefTokens(tree).get("T1")).toBe("def-t1");
    expect(html(tree)).toContain(`<${tag} id="def-t1">`);
    expect(tokenAnchors(tree).map(html)).toEqual([anchorHtml("T1", "def-t1")]);
  });

  test("a heading definition maps the token to the heading's existing slug id", () => {
    const slug = "t1-toolkit-ship-netty-4-1-136-final";
    const tree = doc([
      el("h2", [txt("T1 — Toolkit: ship netty >= 4.1.136.Final")], { id: slug }),
      el("p", [txt("upgrade per T1 before the cutoff")]),
    ]);
    expect(applyDefTokens(tree).get("T1")).toBe(slug);
    expect(html(tree)).toContain(`<h2 id="${slug}">`);
    expect(tokenAnchors(tree).map(html)).toEqual([anchorHtml("T1", slug)]);
  });

  test("a heading definition with no slug id falls back to a generated def id", () => {
    const tree = doc([el("h3", [txt("E4: rate limits")]), el("p", [txt("see E4")])]);
    expect(applyDefTokens(tree).get("E4")).toBe("def-e4");
    expect(html(tree)).toContain('<h3 id="def-e4">');
  });

  test.each(["h1", "h2", "h3", "h4", "h5", "h6"])("%s defines a token", (tagName) => {
    const tree = doc([
      el(tagName, [txt("E4 — rate limits")], { id: "rate-limits" }),
      el("p", [txt("see E4")]),
    ]);
    expect(applyDefTokens(tree).get("E4")).toBe("rate-limits");
    expect(tokenAnchors(tree).map(html)).toEqual([anchorHtml("E4", "rate-limits")]);
  });

  test("a non-heading element with heading-shaped text defines nothing", () => {
    const tree = doc([el("p", [txt("E4 — rate limits")]), el("p", [txt("see E4")])]);
    expect(applyDefTokens(tree).size).toBe(0);
    expect(tokenAnchors(tree)).toEqual([]);
  });

  test("findDefinitions reports both the anchor targets and the definition sites", () => {
    const pass = findDefinitions(doc([table([definitionRow("E1", "netty")])]));
    expect([...pass.targets]).toEqual([["E1", "def-e1"]]);
    expect(pass.sites.size).toBe(1);
  });
});

describe("occurrences", () => {
  test("the Escalated status row is no definition, but the E1-E6 in its prose are occurrences", () => {
    const statusRow = cells(
      [strong("Escalated"), txt(" - needs an upstream owner (E1-E6)")],
      [strong("6")],
    );
    const tree = doc([
      table([definitionRow("E1", "netty-codec-http"), definitionRow("E6", "spring-web")]),
      table([statusRow]),
    ]);
    expect([...applyDefTokens(tree).keys()]).toEqual(["E1", "E6"]);
    expect(html(statusRow)).toBe(
      `<tr><td><strong>Escalated</strong> - needs an upstream owner (${anchorHtml("E1", "def-e1")}-${anchorHtml("E6", "def-e6")})</td><td><strong>6</strong></td></tr>`,
    );
  });

  test("a token in a non-first cell is an occurrence, not a definition", () => {
    const register = cells(
      [txt("DEV-1")],
      [txt("netty")],
      [txt("open")],
      [txt("owner")],
      [strong("E1")],
    );
    const tree = doc([table([definitionRow("E1", "netty-codec-http")]), table([register])]);
    applyDefTokens(tree);
    expect(html(register)).toContain(`<strong>${anchorHtml("E1", "def-e1")}</strong>`);
    expect(html(register)).not.toContain("id=");
  });

  test("a token that is not defined in the document stays plain text", () => {
    const prose = el("p", [txt("a stray P1 and E9 and ABCD1 stay inert while E1 links")]);
    const tree = doc([table([definitionRow("E1", "netty")]), prose]);
    applyDefTokens(tree);
    expect(tokenAnchors(tree).map((anchor) => anchor.properties?.[DEF_TOKEN_ATTR])).toEqual(["E1"]);
    expect(html(prose)).toBe(
      `<p>a stray P1 and E9 and ABCD1 stay inert while ${anchorHtml("E1", "def-e1")} links</p>`,
    );
  });

  test("occurrences inside a link, inline code and a pre block are left alone", () => {
    const existing = el("a", [txt("E1")], { href: "http://x.example" });
    const inline = el("code", [txt("E1")]);
    const fenced = el("pre", [el("code", [txt("grep E1")])]);
    const tree = doc([table([definitionRow("E1", "netty")]), el("p", [existing, inline]), fenced]);
    applyDefTokens(tree);
    expect(tokenAnchors(tree)).toHaveLength(0);
    expect(html(existing)).toBe('<a href="http://x.example">E1</a>');
    expect(html(inline)).toBe("<code>E1</code>");
    expect(html(fenced)).toBe("<pre><code>grep E1</code></pre>");
  });

  test("the definition occurrence is not linkified, but a repeat in the same heading is", () => {
    const heading = el("h2", [txt("T1 — see T1 again")], { id: "t1-see-t1-again" });
    applyDefTokens(doc([heading]));
    expect(html(heading)).toBe(
      `<h2 id="t1-see-t1-again">T1 — see ${anchorHtml("T1", "t1-see-t1-again")} again</h2>`,
    );
  });
});

describe("boundary cases", () => {
  test("an empty document is a no-op", () => {
    const tree = doc([]);
    expect(applyDefTokens(tree).size).toBe(0);
    expect(html(tree)).toBe("");
  });

  test("a definition with no other occurrence gets its target and produces no links", () => {
    const tree = doc([table([definitionRow("E1", "netty")])]);
    expect(applyDefTokens(tree).get("E1")).toBe("def-e1");
    expect(tokenAnchors(tree)).toHaveLength(0);
    expect(html(tree)).toContain('<strong id="def-e1">E1</strong>');
  });

  test("a heading whose leading run breaks the grammar defines nothing", () => {
    const tree = doc([el("h2", [txt("ABCD1 A1234 e1 rollout")], { id: "rollout" })]);
    expect(applyDefTokens(tree).size).toBe(0);
  });

  test("when a token is defined twice the first definition wins", () => {
    const secondRow = definitionRow("T1", "duplicate");
    const tree = doc([el("h2", [txt("T1 — first")], { id: "t1-first" }), table([secondRow])]);
    expect(applyDefTokens(tree).get("T1")).toBe("t1-first");
    expect(html(secondRow)).toContain(`<strong>${anchorHtml("T1", "t1-first")}</strong>`);
    expect(html(secondRow)).not.toContain("id=");
  });

  test("document order decides which of a row and a heading definition wins", () => {
    const heading = el("h2", [txt("T1 — later")], { id: "t1-later" });
    const tree = doc([table([definitionRow("T1", "first")]), heading]);
    expect(applyDefTokens(tree).get("T1")).toBe("def-t1");
    expect(html(heading)).toBe(`<h2 id="t1-later">${anchorHtml("T1", "def-t1")} — later</h2>`);
  });

  test("a generated id never collides with an id already in the document", () => {
    const tree = doc([
      el("div", [txt("raw")], { id: "def-e1" }),
      table([definitionRow("E1", "netty")]),
      el("p", [txt("see E1")]),
    ]);
    expect(applyDefTokens(tree).get("E1")).toBe("def-e1-2");
    expect(html(tree)).toContain('<strong id="def-e1-2">E1</strong>');
    expect(tokenAnchors(tree).map(html)).toEqual([anchorHtml("E1", "def-e1-2")]);
  });

  test("running the plugin twice does not double-wrap or re-id anything", () => {
    const build = () =>
      doc([
        el("h2", [txt("T1 — Toolkit")], { id: "t1-toolkit" }),
        table([definitionRow("E1", "netty")]),
        el("p", [txt("E1 escalates, T1 ships")]),
      ]);
    const once = build();
    applyDefTokens(once);
    const twice = build();
    applyDefTokens(twice);
    applyDefTokens(twice);
    expect(html(twice)).toBe(html(once));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(tokenAnchors(twice)).toHaveLength(2);
  });

  test("the exported plugin is a plain unified transform over the same logic", () => {
    const viaPlugin = doc([table([definitionRow("E1", "netty")]), el("p", [txt("see E1")])]);
    const viaFunction = doc([table([definitionRow("E1", "netty")]), el("p", [txt("see E1")])]);
    rehypeDefTokens()(viaPlugin);
    applyDefTokens(viaFunction);
    expect(html(viaPlugin)).toBe(html(viaFunction));
    expect(tokenAnchors(viaPlugin)).toHaveLength(1);
  });
});

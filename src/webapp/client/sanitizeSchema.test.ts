import { test, expect } from "vitest";
import { SANITIZE_SCHEMA, isSafeDataImage } from "./sanitizeSchema";

const tags = new Set(SANITIZE_SCHEMA.tagNames ?? []);
const starAttributes = new Set(
  (SANITIZE_SCHEMA.attributes?.["*"] ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  ),
);

test("structural and semantic html tags are allowed", () => {
  for (const tag of ["div", "span", "section", "figure", "details", "table", "style", "video"]) {
    expect(tags.has(tag)).toBe(true);
  }
});

test("the svg element and its drawing primitives are allowed", () => {
  for (const tag of [
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "text",
    "defs",
    "marker",
    "linearGradient",
    "clipPath",
    "foreignObject",
    "feGaussianBlur",
  ]) {
    expect(tags.has(tag)).toBe(true);
  }
});

test("code-execution tags stay blocked and are stripped rather than unwrapped", () => {
  const stripped = new Set(SANITIZE_SCHEMA.strip ?? []);
  for (const tag of ["script", "iframe", "object", "embed", "base", "link", "meta"]) {
    expect(tags.has(tag)).toBe(false);
    expect(stripped.has(tag)).toBe(true);
  }
});

test("smil animation elements are blocked, since they can retarget an href", () => {
  for (const tag of ["animate", "animateTransform", "animateMotion", "set", "discard"]) {
    expect(tags.has(tag)).toBe(false);
  }
});

test("svg presentation attributes are allowed under their hast property names", () => {
  for (const property of [
    "viewBox",
    "strokeWidth",
    "strokeLineCap",
    "strokeLineJoin",
    "strokeDashArray",
    "fillOpacity",
    "textAnchor",
    "fontSize",
    "markerEnd",
    "clipPath",
    "transform",
  ]) {
    expect(starAttributes.has(property)).toBe(true);
  }
});

test("the hyphenated spelling is absent, because sanitize matches property names", () => {
  for (const attribute of ["stroke-width", "stroke-linecap", "fill-opacity", "text-anchor"]) {
    expect(starAttributes.has(attribute)).toBe(false);
  }
});

test("class, style and the diagram opt-in attribute survive sanitizing", () => {
  expect(starAttributes.has("className")).toBe(true);
  expect(starAttributes.has("style")).toBe(true);
  expect(starAttributes.has("dataDiagram")).toBe(true);
});

test("no event handler attribute is allowed", () => {
  const handlers = [...starAttributes].filter((name) => /^on[A-Z]/.test(name));
  expect(handlers).toEqual([]);
});

test("attributes that can carry an unguarded url are dropped", () => {
  for (const property of ["xLinkHref", "action", "formAction", "background", "srcSet", "ping"]) {
    expect(starAttributes.has(property)).toBe(false);
  }
});

test("data urls are permitted for src but never for href", () => {
  expect(SANITIZE_SCHEMA.protocols?.src).toContain("data");
  expect(SANITIZE_SCHEMA.protocols?.href).not.toContain("data");
  expect(SANITIZE_SCHEMA.protocols?.href).toContain("brain");
});

test("ids are not rewritten, so an svg url(#gradient) reference keeps resolving", () => {
  expect(SANITIZE_SCHEMA.clobberPrefix).toBe("");
});

test("only image data urls are treated as safe", () => {
  expect(isSafeDataImage("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
  expect(isSafeDataImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(true);
  expect(isSafeDataImage("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")).toBe(true);
  expect(isSafeDataImage("  data:image/webp;base64,AAA  ")).toBe(true);
  expect(isSafeDataImage("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  expect(isSafeDataImage("data:application/javascript,alert(1)")).toBe(false);
  expect(isSafeDataImage("javascript:alert(1)")).toBe(false);
  expect(isSafeDataImage("https://example.com/a.png")).toBe(false);
});

test("per-tag className restrictions are lifted, so author classes are not silently dropped", () => {
  const attributes = SANITIZE_SCHEMA.attributes ?? {};
  for (const tag of ["a", "code", "h2", "li", "ol", "ul", "section"]) {
    const restricted = (attributes[tag] ?? []).filter(
      (entry) => Array.isArray(entry) && entry[0] === "className",
    );
    expect(restricted).toEqual([]);
  }
});

test("the checkbox guard on input is kept", () => {
  const input = SANITIZE_SCHEMA.attributes?.input ?? [];
  const names = input.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
  expect(names).toContain("type");
  expect(names).toContain("disabled");
});

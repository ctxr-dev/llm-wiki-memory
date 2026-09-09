import { test, expect } from "vitest";
import {
  DIAGRAM_BLOCK_ATTR,
  DIAGRAM_NATURAL_ATTR,
  markDiagramBlocks,
  parseNatural,
  svgNaturalFromProperties,
} from "./diagramBlocks";
import type { HastNode } from "./defTokens";

function element(
  tagName: string,
  properties: Record<string, unknown> = {},
  children: HastNode[] = [],
): HastNode {
  return { type: "element", tagName, properties, children };
}

function text(value: string): HastNode {
  return { type: "text", value };
}

function root(...children: HastNode[]): HastNode {
  return { type: "root", children };
}

function framed(tree: HastNode): HastNode[] {
  return (tree.children ?? []).filter(
    (child) => child.properties?.[DIAGRAM_BLOCK_ATTR] !== undefined,
  );
}

test("a block-level svg is wrapped in one marker element", () => {
  const svg = element("svg", { viewBox: "0 0 800 600" });
  const tree = root(svg);
  markDiagramBlocks(tree);
  const wrappers = framed(tree);
  expect(wrappers).toHaveLength(1);
  expect(wrappers[0].tagName).toBe("div");
  expect(wrappers[0].children?.[0]).toBe(svg);
});

test("natural size is carried on the wrapper, read from the viewBox", () => {
  const tree = root(element("svg", { viewBox: "0 0 800 600" }));
  markDiagramBlocks(tree);
  expect(framed(tree)[0].properties?.[DIAGRAM_NATURAL_ATTR]).toBe("800x600");
});

test("a paragraph holding only an image is unwrapped so the frame is not nested in a p", () => {
  const img = element("img", { src: "https://example.com/a.png" });
  const tree = root(element("p", {}, [text("\n"), img, text("  ")]));
  markDiagramBlocks(tree);
  const wrappers = framed(tree);
  expect(wrappers).toHaveLength(1);
  expect(wrappers[0].children?.[0]).toBe(img);
  expect(tree.children?.some((child) => child.tagName === "p")).toBe(false);
});

test("an image sitting inside a sentence is left inline and unframed", () => {
  const tree = root(
    element("p", {}, [text("before "), element("img", { src: "a.png" }), text(" after")]),
  );
  markDiagramBlocks(tree);
  expect(framed(tree)).toHaveLength(0);
  expect(tree.children?.[0].tagName).toBe("p");
});

test("an element opts in by class or by the data-diagram attribute", () => {
  const byClass = root(element("div", { className: ["diagram"] }));
  markDiagramBlocks(byClass);
  expect(framed(byClass)).toHaveLength(1);

  const byAttribute = root(element("figure", { dataDiagram: "" }));
  markDiagramBlocks(byAttribute);
  expect(framed(byAttribute)).toHaveLength(1);

  const byStringClass = root(element("section", { className: "note diagram wide" }));
  markDiagramBlocks(byStringClass);
  expect(framed(byStringClass)).toHaveLength(1);
});

test("an unmarked container is left alone", () => {
  const tree = root(element("div", { className: ["note"] }, [text("hi")]));
  markDiagramBlocks(tree);
  expect(framed(tree)).toHaveLength(0);
});

test("an svg nested inside an opted-in container is not framed a second time", () => {
  const inner = element("svg", { viewBox: "0 0 10 10" });
  const tree = root(element("div", { className: ["diagram"] }, [inner]));
  markDiagramBlocks(tree);
  const wrappers = framed(tree);
  expect(wrappers).toHaveLength(1);
  expect(inner.properties?.[DIAGRAM_BLOCK_ATTR]).toBeUndefined();
});

test("a diagram nested in a details block is still framed", () => {
  const tree = root(element("details", {}, [element("svg", { viewBox: "0 0 4 2" })]));
  markDiagramBlocks(tree);
  const details = tree.children?.[0];
  expect(details?.children?.[0].properties?.[DIAGRAM_BLOCK_ATTR]).toBe("");
});

test("running the pass twice does not wrap the same diagram again", () => {
  const tree = root(element("svg", { viewBox: "0 0 10 10" }));
  markDiagramBlocks(tree);
  markDiagramBlocks(tree);
  expect(framed(tree)).toHaveLength(1);
  expect(framed(tree)[0].children?.[0].tagName).toBe("svg");
});

test("svg natural size falls back to width and height when there is no viewBox", () => {
  expect(svgNaturalFromProperties({ viewBox: "0 0 1024 768" })).toEqual({
    width: 1024,
    height: 768,
  });
  expect(svgNaturalFromProperties({ viewBox: "0,0,20,10" })).toEqual({ width: 20, height: 10 });
  expect(svgNaturalFromProperties({ width: "300", height: "150" })).toEqual({
    width: 300,
    height: 150,
  });
  expect(svgNaturalFromProperties({ viewBox: "0 0 0 0" })).toBeNull();
  expect(svgNaturalFromProperties({ viewBox: "nope" })).toBeNull();
  expect(svgNaturalFromProperties({})).toBeNull();
});

test("the natural size marker round-trips", () => {
  expect(parseNatural("800x600")).toEqual({ width: 800, height: 600 });
  expect(parseNatural("12.5x7.5")).toEqual({ width: 12.5, height: 7.5 });
  expect(parseNatural("0x0")).toBeNull();
  expect(parseNatural("wide")).toBeNull();
  expect(parseNatural(undefined)).toBeNull();
});

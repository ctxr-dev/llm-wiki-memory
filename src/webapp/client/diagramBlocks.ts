import type { HastNode } from "./defTokens";

export const DIAGRAM_BLOCK_ATTR = "data-diagram-block";
export const DIAGRAM_NATURAL_ATTR = "data-diagram-natural";
export const DIAGRAM_OPT_IN_CLASS = "diagram";
export const DIAGRAM_OPT_IN_PROPERTY = "dataDiagram";

const FRAMED_TAGS = new Set(["svg", "img"]);

const TEXT_LEVEL_TAGS = new Set([
  "p",
  "a",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "q",
  "code",
  "span",
  "sub",
  "sup",
  "small",
  "del",
  "ins",
  "mark",
  "abbr",
  "cite",
  "kbd",
  "samp",
  "var",
  "time",
  "bdi",
  "bdo",
  "dfn",
  "caption",
  "figcaption",
  "summary",
  "dt",
  "label",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

export type Size = { width: number; height: number };

function classList(node: HastNode): string[] {
  const value = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/);
  return [];
}

function hasOptIn(node: HastNode): boolean {
  if (classList(node).includes(DIAGRAM_OPT_IN_CLASS)) return true;
  const flag = node.properties?.[DIAGRAM_OPT_IN_PROPERTY];
  return flag !== undefined && flag !== false;
}

export function isDiagramCandidate(node: HastNode): boolean {
  if (node.type !== "element") return false;
  return FRAMED_TAGS.has(node.tagName ?? "") || hasOptIn(node);
}

function isBlank(node: HastNode): boolean {
  return node.type === "text" && (node.value ?? "").trim().length === 0;
}

function meaningfulChildren(node: HastNode): HastNode[] {
  return (node.children ?? []).filter((child) => !isBlank(child));
}

function soleWrappedCandidate(node: HastNode): HastNode | null {
  if (node.tagName !== "p") return null;
  const kids = meaningfulChildren(node);
  if (kids.length !== 1) return null;
  return isDiagramCandidate(kids[0]) ? kids[0] : null;
}

function promote(node: HastNode): HastNode | null {
  if (node.type !== "element") return null;
  if (isDiagramCandidate(node)) return node;
  return soleWrappedCandidate(node);
}

function firstNumber(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function svgNaturalFromProperties(
  properties: Record<string, unknown> | undefined,
): Size | null {
  const viewBox = properties?.viewBox;
  if (typeof viewBox === "string") {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const [, , width, height] = parts;
      if (width > 0 && height > 0) return { width, height };
    }
  }
  const width = firstNumber(properties?.width);
  const height = firstNumber(properties?.height);
  return width && height ? { width, height } : null;
}

function naturalOf(node: HastNode): Size | null {
  if (node.tagName === "svg") return svgNaturalFromProperties(node.properties);
  const width = firstNumber(node.properties?.width);
  const height = firstNumber(node.properties?.height);
  return width && height ? { width, height } : null;
}

export function isDiagramBlockNode(
  node: { properties?: Record<string, unknown> } | undefined,
): boolean {
  return node?.properties?.[DIAGRAM_BLOCK_ATTR] !== undefined;
}

export function parseNatural(value: unknown): Size | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function wrap(node: HastNode): HastNode {
  const natural = naturalOf(node);
  const properties: Record<string, unknown> = { [DIAGRAM_BLOCK_ATTR]: "" };
  if (natural) properties[DIAGRAM_NATURAL_ATTR] = `${natural.width}x${natural.height}`;
  return { type: "element", tagName: "div", properties, children: [node] };
}

export function markDiagramBlocks(tree: HastNode): void {
  if (!Array.isArray(tree.children)) return;
  if (TEXT_LEVEL_TAGS.has(tree.tagName ?? "")) return;
  const next: HastNode[] = [];
  for (const child of tree.children) {
    if (isDiagramBlockNode(child)) {
      next.push(child);
      continue;
    }
    const framed = promote(child);
    if (framed) {
      next.push(wrap(framed));
      continue;
    }
    markDiagramBlocks(child);
    next.push(child);
  }
  tree.children = next;
}

export function rehypeDiagramBlocks() {
  return function transformDiagramBlocks(tree: unknown): void {
    markDiagramBlocks(tree as HastNode);
  };
}

import {
  defAnchorId,
  defTokenAnchor,
  findDefTokenMatches,
  headingDefToken,
  isDefToken,
  uniqueAnchorId,
} from "./defTokens";
import type { HastNode } from "./defTokens";

const OPAQUE_TAGS = new Set(["a", "code", "pre", "script", "style"]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const CELL_TAGS = new Set(["td", "th"]);
const EMPHASIS_TAGS = new Set(["strong", "b"]);

type DefinitionSite = { element: HastNode; token: string };

export type DefTokenPass = {
  targets: Map<string, string>;
  sites: Map<HastNode, string>;
};

type SkipOnce = { token: string | null };

function elementChildren(node: HastNode): HastNode[] {
  return (node.children ?? []).filter((child) => child.type === "element");
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function idOf(node: HastNode): string | null {
  const id = node.properties?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function collectIds(node: HastNode, into: Set<string>): void {
  const id = idOf(node);
  if (id) into.add(id);
  for (const child of node.children ?? []) collectIds(child, into);
}

function rowDefinition(row: HastNode): DefinitionSite | null {
  const cell = elementChildren(row).find((child) => CELL_TAGS.has(child.tagName ?? ""));
  if (!cell) return null;
  const [leading] = elementChildren(cell);
  if (!leading || !EMPHASIS_TAGS.has(leading.tagName ?? "")) return null;
  const token = textOf(leading).trim();
  return isDefToken(token) ? { element: leading, token } : null;
}

function headingDefinition(heading: HastNode): DefinitionSite | null {
  const token = headingDefToken(textOf(heading));
  return token ? { element: heading, token } : null;
}

function definitionAt(element: HastNode): DefinitionSite | null {
  const tag = element.tagName ?? "";
  if (HEADING_TAGS.has(tag)) return headingDefinition(element);
  if (tag === "tr") return rowDefinition(element);
  return null;
}

function visitElements(node: HastNode, visit: (element: HastNode) => void): void {
  if (node.type === "element") visit(node);
  for (const child of node.children ?? []) visitElements(child, visit);
}

function assignId(element: HastNode, token: string, taken: Set<string>): string {
  const existing = idOf(element);
  if (existing) return existing;
  const id = uniqueAnchorId(defAnchorId(token), taken);
  element.properties = { ...(element.properties ?? {}), id };
  taken.add(id);
  return id;
}

export function findDefinitions(tree: HastNode): DefTokenPass {
  const taken = new Set<string>();
  collectIds(tree, taken);
  const targets = new Map<string, string>();
  const sites = new Map<HastNode, string>();
  visitElements(tree, (element) => {
    const definition = definitionAt(element);
    if (!definition || targets.has(definition.token)) return;
    targets.set(definition.token, assignId(definition.element, definition.token, taken));
    sites.set(definition.element, definition.token);
  });
  return { targets, sites };
}

function linkifyValue(
  value: string,
  targets: Map<string, string>,
  skip: SkipOnce,
): HastNode[] | null {
  const parts: HastNode[] = [];
  let last = 0;
  for (const match of findDefTokenMatches(value)) {
    const targetId = targets.get(match.token);
    if (!targetId) continue;
    if (skip.token === match.token) {
      skip.token = null;
      continue;
    }
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
    parts.push(defTokenAnchor(match.token, targetId));
    last = match.index + match.token.length;
  }
  if (parts.length === 0) return null;
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

function linkifyNode(node: HastNode, pass: DefTokenPass, skip: SkipOnce): void {
  if (!Array.isArray(node.children)) return;
  if (node.type === "element" && OPAQUE_TAGS.has(node.tagName ?? "")) return;
  const siteToken = pass.sites.get(node);
  const scope: SkipOnce = siteToken ? { token: siteToken } : skip;
  const next: HastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replaced = linkifyValue(child.value, pass.targets, scope);
      if (replaced) {
        next.push(...replaced);
        continue;
      }
    } else {
      linkifyNode(child, pass, scope);
    }
    next.push(child);
  }
  node.children = next;
}

export function applyDefTokens(tree: HastNode): Map<string, string> {
  const pass = findDefinitions(tree);
  if (pass.targets.size > 0) linkifyNode(tree, pass, { token: null });
  return pass.targets;
}

export function rehypeDefTokens() {
  return function transformDefTokens(tree: unknown): void {
    applyDefTokens(tree as HastNode);
  };
}

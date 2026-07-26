import type { Wiki } from "./api";

const BRAIN = "brain";

export function wikiToSource(wiki: Wiki): string {
  return wiki.kind === "home" ? BRAIN : wiki.projectModule;
}

export function formatRef(wiki: Wiki, docId: string): string {
  return `${wikiToSource(wiki)}:${docId}`;
}

export type ParsedRef = { source: string; path: string };

export function parseRef(text: string): ParsedRef | null {
  const match = /^([^:]+):(.+)$/.exec(text.trim());
  return match ? { source: match[1], path: match[2] } : null;
}

export type ResolvedRef = { wikiId: string; docId: string };

export function resolveRef(wikis: Wiki[], text: string): ResolvedRef | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  let best: { wiki: Wiki; sourceLength: number } | null = null;
  for (const wiki of wikis) {
    const source = wikiToSource(wiki).toLowerCase();
    if (!lower.startsWith(`${source}:`)) continue;
    if (!best || source.length > best.sourceLength) best = { wiki, sourceLength: source.length };
  }
  if (!best) return null;
  const docId = trimmed.slice(best.sourceLength + 1).trim();
  return docId ? { wikiId: best.wiki.id, docId } : null;
}

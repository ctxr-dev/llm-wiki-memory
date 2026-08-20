export type Crumb = { label: string; category: string; path: string };

const SENTINELS = new Set(["unscoped", "unknown", "untyped", "general", "misc"]);

function prettify(slug: string): string {
  return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function docCrumbs(docId: string): Crumb[] {
  const parts = docId.split("/").slice(0, -1);
  if (parts.length === 0) return [];
  const category = parts[0];
  const crumbs: Crumb[] = [{ label: prettify(category), category, path: "" }];
  const facets = parts.slice(1);
  facets.forEach((segment, index) => {
    if (SENTINELS.has(segment.toLowerCase())) return;
    crumbs.push({ label: prettify(segment), category, path: facets.slice(0, index + 1).join("/") });
  });
  return crumbs;
}

export function crumbLabel(category: string, path: string): string {
  const segments = [category, ...(path ? path.split("/") : [])];
  return segments
    .filter(
      (segment, index) =>
        index === 0 || (!SENTINELS.has(segment.toLowerCase()) && !/^\d+$/.test(segment)),
    )
    .map(prettify)
    .join(" › ");
}

export function locationLabel(docId: string): string {
  const parts = docId.split("/").slice(0, -1);
  if (parts.length === 0) return "";
  return parts
    .filter(
      (segment, index) =>
        index === 0 || (!SENTINELS.has(segment.toLowerCase()) && !/^\d+$/.test(segment)),
    )
    .map(prettify)
    .join(" › ");
}

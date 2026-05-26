// tracker-issues / from_path.mjs
//
// Reverse path parsers for the tracker-issues topology. One named export per
// `file_kind`; returns the facets that produced the path, or null if the
// path doesn't match this kind's shape. Pure — no IO.
//
// Signature:
//   knowledge(relPath: string) -> facets | null
//   plan(relPath: string) -> facets | null

const RE_KNOWLEDGE =
  /^issues\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/[^/]+-(\d+)\.md$/;

const RE_PLAN =
  /^issues\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/([^/]+)\/[^/]+-(\d+)-(.+)\.plan\.md$/;

export function knowledge(relPath) {
  const m = RE_KNOWLEDGE.exec(relPath);
  if (!m) return null;
  return {
    tracker: m[1],
    prefix: m[2],
    number: Number(m[6]),
  };
}

export function plan(relPath) {
  const m = RE_PLAN.exec(relPath);
  if (!m) return null;
  return {
    tracker: m[1],
    prefix: m[2],
    lifecycle: m[6],
    number: Number(m[7]),
    slug: m[8],
  };
}

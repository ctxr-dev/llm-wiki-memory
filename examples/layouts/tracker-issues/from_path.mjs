// tracker-issues / from_path.mjs
//
// Reverse path parsers for the tracker-issues topology. One named export per
// `file_kind`; returns the facets that produced the path, or null if the
// path doesn't match this kind's shape. Pure — no IO.
//
// IMPORTANT: tracker, prefix, and number come from the DIRECTORY segments
// (which are unambiguous: thousands/hundreds_tens/units), NOT from the
// filename. The filename may legitimately contain extra digits (e.g.
// `DEV-122648-mirror-apisix-1-and-2.plan.md`) and a regex that pulls
// `(\d+)` from the filename will greedily pick the wrong digit. The
// directory path is authoritative for tracker / prefix / number; the
// filename only contributes the slug.
//
// We then sanity-check that the filename's leading `<prefix>-<number>`
// matches what the directories said. If it doesn't, the file is
// off-topology and we return null rather than producing garbage facets.
//
// Signature:
//   knowledge(relPath: string) -> facets | null
//   plan(relPath: string) -> facets | null

const RE_KNOWLEDGE =
  /^issues\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/(.+)\.md$/;

const RE_PLAN =
  /^issues\/([^/]+)\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/([^/]+)\/(.+)\.plan\.md$/;

function reconstructNumber(thousands, hundredsTens, units) {
  return Number(thousands) * 1000 + Number(hundredsTens) * 10 + Number(units);
}

export function knowledge(relPath) {
  const m = RE_KNOWLEDGE.exec(relPath);
  if (!m) return null;
  const tracker = m[1];
  const prefix = m[2];
  const number = reconstructNumber(m[3], m[4], m[5]);
  // Filename stem must be "<prefix>-<number>"; otherwise the file is
  // off-topology (a different naming or category).
  if (m[6] !== `${prefix}-${number}`) return null;
  return { tracker, prefix, number };
}

export function plan(relPath) {
  const m = RE_PLAN.exec(relPath);
  if (!m) return null;
  const tracker = m[1];
  const prefix = m[2];
  const number = reconstructNumber(m[3], m[4], m[5]);
  const lifecycle = m[6];
  const stem = m[7]; // "<prefix>-<number>-<slug>"
  const expectedHead = `${prefix}-${number}-`;
  if (!stem.startsWith(expectedHead)) return null;
  const slug = stem.slice(expectedHead.length);
  return { tracker, prefix, number, lifecycle, slug };
}

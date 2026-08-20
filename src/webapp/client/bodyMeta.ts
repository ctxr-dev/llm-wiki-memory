export type BodyMeta = { heading: string | null; metaList: string[]; prose: string };

const META_LINE = /^[-*]\s*\w[\w-]*\s*:/;
const HEADING = /^#\s+\S/;

export function splitBodyMeta(body: string): BodyMeta {
  const lines = body.split("\n");
  let cursor = 0;
  while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
  if (cursor >= lines.length || !HEADING.test(lines[cursor])) {
    return { heading: null, metaList: [], prose: body };
  }
  const heading = lines[cursor];
  let scan = cursor + 1;
  while (scan < lines.length && lines[scan].trim() === "") scan += 1;
  const metaList: string[] = [];
  while (scan < lines.length && META_LINE.test(lines[scan])) {
    metaList.push(lines[scan]);
    scan += 1;
  }
  if (metaList.length === 0) return { heading: null, metaList: [], prose: body };
  const prose = lines.slice(scan).join("\n").replace(/^\n+/, "");
  return { heading, metaList, prose };
}

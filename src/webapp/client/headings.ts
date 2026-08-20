import GithubSlugger from "github-slugger";

export interface TocItem {
  depth: number;
  text: string;
  slug: string;
}

export function slugify(text: string): string {
  return new GithubSlugger().slug(text);
}

export function extractToc(markdown: string): TocItem[] {
  const slugger = new GithubSlugger();
  const items: TocItem[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (match) {
      items.push({ depth: match[1].length, text: match[2], slug: slugger.slug(match[2]) });
    }
  }
  return items;
}

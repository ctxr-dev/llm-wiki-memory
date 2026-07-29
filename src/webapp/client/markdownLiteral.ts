import { roundTripMarkdown } from "./losslessGuard";

/**
 * Letters only: Lexical's code transformer terminates the info string at a hyphen,
 * so "lwm-literal" round-trips as "lwm" with "-literal" spilling into the body.
 */
export const LITERAL_LANG = "lwmliteral";

/** Blank lines separate blocks — never inside a fence, which would halve it. */
export function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    while (current.length && current[current.length - 1].trim() === "") current.pop();
    if (current.length) blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of lines) {
    /** CommonMark caps a fence at 3 spaces of indent; at 4+ the backticks are
     * literal text inside indented code, and splitting there corrupts content. */
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      current.push(line);
      if (fenceMatch && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      if (!current.length || current[current.length - 1].trim() !== "") {
        if (current.length) flush();
      }
      fence = fenceMatch[1];
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  if (fence) blocks.push(current.join("\n"));
  else flush();
  return blocks;
}

/**
 * Lexical recognises ONLY a 3-backtick fence, so a longer outer fence cannot
 * contain inner fences — the extra backticks leak into the body. Every backtick run
 * inside a literal block is therefore encoded reversibly; the escape marker is
 * itself escaped first, so any input round-trips.
 */
const ESC_OPEN = "⟪";
const ESC_CLOSE = "⟫";

export function escapeFences(content: string): string {
  return content
    .replace(new RegExp(ESC_OPEN, "g"), `${ESC_OPEN}E${ESC_CLOSE}`)
    .replace(/^([ \t]*)(`{3,})/gm, (_m, ws, ticks) => `${ws}${ESC_OPEN}F${ticks.length}${ESC_CLOSE}`);
}

export function unescapeFences(content: string): string {
  return content
    .replace(new RegExp(`${ESC_OPEN}F(\\d+)${ESC_CLOSE}`, "g"), (_m, n) => "`".repeat(Number(n)))
    .replace(new RegExp(`${ESC_OPEN}E${ESC_CLOSE}`, "g"), ESC_OPEN);
}

export function wrapLiteral(block: string): string {
  return "```" + LITERAL_LANG + "\n" + escapeFences(block) + "\n```";
}

/**
 * Content identical once blank-line runs collapse: a WYSIWYG may reflow spacing
 * between blocks, but it must never drop or alter a line.
 */
export function denseEqual(a: string, b: string): boolean {
  const dense = (t: string) =>
    t
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "")
      .join("\n");
  return dense(a) === dense(b);
}

function blockSurvives(block: string): boolean {
  try {
    return denseEqual(roundTripMarkdown(block), block);
  } catch {
    return false;
  }
}

/**
 * A document may legitimately contain our own literal opener (documentation about
 * this encoding does). Such a block MUST be wrapped: wrapping escapes its backticks,
 * whereas left bare deliteralize would mistake it for a delimiter.
 */
function containsOwnMarker(text: string): boolean {
  return new RegExp(`^\\s*\`{3,}${LITERAL_LANG}\\s*$`, "m").test(text);
}

/**
 * Rewrite `markdown` so Lexical can carry it without loss: any block the editor
 * cannot round-trip becomes a fenced literal block, which it round-trips exactly.
 * Construct-agnostic on purpose — it asks the editor what it can handle instead of
 * hardcoding a list of markdown features, so a future construct needs no change here.
 */
export function literalize(markdown: string): string {
  /** Untouched fast path: a document the editor already handles must not be
   * reflowed by our own split-and-rejoin. */
  if (!containsOwnMarker(markdown) && blockSurvives(markdown)) return markdown;

  const perBlock = splitBlocks(markdown)
    .map((block) =>
      !containsOwnMarker(block) && blockSurvives(block) ? block : wrapLiteral(block),
    )
    .join("\n\n");
  if (carries(perBlock, markdown)) return perBlock;

  /** A block can survive alone yet shift once the editor parses the whole document
   * (block boundaries are its call, not ours), so escalate instead of modelling it. */
  const allBlocks = splitBlocks(markdown).map(wrapLiteral).join("\n\n");
  if (carries(allBlocks, markdown)) return allBlocks;
  return wrapLiteral(markdown);
}

/** Does `encoded` survive the editor and decode back to `original`? */
function carries(encoded: string, original: string): boolean {
  try {
    return denseEqual(deliteralize(roundTripMarkdown(encoded)), original);
  } catch {
    return false;
  }
}

/** Inverse of `literalize`: unwrap every literal fence back to its raw block. */
export function deliteralize(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inLiteral = false;
  for (const line of lines) {
    if (!inLiteral) {
      if (new RegExp(`^\\s*\`{3,}${LITERAL_LANG}\\s*$`).test(line)) {
        inLiteral = true;
        continue;
      }
      out.push(line);
      continue;
    }
    if (/^\s*`{3,}\s*$/.test(line)) {
      inLiteral = false;
      continue;
    }
    out.push(unescapeFences(line));
  }
  return out.join("\n");
}

/**
 * Whether the editor can carry `markdown` and give it back with every line intact.
 * True for anything `literalize` can encode — which is the point: the rich editor
 * no longer has to be refused.
 */
export function isEditableLossless(markdown: string): boolean {
  try {
    return denseEqual(deliteralize(roundTripMarkdown(literalize(markdown))), markdown);
  } catch {
    return false;
  }
}

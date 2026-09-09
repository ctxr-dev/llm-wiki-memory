// Text metrics, wrapping, and output assembly. Character widths are measured for
// the font stacks in `svgStyle()`; they only need to be close enough to choose a
// wrap point, since SVG text is not reflowed after layout.

export const SANS_CH = 6.45;
export const NAME_CH = 7.25;
export const MONO_CH = 4.85;

const GRID = 4;

/** @param {number} n @returns {number} */
export const snap = (n) => Math.round(n / GRID) * GRID;

/** @param {string} s @returns {string} */
export const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Split a line into wrap-eligible pieces. Words break after `.`, `-`, `_` and
 * `/` so a long dotted identifier (a Kafka topic, a package path) wraps at a
 * boundary a reader recognises instead of mid-token or not at all. Pieces
 * shorter than 6 characters accumulate, so a break is never gratuitous.
 * @param {string} line
 * @returns {string[]} pieces, with " " marking word boundaries
 */
function pieces(line) {
  /** @type {string[]} */
  const parts = [];
  for (const word of line.split(/\s+/).filter(Boolean)) {
    let buf = "";
    for (const piece of word.split(/(?<=[.\-_/])/)) {
      buf += piece;
      if (buf.length >= 6) {
        parts.push(buf);
        buf = "";
      }
    }
    if (buf) parts.push(buf);
    parts.push(" ");
  }
  if (parts[parts.length - 1] === " ") parts.pop();
  return parts;
}

/**
 * Wrap text to `maxChars`, honouring explicit newlines.
 * @param {string} textValue
 * @param {number} maxChars
 * @returns {string[]}
 */
export function wrap(textValue, maxChars) {
  /** @type {string[]} */
  const out = [];
  for (const explicit of String(textValue).split("\n")) {
    const words = pieces(explicit);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (word === " ") {
        if (line) line += " ";
        continue;
      }
      const next = line + word;
      if (next.length > maxChars && line.trim()) {
        out.push(line.trimEnd());
        line = word;
      } else {
        line = next;
      }
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out;
}

/**
 * Join the SVG fragments into one block, refusing any output that contains a
 * blank line.
 *
 * This is the renderer's most important guard and it is NOT cosmetic. A blank
 * line TERMINATES an HTML block in CommonMark, so a diagram containing one is
 * silently truncated at that point when the leaf is rendered as markdown: the
 * rest of the SVG, and any prose after it, is dropped or escaped. The failure
 * presents as "the sanitizer ate my diagram", which sends you looking in
 * entirely the wrong place. Cheap check, expensive symptom, so it throws rather
 * than repairing the output: a blank line means a fragment was built wrong, and
 * silently joining it would hide that.
 * @param {(string | undefined)[]} parts
 * @returns {string}
 */
export function assemble(parts) {
  const out = parts.filter((part) => part && part.trim().length > 0).join("\n");
  if (/\n[ \t]*\n/.test(out)) {
    throw new Error("blank line in svg output would terminate the markdown html block");
  }
  return out;
}

// Remove marker-fenced blocks from a text file safely. The one invariant that
// matters: NEVER delete non-marker content. A well-formed START…END pair (with
// no nested START between them) is removed whole; a stray/orphan START or END
// marker LINE is removed on its own; everything else — including a user's prose
// that happens to sit between mismatched markers — is preserved verbatim. This
// converges (a second pass over the output is a no-op modulo trailing blanks),
// so callers that re-append a fresh block stay byte-stable across runs.
//
// Markers inside a BALANCED code fence (``` or ~~~ open+close pair) are IGNORED —
// our own injected block is never fenced, so this only protects a user who
// DOCUMENTS the markers in a code fence (a real risk for this project's own docs).
// An UNCLOSED trailing fence fences nothing: otherwise a stray ``` upstream would
// hide our real block and wire would append a duplicate on every run.

/**
 * CommonMark fence-line info: char (` or ~), run length (>=3), and any info string.
 * @param {string} trimmedLine @returns {{ char: string, run: number, info: string } | null}
 */
function fenceInfo(trimmedLine) {
  const m = trimmedLine.match(/^([`~])\1{2,}/);
  if (!m) return null;
  return { char: m[1], run: m[0].length, info: trimmedLine.slice(m[0].length).trim() };
}

/**
 * Lines that sit inside a balanced fenced-code region (inclusive of the fence lines),
 * per CommonMark: an opening fence is closed only by a bare fence of the SAME char,
 * a run at least as long, and no info string — so a nested/shorter/other-char fence
 * line inside is literal (this is how a doc shows a fenced example that itself contains
 * a fence). A dangling unclosed fence at EOF marks nothing (it can't hide our block).
 * @param {string[]} lines @returns {boolean[]}
 */
function fencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  /** @type {{ char: string, run: number, start: number } | null} */ let open = null;
  for (let k = 0; k < lines.length; k += 1) {
    const info = fenceInfo(lines[k].trim());
    if (!info) continue;
    if (open === null) {
      open = { char: info.char, run: info.run, start: k };
    } else if (info.char === open.char && info.run >= open.run && info.info === "") {
      for (let m = open.start; m <= k; m += 1) fenced[m] = true;
      open = null;
    }
  }
  return fenced;
}

/**
 * @param {string} content
 * @param {string} startMarker
 * @param {string} endMarker
 * @returns {string} content with every managed block + stray marker line removed
 */
export function stripManagedBlocks(content, startMarker, endMarker) {
  const lines = content.split("\n");
  const fenced = fencedLines(lines);
  /** @type {string[]} */ const out = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!fenced[i] && trimmed === startMarker) {
      let j = i + 1;
      while (j < lines.length) {
        const tj = lines[j].trim();
        if (!fenced[j] && (tj === endMarker || tj === startMarker)) break;
        j += 1;
      }
      if (j < lines.length && !fenced[j] && lines[j].trim() === endMarker) {
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (!fenced[i] && trimmed === endMarker) {
      i += 1;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join("\n");
}

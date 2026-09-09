// Reducing a diagram to its retrievable text. Dependency-free ON PURPOSE: both the
// wiki layer (building a leaf's embed text) and the pure chunker need this, and the
// chunker must not grow a transitive dependency on `env.mjs`, which captures
// MEMORY_DATA_DIR at load time.
//
// An inline SVG diagram is mostly geometry (viewBox, path coordinates, per-element
// styling), and a leaf embeds only `chunk.maxChunks` windows of its text, so markup
// left in place EVICTS the leaf's own prose from the index: one 12-diagram leaf
// measured 37,766 tokens, 27,118 of them SVG, against an 11,976-token ceiling.
//
// So drop the geometry but KEEP the labels — `<text>`/`<tspan>` content is the node
// and edge naming, which is exactly the high-signal text a reader would search for.
// `<style>` goes entirely; it is pure CSS. Measured on the same leaf: 11,146 tokens,
// under the ceiling, with all 1,459 tokens of labels retained.

// Both patterns require a real closing tag, which is what keeps an inline mention
// (a `<style>` inside backticks, prose naming `<svg>`) out of the match. Do NOT
// "simplify" either to an open-tag-only form: a knowledge leaf whose SUBJECT is
// `<style>` sanitization would then lose its own subject from the embed text.
const SVG_BLOCK = /<svg\b[\s\S]*?<\/svg>/gi;
const STYLE_BLOCK = /<style\b[\s\S]*?<\/style>/gi;
const SVG_LABEL = /<(?:text|tspan)\b[^>]*>([^<]*)<\/(?:text|tspan)>/gi;

/**
 * @param {string} body
 * @returns {string}
 */
export function stripDiagramMarkup(body) {
  const text = String(body || "");
  if (!text.includes("<svg") && !text.includes("<style")) return text;
  return text.replace(STYLE_BLOCK, "").replace(SVG_BLOCK, (block) => {
    /** @type {string[]} */
    const labels = [];
    for (const [, inner] of block.matchAll(SVG_LABEL)) {
      const label = inner.replace(/\s+/g, " ").trim();
      if (label) labels.push(label);
    }
    return labels.join(" ");
  });
}

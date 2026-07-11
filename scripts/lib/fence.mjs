// Neutralise any UNTRUSTED-content fence markers a body itself contains before
// it is wrapped in a fence. Without this, a body that includes a literal
// `<!-- END UNTRUSTED ... BODY -->` (authored by a malicious upstream, pasted
// from another fenced doc, or smuggled through a session transcript) would
// close the fence early: a downstream reader — or a recovery parser that splits
// on the marker — would treat everything after that premature END as trusted
// content OUTSIDE the fence, defeating the prompt-injection mitigation and (for
// the recovery parser) silently truncating the recovered body.
//
// We break the leading `<!--` token with a zero-width space (U+200B), which
// keeps the text human-readable but breaks the exact-string match an attacker
// or a naive splitter relies on. Covers the PLAN / MEMORY / INVESTIGATION /
// CHUNK variants in one rule. Idempotent: re-defanging an already-defanged body
// changes nothing further (the inserted ZWSP makes the marker no longer match).
// NB: built from its code point so the source stays pure ASCII — no invisible
// character is ever embedded in this file.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * @param {string} text
 * @returns {string}
 */
export function defangFenceMarkers(text) {
  return String(text).replace(
    /<!--(\s*(?:BEGIN|END)\s+UNTRUSTED\b[^>]*?-->)/gi,
    `<!${ZERO_WIDTH_SPACE}--$1`,
  );
}

export { ZERO_WIDTH_SPACE };

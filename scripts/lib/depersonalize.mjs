// Deterministic de-personalization backstop for AUTO-distilled atoms (flush/compile).
//
// The flush/compile/consolidate prompts instruct the LLM to write de-personalized,
// professional atoms (content-quality rule). This module is the always-on backstop that
// neutralizes the obvious user-attribution/quote openers that slip through — independent of
// settings.compile.qualityStrict. It is a bounded cleanup, NOT a full rewriter: it strips
// leading conversational-attribution phrases ("the user said to …", "you told me to …",
// "User: …"), leaving the substantive technical clause. Content the openers don't match is
// left untouched (the prompt + the interactive review cover the rest).

// LINE-ANCHORED (^ + m) so a mid-sentence "…the resource the user requested…" is never
// touched (only a clause that OPENS a line is an attribution opener), and VERB-GATED to
// unambiguously-conversational verbs (said / told me / asked me to / wanted me to /
// reminded me / complained). Ambiguous end-user verbs (wants / requested / prefers /
// asked-for) are deliberately excluded — in this domain "the user" is often the end
// customer, so stripping those would corrupt technical prose. Plain nouns ("the user
// interface") and imperative "you" ("you must X") never match. This is a conservative
// backstop: the distiller prompt does the real de-personalization; a miss is safe, a
// false strip is not.
const ATTRIBUTION_OPENERS = [
  /^\s*(?:the\s+)?user\s+(?:said|says|told\s+me|asked\s+me\s+to|wanted\s+me\s+to|reminded\s+me|complained)\b[:,]?\s*(?:to\s+|that\s+)?/gim,
  /^\s*you\s+(?:said|told\s+me|asked\s+me\s+to|wanted\s+me\s+to|reminded\s+me)\b[:,]?\s*(?:to\s+|that\s+)?/gim,
  /^\s*(?:the\s+)?user\s*:\s*/gim,
];

/** @param {unknown} text @returns {boolean} */
export function hasAttribution(text) {
  const s = String(text || "");
  return ATTRIBUTION_OPENERS.some((re) => {
    re.lastIndex = 0;
    const matched = re.test(s);
    re.lastIndex = 0;
    return matched;
  });
}

// RECALL-oriented detector for the one-shot bulk REMEDIATION pre-filter — NOT the
// always-on backstop. It flags mid-sentence operator-attribution and quoted operator
// speech that the (precision-oriented, line-anchored) ATTRIBUTION_OPENERS deliberately
// miss ("…here the user said 'I merged'…", "…the user pushed back, 'Why …'…"). It is
// intentionally over-inclusive: it only chooses WHICH leaves the LLM reviews, and the LLM
// makes the final rewrite/keep call — so a false positive on legitimate end-customer prose
// ("the user wants faster checkout") costs one cheap `keep`, never a corruption. Kept
// separate from hasAttribution precisely because the backstop must NOT strip these
// deterministically.
const REVIEWABLE_ATTRIBUTION = [
  /\bthe\s+user(?:'s)?\s+(?:said|says|wants?|wanted|asks?|asked|told|prefers?|requested|mentioned|complained|pushed\s+back|clarified|noted|insisted|reminded|explained|suggested|pointed\s+out)\b/i,
  /\byou\s+(?:said|told\s+me|asked\s+me|wanted\s+me\s+to|reminded\s+me)\b/i,
];

/** @param {unknown} text @returns {boolean} */
export function hasReviewableAttribution(text) {
  const s = String(text || "");
  if (hasAttribution(s)) return true;
  return REVIEWABLE_ATTRIBUTION.some((re) => re.test(s));
}

/**
 * Strip obvious attribution openers. Returns the cleaned text and whether it changed.
 * @param {unknown} text @returns {{ text: string, changed: boolean }}
 */
export function neutralizeAttribution(text) {
  const original = String(text || "");
  let out = original;
  for (const re of ATTRIBUTION_OPENERS) out = out.replace(re, "");
  if (out === original) return { text: original, changed: false };
  // Tidy the residue a removed opener leaves: collapse doubled SPACES/TABS (never
  // newlines — keep the body's line/paragraph structure) + a dangling leading
  // connective/punctuation, then re-capitalise the (now leading) clause.
  out = out
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/^\s*[:,;.-]\s*/, "")
    .trim();
  if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
  return { text: out, changed: true };
}

// Normalise a raw consolidation error into a stable, filename-safe signature
// slug. The signature is the dedupe key for escalation issue reports: the
// SAME underlying bug must map to the SAME slug across runs and entities,
// so every volatile token (ids, paths, timestamps, hashes, numbers, quoted
// strings) is stripped. Error CLASS names (EACCES, LLMOutputInvalid) are the
// bug identity and survive. The signature is used only for grouping and
// file naming — the issue report keeps the first RAW (redacted) excerpt so a
// human can disambiguate a false merge.

import { redact } from "./redact.mjs";
import { slugify } from "./slug.mjs";

const MAX_SIG_LEN = 80;

export function normalizeErrorSignature(rawError, { pass = "", kind = "" } = {}) {
  let s = redact(String(rawError?.message || rawError || "unknown-error"));
  s = s.toLowerCase().replace(/\s+/g, " ").trim();
  // Strip volatile tokens, most-specific first so partial eats can't leave
  // fragments behind (a path stripped after its .md id would split in two).
  s = s
    .replace(/[\w./-]+\.md\b/g, " id ")
    .replace(/(?:\/[\w.~-]+)+/g, " path ")
    .replace(/\d{4}-\d{2}-\d{2}t?[\d:.]*z?/g, " ts ")
    .replace(/\b[0-9a-f]{8,}\b/g, " hex ")
    .replace(/\b\d+\b/g, " n ")
    .replace(/"[^"]*"/g, " str ")
    .replace(/'[^']*'/g, " str ")
    .replace(/\s+/g, " ")
    .trim();
  const prefixed = [pass, kind, s].filter(Boolean).join(" ");
  const slug = slugify(prefixed).slice(0, MAX_SIG_LEN).replace(/-+$/, "");
  return slug || "unknown-error";
}

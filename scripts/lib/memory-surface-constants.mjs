export const MARKER_ID = "llm-wiki-memory";
export const POINTER_PREFIX = `${MARKER_ID}-`;

export const DOC_MARKER_START = `<!-- BEGIN ${MARKER_ID} -->`;
export const DOC_MARKER_END = `<!-- END ${MARKER_ID} -->`;

export const HASH_MARKER_START = `# >>> ${MARKER_ID} >>>`;
export const HASH_MARKER_END = `# <<< ${MARKER_ID} <<<`;

export const MEMORY_DOCS = ["AGENTS.md", "CLAUDE.md"];
export const RULE_SURFACES = [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"];

// The fallback line every @-pointer body carries verbatim, regardless of where the
// source install lives. It is the layout-independent signature we use to recognize
// our own pointer files (the install-path fragment is NOT reliable — a repo-dev
// checkout points elsewhere). Keep it in sync with pointerBody.
export const POINTER_FALLBACK_NOTE =
  "If your client does not resolve the @-include above, read the canonical file at:";

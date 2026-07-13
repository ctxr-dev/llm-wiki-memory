export const MARKER_ID = "llm-wiki-memory";
export const POINTER_PREFIX = `${MARKER_ID}-`;

export const DOC_MARKER_START = `<!-- BEGIN ${MARKER_ID} -->`;
export const DOC_MARKER_END = `<!-- END ${MARKER_ID} -->`;

export const HASH_MARKER_START = `# >>> ${MARKER_ID} >>>`;
export const HASH_MARKER_END = `# <<< ${MARKER_ID} <<<`;

export const MEMORY_DOCS = ["AGENTS.md", "CLAUDE.md"];
export const RULE_SURFACES = [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"];

// Shared re-entry guard for the memory hooks.
//
// A memory hook (session-start, pre-compact, post-compact, session-end) can
// spawn a child that itself runs an agent inside this project: the distiller
// (claude / codex via llm.mjs) or the compile process. That child can fire
// the SAME hooks again, which would recurse. To stop that, every
// memory-spawned child carries a guard env var, and every hook front checks
// for it and exits early.
//
// Two var names are written and checked: the neutral MEMORY_HOOK_REENTRY
// (preferred; not tied to any one agent) and the legacy CLAUDE_INVOKED_BY
// (kept so existing installs and the session-start / compile env inheritance
// keep working). The tag value is informational; the check is presence-based,
// so a distiller from ANY provider is recognised, not just claude.

export const REENTRY_VARS = ["MEMORY_HOOK_REENTRY", "CLAUDE_INVOKED_BY"];

export function isReentrant(env = process.env) {
  return REENTRY_VARS.some((name) => {
    const value = env[name];
    return typeof value === "string" && value !== "";
  });
}

/**
 * @param {string} tag
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function reentryEnv(tag, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const name of REENTRY_VARS) env[name] = tag;
  return env;
}

// Guards every agent-runnable CLI entrypoint against a `--help` (or stray-flag)
// probe. A path-taking entrypoint that reads argv[2] as a directory once
// misread `--help` as the path and created a stray `./--help/` mount + git
// hooks; these guards make a help probe print usage and exit cleanly instead,
// and stop a non-help flag from being consumed as a positional path.
//
// Help is read by an LLM on an UNKNOWN OS, so it never hardcodes a POSIX home
// path (`~/…` is meaningless on Windows). Docs are a WebFetch-able raw-GitHub
// URL, and script paths are given relative to the install's src dir (node
// accepts forward slashes on every OS) with one note saying where that dir is.

export const REPO_RAW_BASE = "https://raw.githubusercontent.com/ctxr-dev/llm-wiki-memory/main";

const INSTALL_NOTE =
  "Scripts live in your llm-wiki-memory install's src dir (macOS/Linux: ~/.llm-wiki-memory/src, " +
  "Windows: %USERPROFILE%\\.llm-wiki-memory\\src); run with node from there.";

/**
 * A raw-GitHub URL for a repo doc — readable via WebFetch on any OS, so help
 * points at the canonical doc without assuming it exists at a local path.
 * @param {string} rel a repo-relative doc path, e.g. "AI-INSTALL-PROMPT.md"
 * @returns {string}
 */
export function docsUrl(rel) {
  return `${REPO_RAW_BASE}/${rel}`;
}

/**
 * @param {string | undefined} first the first positional (process.argv[2])
 * @returns {"help" | "bad-flag" | null}
 */
export function classifyFirstArg(first) {
  if (first === "--help" || first === "-h") return "help";
  if (typeof first === "string" && first.startsWith("-")) return "bad-flag";
  return null;
}

/** @param {string} usage @returns {string} */
function line(usage) {
  return usage.endsWith("\n") ? usage : `${usage}\n`;
}

/**
 * Compose a real help block — what the command does, how to call it (a portable
 * home-relative path + a cross-OS install-location note), and WHERE to read more
 * (a raw-GitHub URL) — so `--help` (and a stray-flag error) always orient the
 * caller on any OS, never just a bare refusal.
 * @param {{ name: string, summary: string, usage: string, docs?: string }} spec
 * @returns {string}
 */
export function formatHelp({ name, summary, usage, docs }) {
  const parts = [`${name} — ${summary}`, "", `Usage: ${usage}`, "", INSTALL_NOTE];
  if (docs) parts.push("", `Docs: ${docs}`);
  return `${parts.join("\n")}\n`;
}

/**
 * Help-only guard, safe for BOTH path- and flag-taking entrypoints: if `--help`
 * or `-h` appears anywhere, print usage to stdout and exit 0. Never rejects a
 * legitimate flag (e.g. `--dry-run`), so flag-taking commands can call it too.
 * @param {string[]} args process.argv.slice(2)
 * @param {string} usage
 */
export function helpGuard(args, usage) {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(line(usage));
    process.exit(0);
  }
}

/**
 * For a PATH-taking entrypoint (argv[2] is a directory/value): after `helpGuard`,
 * reject a first arg that is any other `-…` flag rather than misreading it as a
 * path (which would mutate the filesystem at a bogus location). No-arg is left
 * alone — callers that default to CWD/$HOME still work.
 * @param {string | undefined} first process.argv[2]
 * @param {string} usage
 */
export function refuseFlagAsPath(first, usage) {
  if (classifyFirstArg(first) === "bad-flag") {
    process.stderr.write(`unknown option '${first}' (expected a path)\n${line(usage)}`);
    process.exit(2);
  }
}

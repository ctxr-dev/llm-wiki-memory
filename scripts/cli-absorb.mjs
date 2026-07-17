import { out } from "./cli-io.mjs";
import { resolveCliScopes, stripScopesArgs, withScopeContext } from "./cli-scopes.mjs";
import { getActiveWikiContext, resolveTargetLevel } from "./lib/wiki-context.mjs";
import { withWikiRoot } from "./lib/env.mjs";
import { OWNERSHIP } from "./lib/context/enums.mjs";

// `llm-wiki-memory absorb <path…>` — the filesystem/batch entry for absorb (the
// MCP tool takes one inline document). Flags are equals-form only (the space
// form silently ran defaults elsewhere in this CLI, so we fail loud on it):
//   --category=<name>   REQUIRED — the facet-placed target category
//   --match=<glob>      repeatable — file masks (default markdown)
//   --area= --subject= --atom-type=   override the inferred facets (batch-wide)
//   --target=<selector> optional — a context level to write into (default: the
//                       brain / local wiki); a shared repo level stages only
//   --dry-run           classify + show proposed placements, write nothing

/** @param {string} name @param {string[]} clean */
const has = (name, clean) => clean.includes(`--${name}`);
/** @param {string} name @param {string[]} clean */
const one = (name, clean) => {
  const prefix = `--${name}=`;
  const hit = clean.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
};
/** @param {string} name @param {string[]} clean */
const many = (name, clean) => {
  const prefix = `--${name}=`;
  return clean.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
};

/** @param {string} msg @returns {never} */
function die(msg) {
  process.stderr.write(`absorb: ${msg}\n`);
  return process.exit(2);
}

const VALUE_FLAGS = ["match", "category", "area", "subject", "atom-type", "target"];
const BOOL_FLAGS = ["dry-run"];

// Validate EVERY `--` token up front, so a mistyped flag can never be silently
// dropped (a typo'd `--dryrun` would otherwise perform real writes the user
// believed were a dry run). Rejects: the space form of a value flag, an unknown
// flag, and an empty value.
/** @param {string[]} clean */
function assertKnownFlags(clean) {
  for (const a of clean) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      const name = a.slice(2);
      if (VALUE_FLAGS.includes(name)) die(`--${name} requires the equals form (--${name}=<value>)`);
      if (!BOOL_FLAGS.includes(name)) die(`unknown flag '${a}'`);
    } else {
      const name = a.slice(2, eq);
      if (!VALUE_FLAGS.includes(name)) die(`unknown flag '--${name}='`);
      if (a.slice(eq + 1) === "") die(`--${name}= requires a non-empty value`);
    }
  }
}

/** @param {string[]} rest */
export async function handleAbsorb(rest) {
  const { absorbPaths } = await import("./lib/absorb-batch.mjs");
  const scopes = resolveCliScopes(rest);
  const clean = stripScopesArgs(rest);
  assertKnownFlags(clean);
  const paths = clean.filter((a) => !a.startsWith("--"));
  if (paths.length === 0) die("at least one <path> is required");
  const category = one("category", clean);
  if (!category) die("--category=<name> is required");
  const match = many("match", clean);
  /** @type {Record<string, unknown>} */
  const overrides = {};
  const area = one("area", clean);
  const subject = one("subject", clean);
  const atomType = one("atom-type", clean);
  if (area) overrides.area = area;
  if (subject) overrides.subject = subject;
  if (atomType) overrides.atom_type = atomType;
  const dryRun = has("dry-run", clean);
  const target = one("target", clean);

  return withScopeContext(scopes, async () => {
    const run = () => absorbPaths({ paths, match, category, overrides, dryRun });
    let level;
    let res;
    if (target) {
      const ctx = getActiveWikiContext();
      if (!ctx) die("--target given but no wiki context resolved from scopes");
      try {
        level = resolveTargetLevel(/** @type {NonNullable<typeof ctx>} */ (ctx), target);
      } catch (err) {
        die(
          `--target='${target}' names no known wiki level: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      res = await withWikiRoot(level.root, run);
    } else {
      res = await run();
    }
    out({
      matched: res.matched,
      absorbed: res.absorbed.length,
      failed: res.failed,
      dryRun: Boolean(dryRun),
      details: res.absorbed.map((a) => ({ file: a.file, id: a.id, dir: a.dir })),
    });
    if (level && level.ownership === OWNERSHIP.REPO && !dryRun && res.absorbed.length) {
      out(
        `Absorbed into a SHARED repo wiki (${level.root}) — the leaves are only staged; commit and push them in that repo to share.`,
      );
    }
    if (res.failed.length) process.exit(1);
  });
}

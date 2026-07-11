import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Thin wrapper around the `@ctxr/skill-llm-wiki` CLI. We drive the skill's
// tree-building (index-rebuild, validate, heal, rebuild) rather than
// reimplementing it. The skill owns the wiki structure; this module is the
// only place that shells out to it.

/**
 * @typedef {Object} SpawnResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {Object} SkillCli
 * @property {string} cmd
 * @property {string[]} baseArgs
 * @property {string} how
 */

/**
 * @typedef {Object} SpawnOpts
 * @property {string} [cwd]
 * @property {number} [timeoutMs]
 */

class WikiCliError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number | null, stdout?: string, stderr?: string }} [details]
   */
  constructor(message, { status, stdout, stderr } = {}) {
    super(message);
    /** @type {number | null | undefined} */
    this.status = status;
    /** @type {string | undefined} */
    this.stdout = stdout;
    /** @type {string | undefined} */
    this.stderr = stderr;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 16 * 1024 * 1024;

// Resolve how to invoke the skill CLI. Order:
//   1. LLM_WIKI_SKILL_CLI env -> explicit path to scripts/cli.mjs (dev/test).
//   2. resolve @ctxr/skill-llm-wiki/package.json from node_modules -> cli.mjs.
//   3. fall back to the `skill-llm-wiki` bin on PATH.
/** @type {SkillCli | null} */
let _resolved = null;
/** @returns {SkillCli} */
function resolveSkillCli() {
  if (_resolved) return _resolved;

  const explicit = process.env.LLM_WIKI_SKILL_CLI;
  if (explicit && fs.existsSync(explicit)) {
    _resolved = { cmd: process.execPath, baseArgs: [explicit], how: "env" };
    return _resolved;
  }

  try {
    const require = createRequire(path.join(here, "../../package.json"));
    const pkgPath = require.resolve("@ctxr/skill-llm-wiki/package.json");
    const cli = path.join(path.dirname(pkgPath), "scripts", "cli.mjs");
    if (fs.existsSync(cli)) {
      _resolved = { cmd: process.execPath, baseArgs: [cli], how: "node_modules" };
      return _resolved;
    }
  } catch {
    /* fall through to PATH */
  }

  _resolved = { cmd: "skill-llm-wiki", baseArgs: [], how: "path" };
  return _resolved;
}

/**
 * @param {string[]} args
 * @param {SpawnOpts} [opts]
 * @returns {SpawnResult}
 */
function spawnSkill(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { cmd, baseArgs } = resolveSkillCli();
  const env = { ...process.env, LLM_WIKI_NO_PROMPT: process.env.LLM_WIKI_NO_PROMPT || "1" };
  const res = spawnSync(cmd, [...baseArgs, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
  });
  if (res.error) {
    throw new WikiCliError(`skill-llm-wiki failed to start: ${res.error.message}`, {
      status: null,
      stdout: res.stdout,
      stderr: res.stderr,
    });
  }
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

// Run and require exit 0; otherwise throw with captured output.
/**
 * @param {string[]} args
 * @param {SpawnOpts} [opts]
 * @returns {SpawnResult}
 */
export function run(args, opts = {}) {
  const r = spawnSkill(args, opts);
  if (r.status !== 0) {
    throw new WikiCliError(
      `skill-llm-wiki ${args[0]} exited ${r.status}: ${(r.stderr || r.stdout).slice(0, 500)}`,
      r,
    );
  }
  return r;
}

// Run, allow non-zero, and parse the trailing JSON object from stdout.
// heal/validate emit a JSON envelope when --json is passed.
/**
 * @param {string[]} args
 * @param {SpawnOpts} [opts]
 * @returns {{ envelope: unknown, raw: SpawnResult }}
 */
function runJson(args, opts = {}) {
  const r = spawnSkill(args, opts);
  const text = (r.stdout || "").trim();
  // Prefer a full-string parse; fall back to the last {...} block.
  try {
    return { envelope: JSON.parse(text), raw: r };
  } catch {
    const m = text.match(/\{[\s\S]*\}\s*$/);
    if (m) {
      try {
        return { envelope: JSON.parse(m[0]), raw: r };
      } catch {
        /* fall through */
      }
    }
  }
  throw new WikiCliError(`skill-llm-wiki ${args[0]} --json returned non-JSON`, r);
}

export function where() {
  const { envelope } = runJson(["where", "--json"]);
  return envelope;
}

// Build (materialize) a hosted wiki from `source` into `wiki`. The contract
// file must already exist at <wiki>/.layout/layout.yaml.
/**
 * @param {{ wiki: string, source: string }} args
 * @returns {SpawnResult}
 */
export function buildHosted({ wiki, source }) {
  return run(["build", source, "--layout-mode", "hosted", "--target", wiki]);
}

// Regenerate one directory's index.md (creating it if absent). Deterministic.
/**
 * @param {string} dir
 * @param {string} wiki
 * @returns {SpawnResult}
 */
export function indexRebuildOne(dir, wiki) {
  return run(["index-rebuild-one", dir, wiki]);
}

// Regenerate every EXISTING index.md in the wiki. Does NOT create indexes for
// newly-added nested dirs (use ensureIndexes for that).
/**
 * @param {string} wiki
 * @returns {SpawnResult}
 */
export function indexRebuildAll(wiki) {
  return run(["index-rebuild", wiki]);
}

// Read-only correctness check. Returns {ok, errors, warnings, raw}.
/**
 * @param {string} wiki
 * @returns {{ ok: boolean, errors: number, warnings: number, status: number | null, raw: SpawnResult }}
 */
export function validate(wiki) {
  const r = spawnSkill(["validate", wiki]);
  const text = `${r.stdout}\n${r.stderr}`;
  const m = text.match(/(\d+)\s+error\(s\),\s*(\d+)\s+warning\(s\)/);
  const errors = m ? Number(m[1]) : r.status === 0 ? 0 : -1;
  const warnings = m ? Number(m[2]) : 0;
  return { ok: r.status === 0 && errors === 0, errors, warnings, status: r.status, raw: r };
}

// Classify wiki state and name the next command. Returns the heal envelope
// ({verdict, next, diagnostics, ...}).
/**
 * @param {string} wiki
 * @returns {unknown}
 */
export function heal(wiki) {
  const { envelope } = runJson(["heal", wiki, "--json"]);
  return envelope;
}

// Optimise structure via rewrite operators (the anti-flat-pile engine).
// Plan-gated by default unless apply=true. quality is one of
// tiered-fast|claude-first|deterministic.
/**
 * @param {string} wiki
 * @param {{ quality?: string, plan?: boolean }} [opts]
 * @returns {SpawnResult}
 */
export function rebuild(wiki, { quality = "deterministic", plan = false } = {}) {
  const args = ["rebuild", wiki, "--quality-mode", quality];
  if (plan) args.push("--plan");
  return run(args);
}

// Given a set of leaf file paths (absolute) inside the wiki, create/refresh
// the index.md for every ancestor directory from each leaf's dir up to the
// wiki root. Rebuilt deepest-first so each parent picks up freshly-created
// child indexes. This is the documented way to grow a nested tree: the full
// `index-rebuild` only refreshes existing indexes, it will not create new
// ones for nested dirs.
/**
 * @param {string} wiki
 * @param {string[]} leafPaths
 * @returns {string[]}
 */
export function ensureIndexes(wiki, leafPaths) {
  const wikiAbs = path.resolve(wiki);
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const leaf of leafPaths) {
    let dir = path.dirname(path.resolve(leaf));
    // Walk up to (and including) the wiki root.
    while (true) {
      dirs.add(dir);
      if (dir === wikiAbs) break;
      const parent = path.dirname(dir);
      if (parent === dir || !parent.startsWith(wikiAbs)) break;
      dir = parent;
    }
  }
  dirs.add(wikiAbs);
  // Deepest first (more path separators = deeper).
  const ordered = [...dirs].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const dir of ordered) {
    indexRebuildOne(dir, wikiAbs);
  }
  return ordered;
}

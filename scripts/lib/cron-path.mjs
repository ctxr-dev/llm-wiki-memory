// Single source of truth for the PATH the maintenance pipeline needs to find
// the provider CLIs (claude / codex / cursor-agent). launchd and cron strip
// the login PATH down to /usr/bin:/bin:/usr/sbin:/sbin, which hides CLIs
// installed in user-level dirs — the 2026-06-04 incident: hourly compile
// silently skipped promotions because every provider spawn ENOENT'd.
//
// Two consumers, one contract:
//   - bootstrap.sh shells out to this file's CLI print mode and bakes the
//     result into the launchd plist / Linux cron wrapper (bash cannot import
//     ESM);
//   - llm.mjs imports augmentSpawnEnv() so provider spawns heal at runtime
//     even under a stale plist from an older install.

import path from "node:path";
import { pathToFileURL } from "node:url";

// Well-known CLI install dirs across platforms and toolchain managers.
// Filesystem paths only — the no-provider-literals rule applies to
// provider/model NAMES, not directories. Pure string list: no fs probing,
// a nonexistent dir on PATH is harmless and probing would make the build
// nondeterministic.
export const CURATED_CLI_DIRS = Object.freeze([
  "~/.local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "~/.volta/bin",
  "~/.asdf/shims",
  "~/.bun/bin",
  "~/.deno/bin",
  "~/.cargo/bin",
  "~/n/bin",
  "~/.npm-global/bin",
  "/snap/bin",
]);

// Hybrid PATH: live env PATH first (user wins), then the dir of the node
// binary that launched us (npm-shim CLIs need `node` resolvable), then the
// curated dirs. Deduped keeping first occurrence; `~` entries dropped when
// home is unknown (a literal `~` on PATH is never resolved by spawn).
export function buildCronPath({ envPath = "", home = "", execPath = "" } = {}) {
  const segments = [];
  const seen = new Set();
  const push = (dir) => {
    if (!dir) return;
    if (seen.has(dir)) return;
    seen.add(dir);
    segments.push(dir);
  };

  for (const dir of String(envPath).split(":")) push(dir);
  if (execPath) push(path.dirname(execPath));
  for (const dir of CURATED_CLI_DIRS) {
    if (dir.startsWith("~/")) {
      if (home) push(path.join(home, dir.slice(2)));
    } else {
      push(dir);
    }
  }
  return segments.join(":");
}

// Spawn-env wrapper for llm.mjs: same merge, sourced from the child env
// (falling back to the process env) so an interactive session is a no-op
// dedup and a minimal cron env gains the curated dirs.
export function augmentSpawnEnv(env) {
  if (!env) return env;
  return {
    ...env,
    PATH: buildCronPath({
      envPath: env.PATH ?? process.env.PATH ?? "",
      home: env.HOME ?? process.env.HOME ?? "",
      execPath: process.execPath,
    }),
  };
}

const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  // No trailing newline: bootstrap captures this with "$(...)" verbatim.
  process.stdout.write(
    buildCronPath({
      envPath: process.env.PATH || "",
      home: process.env.HOME || "",
      execPath: process.execPath,
    }),
  );
}

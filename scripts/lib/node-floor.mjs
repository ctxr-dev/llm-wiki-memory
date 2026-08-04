// Detects a Node too old for `import.meta.main`, which every entrypoint's CLI guard is.
//
// Below the floor that property is `undefined`, so every guard is falsy and the entrypoint does
// nothing at all while exiting 0 — the exact silent no-op the guard replaced (a path comparison
// that disagreed with itself on any symlinked launch). `engines` in package.json does NOT prevent
// this: npm enforces it only under `engine-strict`. Nor does bootstrap's install-time feature
// test, which says nothing about the Node that runs a hook six months later — an nvm user who
// runs `nvm use 20` for another project changes what `node` on PATH means for every hook.
//
// The severity is the CALLER's choice, because the two surfaces have opposite contracts: a CLI or
// the server must fail loudly, while a capture hook must always exit 0 and never block a session.
// Same split as fatal-guard.mjs's `catchExceptions`.

const FLOOR = [22, 18, 0];
const FLOOR_TEXT = FLOOR.join(".");

// EX_CONFIG: the environment is wrong, not the request. Verified free — 0/1/2/3/64/65/66/69/70 all
// already carry meanings in this codebase.
const EX_CONFIG = 78;

// Exported for direct unit testing: faking `process.versions.node` in-process is not reliable, and
// the comparison is the part with edge cases (pre-release suffixes, short strings, non-numerics).
/** @param {string} version e.g. "22.17.1", "24.2.0", "23.0.0-nightly" @returns {boolean} */
export function isNodeVersionBelowFloor(version) {
  const parts = String(version)
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < FLOOR.length; i += 1) {
    const part = Number.isFinite(parts[i]) ? parts[i] : 0;
    if (part !== FLOOR[i]) return part < FLOOR[i];
  }
  return false;
}

// BOTH signals must agree, and that is not belt-and-braces — it is required for correctness.
// A bundler makes the feature test lie: Vite/Vitest's SSR transform rewrites `import.meta` into a
// synthesised object carrying only { url, env, filename, dirname }, so `import.meta.main` reads
// `undefined` on a perfectly supported Node. A feature-test-only predicate therefore cannot tell
// "Node is too old" from "my source was transformed", and would exit(78) inside a vitest worker.
// The Node version is the ground truth for a floor; the feature test only avoids refusing on a
// Node that reports an old version but does have the property.
/** @returns {boolean} */
function belowFloor() {
  const featureMissing = typeof import.meta.main !== "boolean";
  return featureMissing && isNodeVersionBelowFloor(process.versions.node);
}

/** @returns {string} */
function preamble() {
  return `llm-wiki-memory requires Node >=${FLOOR_TEXT} for import.meta.main; found ${process.version}.`;
}

/**
 * For a CLI or a long-running server: explain and exit non-zero. Nothing it would have done is
 * worth attempting, and a clean exit 0 here is indistinguishable from success.
 * @returns {void}
 */
export function refuseBelowNodeFloor() {
  if (!belowFloor()) return;
  process.stderr.write(`${preamble()} Every command would otherwise exit 0 without doing.\n`);
  process.exit(EX_CONFIG);
}

/**
 * For a capture hook: leave a breadcrumb but NEVER exit non-zero — the hook contract is that it
 * always exits 0 and never blocks a session. The hook still does nothing (its guard is falsy);
 * this line is the only thing distinguishing that from having worked.
 *
 * Called at module scope, so on a below-floor Node it also fires when the module is merely
 * imported. That is deliberate: below the floor there is NO reliable way to tell "launched" from
 * "imported" (that signal is exactly what is missing), so the wording states the capability, not
 * the launch.
 * @param {string} surface the hook's name, so the line identifies which capture is unavailable
 * @returns {void}
 */
export function warnBelowNodeFloor(surface) {
  if (!belowFloor()) return;
  process.stderr.write(
    `${preamble()} ${surface} cannot run on this Node — memory capture is DISABLED until you upgrade.\n`,
  );
}

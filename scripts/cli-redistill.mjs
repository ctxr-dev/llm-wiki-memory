import fs from "node:fs";
import path from "node:path";
import { out } from "./cli-io.mjs";

/** @param {string[]} rest */
export async function handleRedistill(rest) {
  // Manual recovery for the failed-distill stash. Three modes:
  //   --leaf <path>     re-distill against the stash whose session_id
  //                     matches the leaf's frontmatter.
  //   --session <id>    re-distill the newest stash for that session.
  //   --all             sweep every stash in STATE_DIR.
  const { redistillFromStash, redistillFromLeaf, listFailedDistillStashes, findStashForSession } =
    await import("./hooks/flush.mjs");
  /** @param {string} name */
  const opt = (name) => {
    const idx = rest.indexOf(`--${name}`);
    if (idx < 0) return null;
    const val = rest[idx + 1];
    // A following flag (e.g. `--leaf --session x`) means this flag had no
    // value — return null rather than swallowing the next flag as a value.
    return val == null || val.startsWith("--") ? null : val;
  };
  const leafArg = opt("leaf");
  const sessionArg = opt("session");
  const all = rest.includes("--all");

  if (!leafArg && !sessionArg && !all) {
    process.stderr.write(
      "usage: llm-wiki-memory redistill --leaf <path> | --session <id> | --all\n",
    );
    process.exit(64);
  }

  const stashes = [];
  // Leaves without a matching stash are recovered via the in-leaf raw
  // fallback path (redistillFromLeaf), so we collect those separately
  // from stash-backed leaves and process them after the stash sweep.
  const leafFallbacks = [];
  if (leafArg) {
    if (!fs.existsSync(leafArg)) {
      out({ ok: false, error: `leaf not found at ${leafArg}` });
      process.exit(2);
    }
    // Guard the read: --leaf pointed at a directory (EISDIR) or an
    // unreadable file would otherwise crash with an unhandled exception
    // instead of a clean JSON error.
    let leafText;
    try {
      leafText = fs.readFileSync(leafArg, "utf8");
    } catch (readErr) {
      out({
        ok: false,
        error: `could not read leaf at ${leafArg}: ${/** @type {Error} */ (readErr)?.message || readErr}`,
      });
      process.exit(2);
    }
    const m = leafText.match(/^- session_id:\s*(.+)$/m) || leafText.match(/^session_id:\s*(.+)$/m);
    if (!m) {
      out({ ok: false, error: `leaf at ${leafArg} has no session_id in frontmatter` });
      process.exit(2);
    }
    const stash = findStashForSession(m[1].trim());
    if (stash) {
      stashes.push(stash);
    } else {
      // No stash — pre-map-reduce leaf, or one whose stash was purged.
      // Recover from the in-leaf UNTRUSTED MEMORY BODY block instead.
      leafFallbacks.push(leafArg);
    }
  } else if (sessionArg) {
    const stash = findStashForSession(sessionArg);
    if (!stash) {
      out({ ok: false, error: `no stash for session ${sessionArg}` });
      process.exit(2);
    }
    stashes.push(stash);
  } else {
    stashes.push(...listFailedDistillStashes());
    if (stashes.length === 0) {
      out({ ok: true, redistilled: 0, message: "no failed-distill stashes to process" });
      return;
    }
  }

  const results = [];
  let anyFailed = false;
  for (const stash of stashes) {
    try {
      const r = await redistillFromStash(stash, { tag: "cli-redistill" });
      results.push({ stash: path.basename(stash), ok: true, outcome: r.outcome, audit: r.audit });
    } catch (err) {
      anyFailed = true;
      results.push({
        stash: path.basename(stash),
        ok: false,
        error: /** @type {Error} */ (err)?.message || String(err),
      });
    }
  }
  for (const leaf of leafFallbacks) {
    try {
      const r = await redistillFromLeaf(leaf, { tag: "cli-redistill-leaf" });
      results.push({ leaf: path.basename(leaf), ok: true, outcome: r.outcome, audit: r.audit });
    } catch (err) {
      anyFailed = true;
      results.push({
        leaf: path.basename(leaf),
        ok: false,
        error: /** @type {Error} */ (err)?.message || String(err),
      });
    }
  }
  out({
    ok: !anyFailed,
    redistilled: results.filter((r) => r.ok).length,
    total: stashes.length + leafFallbacks.length,
    results,
  });
  process.exit(anyFailed ? 2 : 0);
  return;
}

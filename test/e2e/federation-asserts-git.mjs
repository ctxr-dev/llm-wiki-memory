import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isIgnored, commitCount, porcelain } from "./federation-helpers.mjs";

/**
 * @param {string} repoDir
 * @param {{ tracked?: string[], ignored?: string[] }} matrix rel paths under the repo
 * @returns {void}
 */
export function assertGitignoreMatrix(repoDir, matrix) {
  for (const rel of matrix.tracked || []) {
    assert.equal(isIgnored(repoDir, rel), false, `should be TRACKED: ${rel}`);
  }
  for (const rel of matrix.ignored || []) {
    assert.equal(isIgnored(repoDir, rel), true, `should be IGNORED: ${rel}`);
  }
}

/**
 * @param {string} mountDir directory holding `.llm-wiki-memory`
 * @returns {Promise<void>}
 */
export async function assertPersonalGitLocation(mountDir) {
  const dm = path.join(mountDir, ".llm-wiki-memory");
  assert.ok(fs.existsSync(path.join(dm, "personal", ".git")), "personal/.git present");
  assert.ok(!fs.existsSync(path.join(dm, "wiki", ".git")), "wiki/.git absent");
  assert.ok(!fs.existsSync(path.join(dm, ".git")), "mount-root .git absent");
  // Lazy import: a top-level engine import from a test helper can perturb sibling
  // e2e state (see monitoring capture). Reset the process-global probe cache so a
  // freshly-git-init'd mount is not read as a stale cached result.
  const { gitUsable, _resetGitProbeCache } = await import("../../scripts/lib/wiki-commit-git.mjs");
  _resetGitProbeCache();
  assert.equal(gitUsable(path.join(dm, "wiki")), false, "shared wiki subtree not gitUsable (R9)");
}

/**
 * @param {string} hooksDir
 * @param {{ events?: string[], wrapperFragment?: string }} [spec]
 * @returns {void}
 */
export function assertSyncHook(hooksDir, spec = {}) {
  const events = spec.events || ["post-merge", "post-checkout", "post-rewrite"];
  for (const ev of events) {
    const p = path.join(hooksDir, ev);
    assert.ok(fs.existsSync(p), `hook ${ev} present`);
    assert.ok((fs.statSync(p).mode & 0o111) !== 0, `hook ${ev} executable`);
    const body = fs.readFileSync(p, "utf8");
    assert.match(body, /^#!\/usr\/bin\/env bash/, `hook ${ev} shebang`);
    if (spec.wrapperFragment)
      assert.ok(body.includes(spec.wrapperFragment), `hook ${ev} wrapper path`);
  }
}

/**
 * @param {string} repoDir
 * @returns {void}
 */
export function assertNoHostRepoPollution(repoDir) {
  assert.equal(commitCount(repoDir), 0, "engine authored no commits");
  // porcelain "XY path": index status is column 0. The engine never STAGES, so
  // every entry must be untracked '?' or worktree-only ' ' — never a staged
  // A/M/D/R/C. (A nested subrepo shows as '?? pkg/', which is fine.)
  for (const line of porcelain(repoDir).split("\n").filter(Boolean)) {
    assert.match(line, /^[ ?]/, `engine staged nothing: ${line}`);
  }
}

/**
 * Per-mount pack: initMount result + personal-git location + no host pollution.
 * @param {import('./federation-helpers.mjs').NestedMount} mount
 * @param {{ seeded?: string }} [expected]
 * @returns {Promise<void>}
 */
export async function validateMount(mount, expected = {}) {
  const r = mount.result;
  assert.equal(r.seeded, expected.seeded ?? "repo", "seeded template");
  assert.equal(r.gitignore, true, "mount .gitignore written");
  assert.equal(r.personalGit?.created, true, "personal git created");
  assert.equal(r.hostIgnore?.ok, true, "host repo not shadowing the mount");
  assert.equal(r.syncHook?.ok, true, "sync hook installed");
  await assertPersonalGitLocation(mount.dir);
  assertNoHostRepoPollution(mount.dir);
}

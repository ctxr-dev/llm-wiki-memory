import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalRepoId,
  gitOriginUrl,
  projectModuleSegment,
  resolveProjectModuleIdentity,
  validateProjectModuleIdentity,
} from "../scripts/lib/project-identity.mjs";

test("canonicalRepoId folds ssh/https/.git/case/trailing-slash to the SAME org/repo", () => {
  const sameRepo = [
    "git@github.com:Org/Repo.git",
    "https://github.com/Org/Repo.git",
    "https://github.com/Org/Repo",
    "https://github.com/Org/Repo/",
    "https://github.com/Org/Repo.git/",
    "git@github.com:Org/Repo.git/",
    "ssh://git@github.com/Org/Repo.git",
    "ssh://git@github.com:22/Org/Repo.git",
    "HTTPS://GitHub.com/ORG/REPO.GIT",
    "git://github.com/org/repo.git",
  ];
  for (const url of sameRepo) {
    assert.equal(canonicalRepoId(url), "org/repo", `${url} → org/repo`);
  }
});

test("canonicalRepoId keeps nested group paths (e.g. gitlab subgroups)", () => {
  assert.equal(canonicalRepoId("git@gitlab.com:group/sub/repo.git"), "group/sub/repo");
  assert.equal(canonicalRepoId("https://gitlab.com/group/sub/repo"), "group/sub/repo");
});

test("canonicalRepoId is host-agnostic (no hardcoded forge)", () => {
  assert.equal(canonicalRepoId("git@bitbucket.example.com:team/svc.git"), "team/svc");
  assert.equal(canonicalRepoId("https://git.internal.corp/team/svc"), "team/svc");
});

test("canonicalRepoId returns null for malformed / single-segment / empty / non-string", () => {
  for (const bad of [
    "",
    "   ",
    "not-a-url",
    "https://github.com/onlyrepo",
    "git@host:",
    "https://github.com/",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(canonicalRepoId(/** @type {any} */ (bad)), null, `${JSON.stringify(bad)} → null`);
  }
});

test("projectModuleSegment: a declared project_id wins over git origin and file://", () => {
  const seg = projectModuleSegment(
    { mountDir: "/m", projectId: "acme/thing" },
    () => "git@github.com:org/repo.git",
  );
  assert.equal(seg, "acme/thing");
});

test("projectModuleSegment: canonical git origin when there is no project_id", () => {
  assert.equal(
    projectModuleSegment({ mountDir: "/m" }, () => "git@github.com:Org/Repo.git"),
    "org/repo",
  );
});

test("projectModuleSegment: file://mountDir fallback when no id and no origin", () => {
  assert.equal(
    projectModuleSegment({ mountDir: "/some/dir" }, () => null),
    "file:///some/dir",
  );
});

test("resolveProjectModuleIdentity: a brain (wiki) target → its own segment (no repo chain)", () => {
  const brain = { mountDir: "/home/.lwm", ownership: "wiki" };
  assert.equal(
    resolveProjectModuleIdentity({ levels: [brain] }, brain, () => null),
    "file:///home/.lwm",
  );
});

test("resolveProjectModuleIdentity: a single repo → its canonical id (chain of one)", () => {
  const brain = { mountDir: "/h/.lwm", ownership: "wiki" };
  const repo = { mountDir: "/h/repo/.lwm", ownership: "repo" };
  const origin = (/** @type {string} */ d) =>
    d === "/h/repo/.lwm" ? "git@github.com:org/repo.git" : null;
  assert.equal(resolveProjectModuleIdentity({ levels: [brain, repo] }, repo, origin), "org/repo");
});

test("resolveProjectModuleIdentity: nested subrepo → full // chain, outermost→owning", () => {
  const brain = { mountDir: "/h", ownership: "wiki" };
  const repo = { mountDir: "/h/acme", ownership: "repo" };
  const sub = { mountDir: "/h/acme/core", ownership: "repo" };
  const ctx = { levels: [brain, repo, sub] };
  const origin = (/** @type {string} */ d) =>
    d === "/h/acme"
      ? "git@github.com:org/acme.git"
      : d === "/h/acme/core"
        ? "git@github.com:org2/core.git"
        : null;
  assert.equal(resolveProjectModuleIdentity(ctx, sub, origin), "org/acme//org2/core");
  assert.equal(resolveProjectModuleIdentity(ctx, repo, origin), "org/acme");
});

test("resolveProjectModuleIdentity: SIBLING repos are NOT chained — a write to one is never stamped with the other's identity", () => {
  const brain = { mountDir: "/h", ownership: "wiki" };
  const alpha = { mountDir: "/h/p/alpha", ownership: "repo" };
  const bravo = { mountDir: "/h/p/bravo", ownership: "repo" };
  // Both in scope; alpha sorts before bravo (byDepthThenPath), so an index-based
  // chain would wrongly prepend alpha to a write targeting bravo.
  const ctx = { levels: [brain, alpha, bravo] };
  const origin = (/** @type {string} */ d) =>
    d === "/h/p/alpha"
      ? "git@github.com:acme/alpha.git"
      : d === "/h/p/bravo"
        ? "git@github.com:acme/bravo.git"
        : null;
  assert.equal(resolveProjectModuleIdentity(ctx, bravo, origin), "acme/bravo");
  assert.equal(resolveProjectModuleIdentity(ctx, alpha, origin), "acme/alpha");
});

test("resolveProjectModuleIdentity: a repo with no origin falls back to file:// in the chain", () => {
  const brain = { mountDir: "/h/.lwm", ownership: "wiki" };
  const repo = { mountDir: "/h/local/.lwm", ownership: "repo" };
  assert.equal(
    resolveProjectModuleIdentity({ levels: [brain, repo] }, repo, () => null),
    "file:///h/local/.lwm",
  );
});

test("gitOriginUrl: reads a real repo's origin; null when there is none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-git-"));
  try {
    spawnSync("git", ["-C", dir, "init"], { encoding: "utf8" });
    assert.equal(gitOriginUrl(dir), null, "no origin yet → null");
    spawnSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:org/repo.git"], {
      encoding: "utf8",
    });
    assert.equal(gitOriginUrl(dir), "git@github.com:org/repo.git");
    assert.equal(canonicalRepoId(gitOriginUrl(dir)), "org/repo", "canonicalizes a real origin");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateProjectModuleIdentity: ok when every repo-owned ANCESTOR level has a portable id", () => {
  const brain = { mountDir: "/h", ownership: "wiki" };
  const outer = { mountDir: "/h/a", ownership: "repo" };
  const inner = { mountDir: "/h/a/b", ownership: "repo", projectId: "team/svc" };
  const ctx = { levels: [brain, outer, inner] };
  const origin = (/** @type {string} */ d) => (d === "/h/a" ? "git@github.com:org/a.git" : null);
  assert.deepEqual(validateProjectModuleIdentity(ctx, inner, origin), { ok: true });
});

test("validateProjectModuleIdentity: a wiki brain that resolves to file:// is NOT a conflict", () => {
  const brain = { mountDir: "/h/.lwm", ownership: "wiki" };
  assert.deepEqual(
    validateProjectModuleIdentity({ levels: [brain] }, brain, () => null),
    {
      ok: true,
    },
  );
});

test("validateProjectModuleIdentity: a repo-owned ANCESTOR with no portable id is surfaced (fail-loud)", () => {
  const brain = { mountDir: "/h", ownership: "wiki" };
  const outer = { mountDir: "/h/a", ownership: "repo" };
  const inner = { mountDir: "/h/a/b", ownership: "repo" };
  const ctx = { levels: [brain, outer, inner] };
  const origin = (/** @type {string} */ d) => (d === "/h/a" ? "git@github.com:org/a.git" : null);
  const r = validateProjectModuleIdentity(ctx, inner, origin);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1, "only the no-portable-id repo level is flagged");
  assert.equal(r.conflicts[0].mountDir, "/h/a/b");
  assert.match(r.conflicts[0].reason, /portable identity/);
});

test("validateProjectModuleIdentity: a SIBLING with no portable id does NOT taint the target", () => {
  const brain = { mountDir: "/h", ownership: "wiki" };
  const sibBad = { mountDir: "/h/p/alpha", ownership: "repo" };
  const target = { mountDir: "/h/p/bravo", ownership: "repo", projectId: "acme/bravo" };
  const ctx = { levels: [brain, sibBad, target] };
  assert.deepEqual(
    validateProjectModuleIdentity(ctx, target, () => null),
    { ok: true },
    "the unrelated sibling's missing identity is not the target's conflict",
  );
});

test("resolve/validate: a targetLevel not nested under any ctx repo → its OWN segment (no unrelated inheritance)", () => {
  const brain = { mountDir: "/h", ownership: "wiki" };
  const repo = { mountDir: "/h/a", ownership: "repo", projectId: "org/a" };
  const ctx = { levels: [brain, repo] };
  const foreign = { mountDir: "/elsewhere", ownership: "repo", projectId: "x/y" };
  assert.equal(
    resolveProjectModuleIdentity(ctx, foreign, () => null),
    "x/y",
    "a foreign target that is not nested under any ctx repo keeps its own identity",
  );
  assert.equal(
    validateProjectModuleIdentity(ctx, foreign, () => null).ok,
    true,
    "no repo ANCESTOR lacks an id → no conflict",
  );
});

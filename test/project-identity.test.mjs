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
  const brain = { mountDir: "/h/.lwm", ownership: "wiki" };
  const repo = { mountDir: "/h/acme/.lwm", ownership: "repo" };
  const sub = { mountDir: "/h/acme/core/.lwm", ownership: "repo" };
  const ctx = { levels: [brain, repo, sub] };
  const origin = (/** @type {string} */ d) =>
    d === "/h/acme/.lwm"
      ? "git@github.com:org/acme.git"
      : d === "/h/acme/core/.lwm"
        ? "git@github.com:org2/core.git"
        : null;
  assert.equal(resolveProjectModuleIdentity(ctx, sub, origin), "org/acme//org2/core");
  assert.equal(resolveProjectModuleIdentity(ctx, repo, origin), "org/acme");
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

test("validateProjectModuleIdentity: ok when every repo-owned level has a portable id", () => {
  const brain = { mountDir: "/h/.lwm", ownership: "wiki" };
  const withOrigin = { mountDir: "/h/a/.lwm", ownership: "repo" };
  const withId = { mountDir: "/h/b/.lwm", ownership: "repo", projectId: "team/svc" };
  const ctx = { levels: [brain, withOrigin, withId] };
  const origin = (/** @type {string} */ d) =>
    d === "/h/a/.lwm" ? "git@github.com:org/a.git" : null;
  assert.deepEqual(validateProjectModuleIdentity(ctx, withId, origin), { ok: true });
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

test("validateProjectModuleIdentity: a repo-owned level with no portable id is surfaced (fail-loud)", () => {
  const brain = { mountDir: "/h/.lwm", ownership: "wiki" };
  const ok = { mountDir: "/h/a/.lwm", ownership: "repo" };
  const bad = { mountDir: "/h/b/.lwm", ownership: "repo" };
  const ctx = { levels: [brain, ok, bad] };
  const origin = (/** @type {string} */ d) =>
    d === "/h/a/.lwm" ? "git@github.com:org/a.git" : null;
  const r = validateProjectModuleIdentity(ctx, bad, origin);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts.length, 1, "only the no-portable-id repo level is flagged");
  assert.equal(r.conflicts[0].mountDir, "/h/b/.lwm");
  assert.match(r.conflicts[0].reason, /portable identity/);
});

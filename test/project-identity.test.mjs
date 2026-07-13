import test from "node:test";
import assert from "node:assert/strict";
import { canonicalRepoId } from "../scripts/lib/project-identity.mjs";

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

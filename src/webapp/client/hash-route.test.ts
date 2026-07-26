import { describe, test, expect } from "vitest";
import { refToHash, hashToRef, desiredHash, resolveHash, planRestore } from "./hash-route";
import type { Wiki } from "./api";

const home: Wiki = {
  id: "home-id",
  kind: "home",
  root: "/ws/.llm-wiki-memory/wiki",
  mountDir: "/ws",
  projectModule: "ws-default-module",
  ownership: "wiki",
  label: "Main Brain",
  categories: ["knowledge"],
};

const repo: Wiki = {
  id: "repo-id",
  kind: "added",
  root: "/ws/repos/widget/.llm-wiki-memory/wiki",
  mountDir: "/ws/repos/widget",
  projectModule: "acme/widget",
  ownership: "repo",
  label: "Widget",
  categories: ["knowledge"],
};

const wikis = [home, repo];

describe("refToHash / hashToRef round-trip", () => {
  test("slashes and colons stay readable", () => {
    expect(refToHash("brain:knowledge/a.md")).toBe("#brain:knowledge/a.md");
    expect(hashToRef("#brain:knowledge/a.md")).toBe("brain:knowledge/a.md");
  });
  test("a space in the docId survives the round-trip (percent-encoded in the hash)", () => {
    const ref = "brain:knowledge/my note.md";
    const hash = refToHash(ref);
    expect(hash).toBe("#brain:knowledge/my%20note.md");
    expect(hashToRef(hash)).toBe(ref);
  });
  test("hashToRef tolerates a missing leading # and malformed encoding", () => {
    expect(hashToRef("brain:knowledge/a.md")).toBe("brain:knowledge/a.md");
    expect(hashToRef("#%")).toBe("%");
  });
});

describe("desiredHash — app state to URL", () => {
  test("brain doc", () =>
    expect(desiredHash(home, "knowledge/a.md")).toBe("#brain:knowledge/a.md"));
  test("repo doc derives the source from the wiki (no literal)", () =>
    expect(desiredHash(repo, "knowledge/b.md")).toBe(`#${repo.projectModule}:knowledge/b.md`));
  test("no active doc or no wiki -> empty (clears the hash)", () => {
    expect(desiredHash(home, null)).toBe("");
    expect(desiredHash(undefined, "knowledge/a.md")).toBe("");
  });
});

describe("resolveHash — URL to app state", () => {
  test("a valid hash resolves against the live wikis", () =>
    expect(resolveHash(wikis, "#brain:knowledge/a.md")).toEqual({
      wikiId: home.id,
      docId: "knowledge/a.md",
    }));
  test("an unknown source is ignored", () =>
    expect(resolveHash(wikis, "#nope:knowledge/a.md")).toBeNull());
  test("an empty hash is ignored", () => {
    expect(resolveHash(wikis, "")).toBeNull();
    expect(resolveHash(wikis, "#")).toBeNull();
  });
});

describe("planRestore — hash target precedes the openTabs restore", () => {
  test("a pending doc not among the restored tabs is appended and made active", () =>
    expect(planRestore(["knowledge/a.md"], "knowledge/b.md")).toEqual({
      tabs: ["knowledge/a.md", "knowledge/b.md"],
      active: "knowledge/b.md",
    }));
  test("a pending doc already open is made active without duplicating", () =>
    expect(planRestore(["knowledge/a.md", "knowledge/b.md"], "knowledge/b.md")).toEqual({
      tabs: ["knowledge/a.md", "knowledge/b.md"],
      active: "knowledge/b.md",
    }));
  test("no pending doc -> first restored tab is active", () =>
    expect(planRestore(["knowledge/a.md", "knowledge/b.md"], null)).toEqual({
      tabs: ["knowledge/a.md", "knowledge/b.md"],
      active: "knowledge/a.md",
    }));
  test("no pending doc and no restored tabs -> nothing active", () =>
    expect(planRestore([], null)).toEqual({ tabs: [], active: null }));
});

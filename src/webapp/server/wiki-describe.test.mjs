import { test, expect } from "vitest";
import path from "node:path";
import { hashRoot, prettify, describeWiki } from "./wiki-describe.mjs";

test("hashRoot is deterministic, distinct, and short", () => {
  expect(hashRoot("/w/a")).toBe(hashRoot("/w/a"));
  expect(hashRoot("/w/a")).not.toBe(hashRoot("/w/b"));
  expect(hashRoot("/w/a").length).toBe(12);
});

test("prettify humanizes slugs", () => {
  expect(prettify("my-repo_name")).toBe("My Repo Name");
  expect(prettify("repos")).toBe("Repos");
});

test("describeWiki builds the wiki shape and derives a label", () => {
  const root = path.join("/w", "a", "wiki");
  const mountDir = path.join("/w", "a");
  const wiki = describeWiki(
    { root, mountDir, projectModule: "a-repo", ownership: "repo" },
    ["knowledge"],
    "added",
  );
  expect(wiki).toMatchObject({
    kind: "added",
    ownership: "repo",
    label: "A Repo",
    categories: ["knowledge"],
    mountDir,
  });
  expect(wiki.id).toBe(hashRoot(root));
});

test("describeWiki prefers an explicit label over the prettified slug", () => {
  const wiki = describeWiki(
    { root: "/w/a", mountDir: "/w/a", projectModule: "a-repo", ownership: "repo", label: "Custom" },
    [],
    "added",
  );
  expect(wiki.label).toBe("Custom");
});

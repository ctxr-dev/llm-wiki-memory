import { describe, test, expect } from "vitest";
import {
  wikiToSource,
  formatRef,
  parseRef,
  resolveRef,
  resolveRefHref,
  isDocumentId,
  wikiById,
  wikiLabel,
} from "./refs";
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

const NESTED_PM = ["acme/outer", "acme/inner"].join("/".repeat(2));

const nested: Wiki = {
  id: "nested-id",
  kind: "added",
  root: "/ws/repos/outer/inner/.llm-wiki-memory/wiki",
  mountDir: "/ws/repos/outer/inner",
  projectModule: NESTED_PM,
  ownership: "repo",
  label: "Inner",
  categories: ["knowledge"],
};

const wikis = [home, repo, nested];

describe("wikiToSource — home is brain BY KIND, not projectModule", () => {
  test("home wiki resolves to the 'brain' sentinel, never its projectModule", () => {
    expect(wikiToSource(home)).toBe("brain");
    expect(wikiToSource(home)).not.toBe(home.projectModule);
  });
  test("repo wiki resolves to its (canonical) projectModule", () => {
    expect(wikiToSource(repo)).toBe(repo.projectModule);
    expect(wikiToSource(nested)).toBe(nested.projectModule);
  });
});

describe("formatRef", () => {
  test("home", () => expect(formatRef(home, "knowledge/a.md")).toBe("brain:knowledge/a.md"));
  test("repo derives the source from the fixture (no literal)", () =>
    expect(formatRef(repo, "knowledge/b.md")).toBe(`${repo.projectModule}:knowledge/b.md`));
});

describe("parseRef — tokenizer only (split on first colon)", () => {
  test("brain + slashed path incl. .md", () =>
    expect(parseRef("brain:knowledge/infra/foo.md")).toEqual({
      source: "brain",
      path: "knowledge/infra/foo.md",
    }));
  test("multi-segment nested source", () =>
    expect(parseRef(`${NESTED_PM}:knowledge/x.md`)).toEqual({
      source: NESTED_PM,
      path: "knowledge/x.md",
    }));
  test("no colon -> null", () => expect(parseRef("nocolon")).toBeNull());
  test("empty path after colon -> null", () => expect(parseRef("brain:")).toBeNull());
});

describe("wikiById / wikiLabel — the tooltip lookup for a resolved ref", () => {
  test("an id present in the list resolves to that wiki and its label", () => {
    expect(wikiById(wikis, repo.id)).toBe(repo);
    expect(wikiLabel(wikis, home.id)).toBe(home.label);
  });
  test("an unknown id yields undefined rather than throwing", () => {
    expect(wikiById(wikis, "missing-id")).toBeUndefined();
    expect(wikiLabel(wikis, "missing-id")).toBeUndefined();
  });
  test("an empty wiki list yields undefined", () => {
    expect(wikiById([], home.id)).toBeUndefined();
    expect(wikiLabel([], home.id)).toBeUndefined();
  });
  test("a resolved ref's wikiId round-trips back to its wiki", () => {
    const resolved = resolveRef(wikis, formatRef(nested, "knowledge/x.md"));
    expect(wikiLabel(wikis, resolved?.wikiId ?? "")).toBe(nested.label);
  });
});

describe("resolveRef — the accept gate: live wikis, case-insensitive", () => {
  test("brain -> home wiki id", () =>
    expect(resolveRef(wikis, "brain:knowledge/a.md")).toEqual({
      wikiId: home.id,
      docId: "knowledge/a.md",
    }));
  test("repo source -> repo wiki id", () =>
    expect(resolveRef(wikis, `${repo.projectModule}:knowledge/b.md`)).toEqual({
      wikiId: repo.id,
      docId: "knowledge/b.md",
    }));
  test("case-insensitive on the repo source", () =>
    expect(resolveRef(wikis, `${repo.projectModule.toUpperCase()}:knowledge/b.md`)).toEqual({
      wikiId: repo.id,
      docId: "knowledge/b.md",
    }));
  test("multi-segment source resolves", () =>
    expect(resolveRef(wikis, `${nested.projectModule}:knowledge/x.md`)).toEqual({
      wikiId: nested.id,
      docId: "knowledge/x.md",
    }));
  test("unknown/looks-like-ref tokens reject (http, time, arbitrary source)", () => {
    expect(resolveRef(wikis, "http://example.com/x")).toBeNull();
    expect(resolveRef(wikis, "12:30")).toBeNull();
    expect(resolveRef(wikis, "not-a-source:knowledge/a.md")).toBeNull();
    expect(resolveRef(wikis, "plain text")).toBeNull();
  });
  test("round-trip formatRef -> resolveRef", () => {
    const ref = formatRef(nested, "knowledge/deep/y.md");
    expect(resolveRef(wikis, ref)).toEqual({ wikiId: nested.id, docId: "knowledge/deep/y.md" });
  });
  test("a source that itself contains a colon (remote-less file:// identity) still round-trips", () => {
    const local: Wiki = {
      id: "local-id",
      kind: "added",
      root: "/ws/repos/local/.llm-wiki-memory/wiki",
      mountDir: "/ws/repos/local",
      projectModule: "file:///ws/repos/local",
      ownership: "repo",
      label: "Local",
      categories: ["knowledge"],
    };
    const ref = formatRef(local, "knowledge/z.md");
    expect(resolveRef([...wikis, local], ref)).toEqual({
      wikiId: local.id,
      docId: "knowledge/z.md",
    });
  });
  test("surrounding whitespace is tolerated", () =>
    expect(resolveRef(wikis, "  brain:knowledge/a.md  ")).toEqual({
      wikiId: home.id,
      docId: "knowledge/a.md",
    }));
  test("an empty path after the colon rejects", () =>
    expect(resolveRef(wikis, "brain:")).toBeNull());
  test("a whitespace-padded path after the colon is trimmed", () =>
    expect(resolveRef(wikis, "brain: knowledge/a.md ")).toEqual({
      wikiId: home.id,
      docId: "knowledge/a.md",
    }));
  test("a path that is only whitespace rejects", () =>
    expect(resolveRef(wikis, "brain:   ")).toBeNull());
  test("two wikis sharing a source resolve to the first (documented ambiguity)", () => {
    const twin: Wiki = {
      ...repo,
      id: "twin-id",
      root: "/ws/repos/widget-clone/.llm-wiki-memory/wiki",
    };
    expect(resolveRef([repo, twin], `${repo.projectModule}:knowledge/b.md`)?.wikiId).toBe(repo.id);
  });
  test("the longer source wins when one source prefixes another", () => {
    const short: Wiki = { ...repo, id: "short-id", projectModule: "acme/wid" };
    const long: Wiki = { ...repo, id: "long-id", projectModule: "acme/widget" };
    expect(resolveRef([short, long], "acme/widget:knowledge/b.md")?.wikiId).toBe(long.id);
  });
});

describe("resolveRef — the document-id shape gate", () => {
  test.each([
    ["a ref trailed by prose", "brain:knowledge/a.md file.txt"],
    ["a ref trailed by a parenthetical", "brain:knowledge/a.md (superseded)"],
    ["the grammar placeholder", "brain:<docId>"],
    ["a path with no .md suffix", "brain:knowledge/a"],
    ["a suffix with no name in front of it", "brain:.md"],
    ["prose that merely starts with a source prefix", "brain: build is red"],
    ["a document id carrying a fragment", "brain:knowledge/a.md#section"],
  ])("%s is not a reference", (_case, text) => expect(resolveRef(wikis, text)).toBeNull());

  test("a plan leaf and a deep path stay references", () => {
    expect(resolveRef(wikis, "brain:plans/backend/x.plan.md")?.docId).toBe(
      "plans/backend/x.plan.md",
    );
    expect(resolveRef(wikis, "brain:issues/JIRA/DEV/134/9/6/DEV-134096.md")?.docId).toBe(
      "issues/JIRA/DEV/134/9/6/DEV-134096.md",
    );
  });

  test("isDocumentId is the shape rule the gate applies", () => {
    expect(isDocumentId("knowledge/a.md")).toBe(true);
    expect(isDocumentId("a.md b.md")).toBe(false);
    expect(isDocumentId(".md")).toBe(false);
    expect(isDocumentId("knowledge/a")).toBe(false);
  });
});

describe("resolveRefHref — hrefs arrive percent-encoded and must be decoded once", () => {
  test("a non-ASCII document id decodes back to its real id", () =>
    expect(resolveRefHref(wikis, "brain:knowledge/caf%C3%A9.md")).toEqual({
      wikiId: home.id,
      docId: "knowledge/café.md",
    }));
  test("an unencoded href resolves unchanged", () =>
    expect(resolveRefHref(wikis, "brain:knowledge/a.md")?.docId).toBe("knowledge/a.md"));
  test("a malformed escape sequence falls back to the raw href instead of throwing", () =>
    expect(resolveRefHref(wikis, "brain:knowledge/%E0%A4%A.md")?.docId).toBe(
      "knowledge/%E0%A4%A.md",
    ));
  test("an undefined or empty href is not a reference", () => {
    expect(resolveRefHref(wikis, undefined)).toBeNull();
    expect(resolveRefHref(wikis, "")).toBeNull();
  });
  test("an encoded space still rejects, because a document id carries no whitespace", () =>
    expect(resolveRefHref(wikis, "brain:knowledge/my%20note.md")).toBeNull());
});

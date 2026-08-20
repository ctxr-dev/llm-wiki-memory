import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";
import { TitlesSchema } from "../shared/contract.mjs";

const DIR = "issues/JIRA/DEV/134/9/6";
const REAL = `${DIR}/pending/DEV-134096-cleanup.plan.md`;
const STALE = `${DIR}/in-progress/DEV-134096-cleanup.plan.md`;
const RETIRED_REAL = `${DIR}/done/DEV-134096-retired.plan.md`;
const RETIRED_STALE = `${DIR}/pending/DEV-134096-retired.plan.md`;
const FACET_REAL = "plans/infra/pending/deploy.plan.md";
const FACET_STALE = "plans/infra/in-progress/deploy.plan.md";
const KNOWLEDGE_REAL = `${DIR}/pending/DEV-134096.md`;
const KNOWLEDGE_STALE = `${DIR}/in-progress/DEV-134096.md`;
const ESCAPING = "../outside/evil.plan.md";
const UNRESOLVABLE = `${DIR}/archived/DEV-999999-nope.plan.md`;

function seed(wiki) {
  const write = (rel, focus, status) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\nfocus: ${focus}\nmemory:\n  atom_type: decision\n  status: ${status}\n---\nbody\n`,
    );
  };
  write(REAL, "Cleanup Plan", "active");
  write(RETIRED_REAL, "Retired Plan", "archived");
  write(FACET_REAL, "Deploy Plan", "active");
  write(KNOWLEDGE_REAL, "Cleanup Notes", "active");
}

function plantOutsideWikiRoot(dir) {
  const abs = path.join(dir, "outside", "evil.plan.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "---\nfocus: Evil Leaf\n---\nA leaf that lives outside the wiki root.\n");
  return abs;
}

let app;
let db;
let dataDir;
let id;
let plantedLeaf;

beforeAll(async () => {
  const workspace = setupWorkspace({ template: "tracker-issues" });
  dataDir = workspace.dataDir;
  seed(workspace.wiki);
  plantedLeaf = plantOutsideWikiRoot(dataDir);
  const { openAppDb } = await import("./app-db.mjs");
  const { buildApp } = await import("./index.mjs");
  db = openAppDb(path.join(dataDir, "webapp-test", "app.sqlite"));
  app = buildApp({ db });
  await app.ready();
  id = (await app.inject({ method: "GET", url: "/api/wikis" })).json().wikis[0].id;
});

afterAll(async () => {
  if (app) await app.close();
  if (db) db.close();
  if (dataDir) cleanup(dataDir);
});

const getTitles = async (ids) => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/titles?ids=${encodeURIComponent(ids.join(","))}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json().titles;
};

test("a stale lifecycle id reports the real leaf's title and its real id", async () => {
  const titles = await getTitles([STALE]);
  expect(titles[STALE]).toEqual({ title: "Cleanup Plan", active: true, resolvedId: REAL });
});

test("an exact hit carries no resolvedId, so the field alone marks a substitution", async () => {
  const titles = await getTitles([REAL]);
  expect(titles[REAL]).toEqual({ title: "Cleanup Plan", active: true });
});

test("a substituted entry reports the resolved leaf's archived state, not the miss default", async () => {
  const titles = await getTitles([RETIRED_STALE]);
  expect(titles[RETIRED_STALE]).toEqual({
    title: "Retired Plan",
    active: false,
    resolvedId: RETIRED_REAL,
  });
});

test("a facet-placed category is never cross-resolved", async () => {
  const titles = await getTitles([FACET_STALE, FACET_REAL]);
  expect(titles[FACET_STALE]).toEqual({ title: "deploy.plan.md", active: true });
  expect(titles[FACET_REAL].title).toBe("Deploy Plan");
});

test("a non-plan id under a lifecycle folder gets no resolvedId", async () => {
  const titles = await getTitles([KNOWLEDGE_STALE]);
  expect(titles[KNOWLEDGE_STALE].resolvedId).toBeUndefined();
});

test("an id that escapes the wiki root gets its basename, never the escaped leaf's title", async () => {
  expect(fs.existsSync(plantedLeaf)).toBe(true);
  const titles = await getTitles([ESCAPING]);
  expect(titles[ESCAPING]).toEqual({ title: "evil.plan.md", active: true });
});

test("an unresolvable stale id keeps the basename fallback and no resolvedId", async () => {
  const titles = await getTitles([UNRESOLVABLE]);
  expect(titles[UNRESOLVABLE]).toEqual({ title: "DEV-999999-nope.plan.md", active: true });
});

test("a substitution is also keyed under the real id, so a healed tab keeps title and state", async () => {
  const titles = await getTitles([RETIRED_STALE]);
  expect(titles[RETIRED_REAL]).toEqual({ title: "Retired Plan", active: false });
});

test("resolvedId survives the shared contract, not merely the raw payload", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/titles?ids=${encodeURIComponent(STALE)}`,
  });
  const { titles } = TitlesSchema.parse(res.json());
  expect(titles[STALE].resolvedId).toBe(REAL);
});

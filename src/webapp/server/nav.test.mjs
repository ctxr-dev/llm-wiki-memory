import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

function seed(wiki) {
  const write = (rel, status, focus) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const focusLine = focus ? `focus: ${focus}\n` : "";
    fs.writeFileSync(
      abs,
      `---\n${focusLine}memory:\n  atom_type: decision\n  status: ${status}\n---\nbody\n`,
    );
  };
  write("knowledge/backend/decision/architecture/alpha.md", "active", "Alpha Decision");
  write("knowledge/backend/decision/architecture/beta.md", "active");
  write("knowledge/backend/decision/observability/gamma.md", "active");
  write("knowledge/unscoped/untyped/general/orphan.md", "active");
  write("knowledge/frontend/reference/tooling/delta.md", "archived");
  write("plans/general/solo.md", "active", "Solo Plan");
  const corrupt = path.join(wiki, "investigations", "security", "general", "corrupt.md");
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  fs.writeFileSync(corrupt, "---\nfoo: [1, 2\n---\nbody\n");
}

let app;
let db;
let dataDir;
let id;

beforeAll(async () => {
  const workspace = setupWorkspace();
  dataDir = workspace.dataDir;
  seed(workspace.wiki);
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

test("GET /nav lists categories with layout facets and total counts", async () => {
  const { categories } = (await app.inject({ method: "GET", url: `/api/wikis/${id}/nav` })).json();
  const knowledge = categories.find((c) => c.category === "knowledge");
  expect(knowledge.label).toBe("Knowledge");
  expect(knowledge.facets).toEqual(["area", "atom_type", "subject"]);
  expect(knowledge.count).toBe(4);
  expect(knowledge.hasTopology).toBe(false);
  const names = categories.map((c) => c.category);
  expect(names).toEqual(
    expect.arrayContaining(["knowledge", "self_improvement", "plans", "daily"]),
  );
});

test("GET /nav?archived=1 counts archived leaves in the category total", async () => {
  const { categories } = (
    await app.inject({ method: "GET", url: `/api/wikis/${id}/nav?archived=1` })
  ).json();
  const knowledge = categories.find((c) => c.category === "knowledge");
  expect(knowledge.count).toBe(5);
});

test("GET /nav/:category?archived=1 counts archived leaves in the subtree dir counts", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/nav/knowledge?archived=1` });
  const byName = Object.fromEntries(res.json().dirs.map((d) => [d.name, d]));
  expect(byName.frontend.count).toBe(1);
});

test("GET /nav/:category drills one level, counts subtrees, relabels sentinels", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/nav/knowledge` });
  const { dirs, docs } = res.json();
  expect(docs).toEqual([]);
  const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));
  expect(byName.backend.count).toBe(3);
  expect(byName.frontend.count).toBe(0);
  expect(byName.unscoped.label).toBe("Unspecified");
  expect(byName.backend.label).toBe("Backend");
});

test("GET /nav/:category?path lists active docs at a facet path; archived toggle reveals archived", async () => {
  const active = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/nav/knowledge?path=${encodeURIComponent("backend/decision/architecture")}`,
  });
  const docs = active.json().docs;
  expect(docs.map((d) => d.name).sort()).toEqual(["alpha.md", "beta.md"]);
  const byName = Object.fromEntries(docs.map((d) => [d.name, d]));
  expect(byName["alpha.md"].title).toBe("Alpha Decision");
  expect(byName["alpha.md"].summary.atomType).toBe("decision");
  expect(byName["beta.md"].title).toBe("beta.md");

  const hidden = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/nav/knowledge?path=${encodeURIComponent("frontend/reference/tooling")}`,
  });
  expect(hidden.json().docs).toEqual([]);
  const shown = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/nav/knowledge?path=${encodeURIComponent("frontend/reference/tooling")}&archived=1`,
  });
  expect(shown.json().docs.map((d) => d.name)).toEqual(["delta.md"]);
});

test("navChildren collapses a lone sentinel level and reports the skipped path", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/nav/plans` });
  const body = res.json();
  expect(body.path).toBe("general");
  expect(body.dirs).toEqual([]);
  expect(body.docs.map((d) => d.name)).toEqual(["solo.md"]);
  expect(body.docs[0].title).toBe("Solo Plan");
});

test("path traversal in ?path is refused (stays inside the category)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/nav/knowledge?path=${encodeURIComponent("../self_improvement")}`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ dirs: [], docs: [] });
});

test("GET /docs returns active docs by default and all when archived=1", async () => {
  const active = (
    await app.inject({ method: "GET", url: `/api/wikis/${id}/docs?category=knowledge` })
  ).json();
  const activeNames = active.documents.map((d) => d.name).sort();
  expect(activeNames).toEqual(["alpha.md", "beta.md", "gamma.md", "orphan.md"]);

  const all = (
    await app.inject({ method: "GET", url: `/api/wikis/${id}/docs?category=knowledge&archived=1` })
  ).json();
  expect(all.documents.some((d) => d.name === "delta.md")).toBe(true);
});

test("a leaf with unreadable frontmatter is skipped, the folder listing survives (no 500)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/nav/investigations?path=${encodeURIComponent("security/general")}`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().docs).toEqual([]);
});

test("GET /docs refuses a traversal category instead of walking the filesystem", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/docs?category=${encodeURIComponent("../../../../etc")}`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().documents).toEqual([]);
});

test("GET /titles resolves human titles + active flags, filenames as fallback", async () => {
  const alpha = "knowledge/backend/decision/architecture/alpha.md";
  const beta = "knowledge/backend/decision/architecture/beta.md";
  const archived = "knowledge/frontend/reference/tooling/delta.md";
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/titles?ids=${encodeURIComponent(`${alpha},${beta},${archived}`)}`,
  });
  expect(res.statusCode).toBe(200);
  const { titles } = res.json();
  expect(titles[alpha]).toEqual({ title: "Alpha Decision", active: true });
  expect(titles[beta].title).toBe("beta.md");
  expect(titles[archived].active).toBe(false);
});

test("GET /titles refuses a path-traversal id (returns the basename, never escapes the wiki)", async () => {
  const evil = "../../../../etc/hosts";
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/titles?ids=${encodeURIComponent(evil)}`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().titles[evil].title).toBe("hosts");
});

test("an unknown wiki id is a 404", async () => {
  const res = await app.inject({ method: "GET", url: "/api/wikis/deadbeef/nav" });
  expect(res.statusCode).toBe(404);
});

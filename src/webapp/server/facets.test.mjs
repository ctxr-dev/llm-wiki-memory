import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

function seed(wiki) {
  const write = (rel, subjects) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\nmemory:\n  atom_type: decision\n  subject: [${subjects}]\n  status: active\n---\nbody\n`,
    );
  };
  write("knowledge/backend/decision/architecture/alpha.md", "architecture, kafka");
  write("knowledge/frontend/reference/tooling/beta.md", "tooling, vite");
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

test("GET /facets returns per-facet help meta with the built-in defaults", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/facets` });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(typeof body.meta.area.description).toBe("string");
  expect(body.meta.priority.description).toMatch(/P0/);
});

test("GET /facets lists distinct areas and subject suggestions (vocabulary + in-use)", async () => {
  const body = (await app.inject({ method: "GET", url: `/api/wikis/${id}/facets` })).json();
  expect(body.areas).toEqual(expect.arrayContaining(["backend", "frontend"]));
  expect(body.subjects).toEqual(
    expect.arrayContaining(["architecture", "kafka", "tooling", "vite"]),
  );
});

test("an unknown wiki id is a 404", async () => {
  const res = await app.inject({ method: "GET", url: "/api/wikis/deadbeef/facets" });
  expect(res.statusCode).toBe(404);
});

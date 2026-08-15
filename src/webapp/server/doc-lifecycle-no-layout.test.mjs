import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

const DIR = "issues/JIRA/DEV/134/9/6";
const LEAF = "DEV-134096-cleanup.plan.md";

let app;
let db;
let dataDir;
let id;

beforeAll(async () => {
  const workspace = setupWorkspace({ template: "tracker-issues" });
  dataDir = workspace.dataDir;
  const abs = path.join(workspace.wiki, ...`${DIR}/pending/${LEAF}`.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "---\nfocus: cleanup\nmemory:\n  status: active\n---\nA cleanup plan.\n");
  fs.writeFileSync(path.join(workspace.wiki, ".layout", "layout.yaml"), "not_a_layout: true\n");
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

const getDoc = (docId) => app.inject({ method: "GET", url: `/api/wikis/${id}/doc/${docId}` });

test("an exact hit still resolves when the layout cannot be read", async () => {
  const res = await getDoc(`${DIR}/pending/${LEAF}`);
  expect(res.statusCode).toBe(200);
  expect(res.json().id).toBe(`${DIR}/pending/${LEAF}`);
});

test("a stale lifecycle id is refused when the layout cannot be read, not cross-resolved", async () => {
  const res = await getDoc(`${DIR}/in-progress/${LEAF}`);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "no-such-doc" });
});

import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";
import { groupPlans, groupIssues } from "./boards.mjs";

test("groupPlans buckets by status in lifecycle order with a pending fallback", () => {
  const columns = groupPlans([
    { status: "done" },
    { status: "pending" },
    { status: "weird" },
    { status: "in-progress" },
  ]);
  expect(columns.map((c) => c.key)).toEqual(["pending", "in-progress", "done", "archived"]);
  expect(columns[0].cards.length).toBe(2);
  expect(columns[1].cards.length).toBe(1);
  expect(columns[2].cards.length).toBe(1);
});

test("groupIssues places plans in lifecycle columns and everything else in facts", () => {
  const columns = groupIssues([
    { kind: "plan", lifecycle: "in-progress" },
    { kind: "knowledge" },
    { kind: "plan", lifecycle: "done" },
    { kind: "plan", lifecycle: "bogus" },
  ]);
  const byKey = Object.fromEntries(columns.map((c) => [c.key, c.cards.length]));
  expect(byKey["in-progress"]).toBe(1);
  expect(byKey["done"]).toBe(1);
  expect(byKey["facts"]).toBe(2);
});

function seed(wiki) {
  const writeLeaf = (rel, status, progress) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\nfocus: ${path.basename(rel, ".md")}\nstatus: ${status}\nprogress: "${progress}"\nmemory:\n  atom_type: plan\n  status: active\n  area: backend\n  subject:\n    - architecture\n---\nPlan body.\n`,
    );
  };
  writeLeaf("plans/backend/architecture/alpha.md", "pending", "0/3");
  writeLeaf("plans/backend/architecture/beta.md", "in-progress", "2/5");
  writeLeaf("plans/backend/architecture/gamma.md", "done", "5/5");
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

test("GET /plans groups plan leaves into lifecycle columns with progress", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/plans` });
  expect(res.statusCode).toBe(200);
  const columns = res.json().columns;
  const byKey = Object.fromEntries(columns.map((c) => [c.key, c.cards]));
  expect(byKey.pending.map((c) => c.name)).toContain("alpha.md");
  expect(byKey["in-progress"][0].progress).toBe("2/5");
  expect(byKey.done.map((c) => c.name)).toContain("gamma.md");
});

test("GET /issues reports hasIssues:false when the layout has no issues topology", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/issues` });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ hasIssues: false, columns: [] });
});

import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

const KDIR = "knowledge/backend/decision/architecture";
const LESSON = "self_improvement/backend/review/architecture/lesson.md";
const PLAN = "plans/backend/architecture/myplan.md";

function seed(wiki) {
  const writeLeaf = (rel, frontmatter, body) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `---\n${frontmatter}---\n${body}\n`);
  };
  const knowledge = (name) =>
    `focus: ${name}\nmemory:\n  atom_type: decision\n  status: active\n  area: backend\n  subject:\n    - architecture\n`;
  for (const name of ["editbody", "relocate", "archive", "vocab", "prio"]) {
    writeLeaf(`${KDIR}/${name}.md`, knowledge(name), `${name} body.`);
  }
  writeLeaf(
    LESSON,
    `focus: lesson\nmemory:\n  atom_type: self-improvement-lesson\n  status: active\n  area: backend\n  task_type: review\n  subject:\n    - architecture\n`,
    "A lesson body.",
  );
  writeLeaf(
    PLAN,
    `focus: myplan\nstatus: archived\nprogress: "3/5"\nmemory:\n  atom_type: plan\n  status: active\n  area: backend\n  subject:\n    - architecture\n`,
    "Plan body.",
  );
}

let app;
let db;
let dataDir;
let id;
const get = (docId) => app.inject({ method: "GET", url: `/api/wikis/${id}/doc/${docId}` });

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

test("PUT edits the body through the engine (re-read reflects it)", async () => {
  const docId = `${KDIR}/editbody.md`;
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${docId}`,
    payload: { body: "Rewritten body here." },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(true);
  expect((await get(docId)).json().body).toContain("Rewritten body here.");
});

test("changing a placement facet relocates the leaf and returns the new id", async () => {
  const docId = `${KDIR}/relocate.md`;
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${docId}`,
    payload: { memory: { area: "frontend" } },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.relocatedFrom).toBe(docId);
  expect(body.id).not.toBe(docId);
  expect(body.id.startsWith("knowledge/frontend/")).toBe(true);
  expect((await get(body.id)).statusCode).toBe(200);
});

test("a self_improvement edit without userRequested is refused (403 write-gate)", async () => {
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${LESSON}`,
    payload: { body: "sneaky edit" },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json().error).toBe("write-gate-refused");
});

test("a self_improvement edit WITH userRequested is allowed", async () => {
  const docId = LESSON;
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${docId}`,
    payload: { body: "an approved lesson update", userRequested: true },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().ok).toBe(true);
});

test("an out-of-vocabulary atom_type is rejected (422)", async () => {
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${KDIR}/vocab.md`,
    payload: { memory: { atom_type: "totally-bogus" } },
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error).toBe("invalid-metadata");
});

test("priority P0 is coerced to P1 without consent", async () => {
  const docId = `${KDIR}/prio.md`;
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${docId}`,
    payload: { memory: { priority: "P0" } },
  });
  expect(res.statusCode).toBe(200);
  expect((await get(docId)).json().memory.priority).toBe("P1");
});

test("archive hides the doc from active reads; restore brings it back", async () => {
  const docId = `${KDIR}/archive.md`;
  const archived = await app.inject({
    method: "POST",
    url: `/api/wikis/${id}/archive/${docId}`,
    payload: { archive: true },
  });
  expect(archived.json().status).toBe("archived");
  expect((await get(docId)).json().active).toBe(false);
  const restored = await app.inject({
    method: "POST",
    url: `/api/wikis/${id}/archive/${docId}`,
    payload: { archive: false },
  });
  expect(restored.json().status).toBe("active");
  expect((await get(docId)).json().active).toBe(true);
});

test("create makes a new leaf in a facet category", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/wikis/${id}/create`,
    payload: {
      category: "knowledge",
      name: "brand-new-note.md",
      title: "Brand New Note",
      body: "Fresh content.",
      memory: { area: "infra", atom_type: "reference" },
    },
  });
  expect(res.statusCode).toBe(200);
  const created = res.json();
  expect(created.ok).toBe(true);
  expect(created.id.startsWith("knowledge/infra/")).toBe(true);
  expect((await get(created.id)).json().body).toContain("Fresh content.");
});

test("create in an unknown category is a 404", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/wikis/${id}/create`,
    payload: { category: "nonexistent", name: "x.md" },
  });
  expect(res.statusCode).toBe(404);
});

test("editing a plans-leaf body preserves its top-level lifecycle status/progress", async () => {
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${PLAN}`,
    payload: { body: "Rewritten plan content." },
  });
  expect(res.statusCode).toBe(200);
  const doc = (await get(PLAN)).json();
  expect(doc.body).toContain("Rewritten plan content.");
  expect(doc.frontmatter.status).toBe("archived");
  expect(doc.frontmatter.progress).toBe("3/5");
});

test("PUT refuses a path-traversal docId (404)", async () => {
  const res = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/doc/${encodeURIComponent("../../../../etc/passwd")}`,
    payload: { body: "x" },
  });
  expect(res.statusCode).toBe(404);
});

import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

function seed(wiki) {
  const write = (rel, body) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\nfocus: ${path.basename(rel, ".md")}\nmemory:\n  atom_type: decision\n  status: active\n  subject:\n    - architecture\n---\n${body}\n`,
    );
  };
  write("knowledge/backend/decision/architecture/kafka.md", "We chose Kafka for the event bus.");
  write("knowledge/backend/decision/architecture/queue.md", "Kafka topics and event streaming.");
  write("knowledge/backend/decision/observability/tracing.md", "Distributed tracing with spans.");
}

let app;
let db;
let dataDir;
let id;
const DOC = "knowledge/backend/decision/architecture/kafka.md";

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

test("GET /doc/* returns the split frontmatter, memory block, and body", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/doc/${DOC}` });
  expect(res.statusCode).toBe(200);
  const doc = res.json();
  expect(doc.id).toBe(DOC);
  expect(doc.name).toBe("kafka.md");
  expect(doc.category).toBe("knowledge");
  expect(doc.body).toContain("We chose Kafka");
  expect(doc.body).not.toContain("---");
  expect(doc.memory.atom_type).toBe("decision");
  expect(doc.memory.subject).toEqual(["architecture"]);
  expect(doc.frontmatter.focus).toBe("kafka");
  expect(doc.active).toBe(true);
});

test("GET /doc/* is 404 for a missing document", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/doc/knowledge/backend/decision/architecture/ghost.md`,
  });
  expect(res.statusCode).toBe(404);
});

test("GET /doc/* refuses a path-traversal id (404, never escapes the wiki root)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/doc/${encodeURIComponent("../../../../etc/passwd")}`,
  });
  expect(res.statusCode).toBe(404);
});

test("GET /related/* ranks other docs by similarity and never includes the source", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/related/${DOC}` });
  expect(res.statusCode).toBe(200);
  const { related } = res.json();
  expect(Array.isArray(related)).toBe(true);
  expect(related.some((r) => r.id === DOC)).toBe(false);
  for (const entry of related) {
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.score).toBe("number");
    expect(typeof entry.title).toBe("string");
    expect(typeof entry.location).toBe("string");
  }
  const queue = related.find((r) => r.id.endsWith("queue.md"));
  expect(queue).toBeTruthy();
  expect(queue.title).toBe("queue");
  expect(queue.location).toBe("Knowledge › Backend › Decision › Architecture");
  expect(queue.summary.atomType).toBe("decision");
});

test("prefs round-trip per wiki (tabs persistence)", async () => {
  const before = await app.inject({ method: "GET", url: `/api/wikis/${id}/prefs/openTabs` });
  expect(before.json().value).toBe(null);
  const put = await app.inject({
    method: "PUT",
    url: `/api/wikis/${id}/prefs/openTabs`,
    payload: { value: JSON.stringify([DOC]) },
  });
  expect(put.statusCode).toBe(200);
  const after = await app.inject({ method: "GET", url: `/api/wikis/${id}/prefs/openTabs` });
  expect(JSON.parse(after.json().value)).toEqual([DOC]);
});

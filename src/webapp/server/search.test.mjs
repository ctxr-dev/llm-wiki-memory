import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

function seed(wiki) {
  const write = (rel, body) => {
    const abs = path.join(wiki, ...rel.split("/"));
    const area = rel.split("/")[1];
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\nfocus: ${path.basename(rel, ".md")}\nmemory:\n  atom_type: decision\n  area: ${area}\n  status: active\n---\n${body}\n`,
    );
  };
  write(
    "knowledge/backend/decision/architecture/kafka.md",
    "We chose Kafka for durable event streaming and topics.",
  );
  write(
    "knowledge/backend/decision/architecture/postgres.md",
    "Postgres is our relational database of record.",
  );
  write(
    "knowledge/frontend/decision/architecture/react.md",
    "The UI is built with React and Vite components.",
  );
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

test("search ranks the matching doc first and returns a snippet + score", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/search?q=${encodeURIComponent("kafka streaming topics")}`,
  });
  expect(res.statusCode).toBe(200);
  const { results } = res.json();
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].name).toBe("kafka.md");
  expect(results[0].title).toBe("kafka");
  expect(results[0].location).toBe("Knowledge › Backend › Decision › Architecture");
  expect(results[0].snippet).toContain("Kafka");
  expect(typeof results[0].score).toBe("number");
});

test("a search snippet is centered on the matched term", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/search?q=${encodeURIComponent("streaming")}`,
  });
  const kafka = res.json().results.find((r) => r.name === "kafka.md");
  expect(kafka.snippet).toContain("streaming");
});

test("a facet filter narrows search to matching leaves", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/search?q=${encodeURIComponent("database architecture")}&area=frontend`,
  });
  const { results } = res.json();
  expect(results.length).toBe(1);
  expect(results[0].name).toBe("react.md");
  expect(results[0].location).toContain("Frontend");
});

test("filters alone (no free text) still narrow to the matching leaves", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/search?q=&area=backend`,
  });
  const names = res
    .json()
    .results.map((r) => r.name)
    .sort();
  expect(names).toEqual(["kafka.md", "postgres.md"]);
});

test("an empty query returns no results", async () => {
  const res = await app.inject({ method: "GET", url: `/api/wikis/${id}/search?q=` });
  expect(res.json().results).toEqual([]);
});

test("scope=all federates and tags each result with its wiki", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/search?q=${encodeURIComponent("react vite components")}&scope=all`,
  });
  const { results } = res.json();
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].name).toBe("react.md");
  expect(results[0].wikiId).toBe(id);
});

test("ask returns a top answer plus ranked sources", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/wikis/${id}/ask?q=${encodeURIComponent("postgres relational database")}`,
  });
  const body = res.json();
  expect(body.answer).not.toBeNull();
  expect(body.answer.name).toBe("postgres.md");
  expect(body.answer.title).toBe("postgres");
  expect(body.answer.content).toContain("Postgres");
  expect(body.sources.length).toBeGreaterThan(0);
});

test("an unknown wiki id is a 404", async () => {
  const res = await app.inject({ method: "GET", url: "/api/wikis/deadbeef/search?q=x" });
  expect(res.statusCode).toBe(404);
});

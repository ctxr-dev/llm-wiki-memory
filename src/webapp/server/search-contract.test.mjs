import { test, beforeAll, afterAll, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";
import { SearchResultsSchema, SearchResultSchema, AskResponseSchema } from "../shared/contract.mjs";

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
  write("knowledge/backend/decision/architecture/kafka.md", "Kafka for durable event streaming.");
  write("knowledge/backend/decision/architecture/postgres.md", "Postgres relational database.");
  write("knowledge/frontend/decision/architecture/react.md", "React and Vite build the UI.");
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
  db = openAppDb(path.join(dataDir, "webapp-contract-test", "app.sqlite"));
  app = buildApp({ db });
  await app.ready();
  id = (await app.inject({ method: "GET", url: "/api/wikis" })).json().wikis[0].id;
});

afterAll(async () => {
  if (app) await app.close();
  if (db) db.close();
  if (dataDir) cleanup(dataDir);
});

const searchUrl = (q, extra = "") => `/api/wikis/${id}/search?q=${encodeURIComponent(q)}${extra}`;
const askUrl = (q) => `/api/wikis/${id}/ask?q=${encodeURIComponent(q)}`;

const searchCases = [
  ["free-text match", () => searchUrl("kafka streaming")],
  ["no-match free text", () => searchUrl("zzz-nonexistent-term-qqq")],
  ["empty query", () => searchUrl("")],
  ["single facet filter", () => searchUrl("database", "&area=backend")],
  ["filters only, no free text", () => searchUrl("", "&area=backend")],
  ["category filter", () => searchUrl("architecture", "&category=knowledge")],
  ["special characters in query", () => searchUrl('kafka & "topics" <x>')],
  ["scope=all federation", () => searchUrl("react vite", "&scope=all")],
];

for (const [label, url] of searchCases) {
  test(`search response conforms to the shared contract: ${label}`, async () => {
    const res = await app.inject({ method: "GET", url: url() });
    expect(res.statusCode).toBe(200);
    const parsed = SearchResultsSchema.safeParse(res.json());
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
  });
}

test("scope=all tags each result with a contract-valid wikiId + wikiLabel", async () => {
  const res = await app.inject({ method: "GET", url: searchUrl("react vite", "&scope=all") });
  const { results } = SearchResultsSchema.parse(res.json());
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(typeof r.wikiId).toBe("string");
    expect(typeof r.wikiLabel).toBe("string");
    expect(r.wikiId).toBe(id);
  }
});

test("a single-wiki search result carries NO wikiId/wikiLabel (optional, absent)", async () => {
  const res = await app.inject({ method: "GET", url: searchUrl("kafka") });
  const { results } = SearchResultsSchema.parse(res.json());
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].wikiId).toBeUndefined();
  expect(results[0].wikiLabel).toBeUndefined();
});

test("every search result field has the contract-required type (per-record parse)", async () => {
  const res = await app.inject({ method: "GET", url: searchUrl("kafka postgres react") });
  const { results } = SearchResultsSchema.parse(res.json());
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(() => SearchResultSchema.parse(r)).not.toThrow();
  }
});

test("ask response conforms to the shared contract: match", async () => {
  const res = await app.inject({ method: "GET", url: askUrl("postgres relational database") });
  expect(res.statusCode).toBe(200);
  const parsed = AskResponseSchema.safeParse(res.json());
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error?.issues)).toBe(true);
  expect(parsed.data.answer).not.toBeNull();
  expect(parsed.data.sources.length).toBeGreaterThan(0);
});

test("ask response conforms to the shared contract: empty query -> null answer, no sources", async () => {
  const res = await app.inject({ method: "GET", url: askUrl("") });
  const parsed = AskResponseSchema.parse(res.json());
  expect(parsed.answer).toBeNull();
  expect(parsed.sources).toEqual([]);
});

test("ask sources are each a contract-valid SearchResult", async () => {
  const res = await app.inject({ method: "GET", url: askUrl("kafka streaming") });
  const { sources } = AskResponseSchema.parse(res.json());
  for (const s of sources) {
    expect(() => SearchResultSchema.parse(s)).not.toThrow();
  }
});

test("search on an unknown wiki id is a 404 (not a malformed 200)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/wikis/deadbeef/search?q=x" });
  expect(res.statusCode).toBe(404);
});

test("ask on an unknown wiki id is a 404", async () => {
  const res = await app.inject({ method: "GET", url: "/api/wikis/deadbeef/ask?q=x" });
  expect(res.statusCode).toBe(404);
});

import { test, beforeAll, afterAll, expect } from "vitest";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

let app;
let dataDir;

beforeAll(async () => {
  ({ dataDir } = setupWorkspace());
  const { buildApp } = await import("./index.mjs");
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (dataDir) cleanup(dataDir);
});

test("GET /api/health returns get_memory_config-shaped data via the in-process engine", async () => {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.wikiRoot).toBe("string");
  expect(body.embedBackend).toBe("lexical");
  expect(body.categories.length).toBeGreaterThan(0);
  expect(body.levels[0].depth).toBe(0);
});

test("the payload validates against the shared zod contract", async () => {
  const { HealthSchema } = await import("../shared/contract.mjs");
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(() => HealthSchema.parse(res.json())).not.toThrow();
});

test("an unknown /api route 404s rather than falling through to the SPA", async () => {
  const res = await app.inject({ method: "GET", url: "/api/nope" });
  expect(res.statusCode).toBe(404);
});

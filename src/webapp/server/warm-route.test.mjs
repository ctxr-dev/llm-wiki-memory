/**
 * A "Warm now" affordance for the partial-results banner.
 *
 * This is NOT a new capability, which is why it is safe to expose: the daemon already calls
 * warmWikiEmbeddings at boot (warmHomeWikiGradually) and warmWikiEmbeddingsIfDue on a timer, and
 * warms are serialised across processes by state/.embed-warm.lock. The prohibition in
 * docs/embeddings.md ("the warm never warms from the MCP server itself: N connected clients would
 * mean N concurrent warms") names the MCP server — one daemon with one button is the opposite case.
 *
 * Two properties matter and both are asserted: the request RETURNS IMMEDIATELY (a cold warm is
 * ~90s duty-cycled, so awaiting it would hang the browser), and a double-click cannot start two.
 */

import { test, beforeAll, afterAll, expect } from "vitest";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";

let app;
let db;
let dataDir;
let id;

beforeAll(async () => {
  const workspace = setupWorkspace();
  dataDir = workspace.dataDir;
  const { openAppDb } = await import("./app-db.mjs");
  const { buildApp } = await import("./index.mjs");
  db = openAppDb(path.join(dataDir, "webapp-warm-test", "app.sqlite"));
  app = buildApp({ db });
  await app.ready();
  const list = await app.inject({ method: "GET", url: "/api/wikis" });
  id = list.json().wikis?.[0]?.id;
});

afterAll(async () => {
  await app?.close();
  db?.close?.();
  cleanup(dataDir);
});

test("POST /warm returns immediately rather than awaiting a ~90s warm", async () => {
  const started = Date.now();
  const res = await app.inject({ method: "POST", url: `/api/wikis/${id}/warm` });
  const elapsed = Date.now() - started;
  expect(res.statusCode).toBe(202);
  expect(res.json().started).toBe(true);
  /** Generous, but far below a real warm: this asserts "did not await", not a latency budget. */
  expect(elapsed).toBeLessThan(5000);
});

test("a second POST while one is in flight does NOT start another", async () => {
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: `/api/wikis/${id}/warm` }),
    app.inject({ method: "POST", url: `/api/wikis/${id}/warm` }),
  ]);
  const started = [a.json().started, b.json().started].filter(Boolean).length;
  expect(started).toBeLessThanOrEqual(1);
  const refused = [a.json(), b.json()].find((j) => j.started === false);
  if (refused) expect(refused.reason).toBe("already-running");
});

test("an unknown wiki id is a 404, not a silent no-op", async () => {
  const res = await app.inject({ method: "POST", url: "/api/wikis/does-not-exist/warm" });
  expect(res.statusCode).toBe(404);
});

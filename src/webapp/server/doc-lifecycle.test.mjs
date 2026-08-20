/**
 * Resolution of a plan id whose lifecycle folder is STALE — the reference was written while
 * the plan sat under a different state — plus the containment guard the retry runs under.
 * Kept apart from doc.test.mjs (which covers the plain document / related / prefs routes) so
 * each file states one concern and stays inside the max-lines budget.
 */

import { test, beforeAll, afterAll, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup } from "../../../test/harness.mjs";
import { PLAN_STATES } from "./plan-lifecycle.mjs";

vi.mock("./plan-lifecycle.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, lifecycleCandidateIds: vi.fn(actual.lifecycleCandidateIds) };
});

const ISSUE_DIR = "issues/JIRA/DEV/134/9/6";
const ISSUE_PLAN = "DEV-134096-vulnerabilities-cleanup.plan.md";
const MATRIX_DIR = {
  pending: "issues/JIRA/DEV/210/0/0",
  "in-progress": "issues/JIRA/DEV/220/0/0",
  done: "issues/JIRA/DEV/230/0/0",
  archived: "issues/JIRA/DEV/240/0/0",
};
const MATRIX_PLAN = "DEV-000000-matrix.plan.md";
const NEG_DIR = "issues/JIRA/DEV/280/0/0";
const ESCAPING_PLAN = "issues/../../done/evil.plan.md";

function seed(wiki) {
  const write = (rel, body) => {
    const abs = path.join(wiki, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      `---\nfocus: ${path.basename(rel, ".md")}\nmemory:\n  atom_type: decision\n  status: active\n---\n${body}\n`,
    );
  };
  write(`${ISSUE_DIR}/pending/${ISSUE_PLAN}`, "Vulnerability cleanup, still pending.");
  for (const state of PLAN_STATES) {
    write(`${MATRIX_DIR[state]}/${state}/${MATRIX_PLAN}`, `Matrix plan really under ${state}.`);
  }
  write("issues/JIRA/DEV/250/0/0/pending/DEV-250000-dupe.plan.md", "Dupe under pending.");
  write("issues/JIRA/DEV/250/0/0/done/DEV-250000-dupe.plan.md", "Dupe under done.");
  write("issues/JIRA/DEV/260/0/0/in-progress/DEV-260000-order.plan.md", "Order under in-progress.");
  write("issues/JIRA/DEV/260/0/0/done/DEV-260000-order.plan.md", "Order under done.");
  write("issues/JIRA/DEV/260/0/0/archived/DEV-260000-order.plan.md", "Order under archived.");
  write("issues/JIRA/DEV/270/0/0/pending/DEV-270000.md", "A knowledge leaf, not a plan.");
  write(`${NEG_DIR}/pending/done-notes.md`, "Notes whose name merely contains a state word.");
  write(`${NEG_DIR}/pending/ghost.plan.md`, "A plan under a real lifecycle folder.");
  write(`${NEG_DIR}/pending-review/beta.plan.md`, "A plan under a folder that is not a state.");
  write(`${NEG_DIR}/architecture/alpha.plan.md`, "A plan with no lifecycle segment at all.");
  write("plans/infra/pending/deploy.plan.md", "A facet-placed plan whose subject is pending.");
  write("plans/infra/done/deploy.plan.md", "A different facet-placed plan whose subject is done.");
}

/**
 * A REAL leaf outside the wiki root, placed so the first lifecycle candidate of ESCAPING_PLAN
 * (`../pending/evil.plan.md`) lands exactly on it. Only the containment check keeps it unread,
 * so a 404 for that id is evidence about the guard rather than about a missing file — which is
 * all an absent target could ever have proved.
 * @param {string} dir
 * @returns {string}
 */
function plantOutsideWikiRoot(dir) {
  const abs = path.join(dir, "pending", "evil.plan.md");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "---\nfocus: evil\n---\nA leaf that lives outside the wiki root.\n");
  return abs;
}

let app;
let db;
let dataDir;
let id;
let plantedLeaf;

beforeAll(async () => {
  const workspace = setupWorkspace({ template: "tracker-issues" });
  dataDir = workspace.dataDir;
  seed(workspace.wiki);
  plantedLeaf = plantOutsideWikiRoot(dataDir);
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

test("an exact hit wins and never consults the lifecycle fallback", async () => {
  const { lifecycleCandidateIds } = await import("./plan-lifecycle.mjs");
  lifecycleCandidateIds.mockClear();
  const res = await getDoc(`${ISSUE_DIR}/pending/${ISSUE_PLAN}`);
  expect(res.statusCode).toBe(200);
  expect(res.json().id).toBe(`${ISSUE_DIR}/pending/${ISSUE_PLAN}`);
  expect(lifecycleCandidateIds).not.toHaveBeenCalled();
});

test("a miss does consult the lifecycle fallback (positive control for the spy)", async () => {
  const { lifecycleCandidateIds } = await import("./plan-lifecycle.mjs");
  lifecycleCandidateIds.mockClear();
  await getDoc(`${ISSUE_DIR}/in-progress/${ISSUE_PLAN}`);
  expect(lifecycleCandidateIds).toHaveBeenCalledWith(`${ISSUE_DIR}/in-progress/${ISSUE_PLAN}`);
});

test("the real corpus case: a stale in-progress reference serves the pending leaf", async () => {
  const res = await getDoc(`${ISSUE_DIR}/in-progress/${ISSUE_PLAN}`);
  expect(res.statusCode).toBe(200);
  const doc = res.json();
  expect(doc.id).toBe(`${ISSUE_DIR}/pending/${ISSUE_PLAN}`);
  expect(doc.name).toBe(ISSUE_PLAN);
  expect(doc.category).toBe("issues");
  expect(doc.body).toContain("still pending");
});

test("a substituted answer declares the id that was asked for", async () => {
  const stale = `${ISSUE_DIR}/in-progress/${ISSUE_PLAN}`;
  const doc = (await getDoc(stale)).json();
  expect(doc.requestedId).toBe(stale);
  expect(doc.id).toBe(`${ISSUE_DIR}/pending/${ISSUE_PLAN}`);
});

test("an exact hit carries no requestedId, so the field alone marks a substitution", async () => {
  expect((await getDoc(`${ISSUE_DIR}/pending/${ISSUE_PLAN}`)).json().requestedId).toBeUndefined();
});

test("the corrected id round-trips as an exact hit, so the client converges", async () => {
  const corrected = (await getDoc(`${ISSUE_DIR}/in-progress/${ISSUE_PLAN}`)).json().id;
  const again = await getDoc(corrected);
  expect(again.statusCode).toBe(200);
  expect(again.json().id).toBe(corrected);
  expect(again.json().requestedId).toBeUndefined();
});

test("every stale state resolves to every real state and returns the real id", async () => {
  for (const real of PLAN_STATES) {
    const realId = `${MATRIX_DIR[real]}/${real}/${MATRIX_PLAN}`;
    expect((await getDoc(realId)).json().id).toBe(realId);
    for (const stale of PLAN_STATES.filter((state) => state !== real)) {
      const res = await getDoc(`${MATRIX_DIR[real]}/${stale}/${MATRIX_PLAN}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(realId);
      expect(res.json().body).toContain(`really under ${real}`);
    }
  }
});

test("two lifecycle copies resolve in the documented pending-first order", async () => {
  const dupe = "issues/JIRA/DEV/250/0/0";
  for (const stale of ["in-progress", "archived"]) {
    const requested = `${dupe}/${stale}/DEV-250000-dupe.plan.md`;
    const res = await getDoc(requested);
    expect(res.json().id).toBe(`${dupe}/pending/DEV-250000-dupe.plan.md`);
    expect(res.json().body).toContain("Dupe under pending");
    expect(res.json().requestedId).toBe(requested);
  }
  expect((await getDoc(`${dupe}/done/DEV-250000-dupe.plan.md`)).json().id).toBe(
    `${dupe}/done/DEV-250000-dupe.plan.md`,
  );
});

test("with pending absent, the order falls through to in-progress", async () => {
  const res = await getDoc("issues/JIRA/DEV/260/0/0/pending/DEV-260000-order.plan.md");
  expect(res.json().id).toBe("issues/JIRA/DEV/260/0/0/in-progress/DEV-260000-order.plan.md");
});

test("a non-plan leaf under a lifecycle folder gets no fallback", async () => {
  expect((await getDoc("issues/JIRA/DEV/270/0/0/in-progress/DEV-270000.md")).statusCode).toBe(404);
  expect((await getDoc(`${NEG_DIR}/in-progress/done-notes.md`)).statusCode).toBe(404);
});

test("an id with no lifecycle segment gets no fallback", async () => {
  expect((await getDoc(`${NEG_DIR}/design/alpha.plan.md`)).statusCode).toBe(404);
  expect((await getDoc(`${NEG_DIR}/architecture/alpha.plan.md`)).statusCode).toBe(200);
});

test("a folder merely containing a state word is not a lifecycle segment", async () => {
  expect((await getDoc(`${NEG_DIR}/pending-review/ghost.plan.md`)).statusCode).toBe(404);
  expect((await getDoc(`${NEG_DIR}/pending/beta.plan.md`)).statusCode).toBe(404);
  expect((await getDoc(`${NEG_DIR}/pending-review/beta.plan.md`)).statusCode).toBe(200);
});

test("a facet-placed category never cross-resolves its lifecycle-shaped folders", async () => {
  const { lifecycleCandidateIds } = await import("./plan-lifecycle.mjs");
  lifecycleCandidateIds.mockClear();
  const res = await getDoc("plans/infra/in-progress/deploy.plan.md");
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "no-such-doc" });
  expect(lifecycleCandidateIds).not.toHaveBeenCalled();
});

test("two same-named plans under state-shaped subject folders stay distinct documents", async () => {
  const pending = await getDoc("plans/infra/pending/deploy.plan.md");
  const done = await getDoc("plans/infra/done/deploy.plan.md");
  expect(pending.json().body).toContain("subject is pending");
  expect(done.json().body).toContain("subject is done");
  expect(pending.json().requestedId).toBeUndefined();
});

test("a plan that exists under no lifecycle folder is still 404 no-such-doc", async () => {
  const res = await getDoc("issues/JIRA/DEV/999/9/9/in-progress/DEV-999999-nope.plan.md");
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "no-such-doc" });
});

test("a traversal-shaped plan id is refused by the containment check, not resolved", async () => {
  const evil = encodeURIComponent("issues/../../../../etc/pending/passwd.plan.md");
  const res = await getDoc(evil);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "no-such-doc" });
});

test("a lifecycle candidate that escapes the wiki root is refused even though it exists", async () => {
  expect(fs.existsSync(plantedLeaf)).toBe(true);
  const res = await getDoc(encodeURIComponent(ESCAPING_PLAN));
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "no-such-doc" });
});

test("a candidate whose category segment would change is dropped by the gate", async () => {
  const { lifecycleCandidatesFor } = await import("./doc.mjs");
  const engine = /** @type {any} */ ({
    layout: { categoryHasTopology: (category) => category === "done" },
    identity: { categoryOfId: (docId) => docId.split("/")[0] },
  });
  expect(lifecycleCandidatesFor(engine, "done/JIRA/DEV/plan.plan.md")).toEqual([]);
  expect(lifecycleCandidatesFor(engine, "done/JIRA/pending/plan.plan.md")).toEqual([
    "done/JIRA/in-progress/plan.plan.md",
    "done/JIRA/done/plan.plan.md",
    "done/JIRA/archived/plan.plan.md",
  ]);
});

test("the escaping candidate is the one the fallback would have read", async () => {
  const { lifecycleCandidateIds } = await import("./plan-lifecycle.mjs");
  const candidates = /** @type {string[]} */ (lifecycleCandidateIds(ESCAPING_PLAN));
  expect(candidates[0]).toBe("issues/../../pending/evil.plan.md");
  expect(path.resolve(dataDir, "wiki", candidates[0])).toBe(plantedLeaf);
});

import { test, expect } from "vitest";
import { PLAN_STATES, lifecycleCandidateIds } from "./plan-lifecycle.mjs";

const DIR = "issues/JIRA/DEV/134/9/6";
const LEAF = "DEV-134096-vulnerabilities-cleanup.plan.md";

test("PLAN_STATES is the canonical lifecycle order", () => {
  expect(PLAN_STATES).toEqual(["pending", "in-progress", "done", "archived"]);
});

test("each state as the stale segment yields the other three, in PLAN_STATES order", () => {
  for (const stale of PLAN_STATES) {
    const candidates = lifecycleCandidateIds(`${DIR}/${stale}/${LEAF}`);
    expect(candidates).toEqual(
      PLAN_STATES.filter((state) => state !== stale).map((state) => `${DIR}/${state}/${LEAF}`),
    );
  }
});

test("every other state is reachable as the real one from any stale state", () => {
  for (const stale of PLAN_STATES) {
    const candidates = lifecycleCandidateIds(`${DIR}/${stale}/${LEAF}`);
    for (const real of PLAN_STATES.filter((state) => state !== stale)) {
      expect(candidates).toContain(`${DIR}/${real}/${LEAF}`);
    }
    expect(candidates).not.toContain(`${DIR}/${stale}/${LEAF}`);
    expect(candidates).toHaveLength(3);
  }
});

test("the real corpus case: an in-progress reference offers the pending leaf first", () => {
  expect(lifecycleCandidateIds(`${DIR}/in-progress/${LEAF}`)[0]).toBe(`${DIR}/pending/${LEAF}`);
});

test("a leaf that is not a .plan.md gets no candidates", () => {
  expect(lifecycleCandidateIds(`${DIR}/pending/DEV-134096.md`)).toEqual([]);
  expect(lifecycleCandidateIds(`${DIR}/pending/index.md`)).toEqual([]);
  expect(lifecycleCandidateIds(`${DIR}/pending/notes.plan.txt`)).toEqual([]);
  expect(lifecycleCandidateIds(`${DIR}/pending/plan.md`)).toEqual([]);
});

test("an id with no lifecycle segment gets no candidates", () => {
  expect(lifecycleCandidateIds("plans/backend/architecture/alpha.plan.md")).toEqual([]);
  expect(lifecycleCandidateIds(`${DIR}/${LEAF}`)).toEqual([]);
});

test("a lifecycle word that is not a whole path segment is not a lifecycle segment", () => {
  expect(lifecycleCandidateIds("plans/backend/pending-review/alpha.plan.md")).toEqual([]);
  expect(lifecycleCandidateIds("plans/backend/pre-done/alpha.plan.md")).toEqual([]);
  expect(lifecycleCandidateIds("plans/backend/architecture/done-notes.md")).toEqual([]);
  expect(lifecycleCandidateIds("plans/backend/architecture/done-notes.plan.md")).toEqual([]);
  expect(lifecycleCandidateIds("plans/backend/architecture/archived.plan.md")).toEqual([]);
});

test("the filename is never mistaken for the lifecycle segment", () => {
  expect(lifecycleCandidateIds("plans/backend/done.plan.md")).toEqual([]);
});

test("the deepest lifecycle segment is the one swapped", () => {
  expect(lifecycleCandidateIds("plans/done/backend/pending/alpha.plan.md")).toEqual([
    "plans/done/backend/in-progress/alpha.plan.md",
    "plans/done/backend/done/alpha.plan.md",
    "plans/done/backend/archived/alpha.plan.md",
  ]);
});

test("degenerate ids are handled without throwing", () => {
  expect(lifecycleCandidateIds("")).toEqual([]);
  expect(lifecycleCandidateIds("alpha.plan.md")).toEqual([]);
  expect(lifecycleCandidateIds("pending")).toEqual([]);
  expect(lifecycleCandidateIds(undefined)).toEqual([]);
  expect(lifecycleCandidateIds(null)).toEqual([]);
});

test("a traversal-shaped id keeps its traversal, so containment must still gate it", () => {
  const candidates = lifecycleCandidateIds("issues/../../../etc/pending/evil.plan.md");
  expect(candidates).toEqual([
    "issues/../../../etc/in-progress/evil.plan.md",
    "issues/../../../etc/done/evil.plan.md",
    "issues/../../../etc/archived/evil.plan.md",
  ]);
});

test("candidates only ever differ from the requested id by that one segment", () => {
  const requested = `${DIR}/in-progress/${LEAF}`;
  for (const candidate of lifecycleCandidateIds(requested)) {
    const a = requested.split("/");
    const b = candidate.split("/");
    expect(b).toHaveLength(a.length);
    expect(a.filter((segment, i) => segment !== b[i])).toHaveLength(1);
  }
});

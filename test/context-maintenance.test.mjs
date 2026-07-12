import test from "node:test";
import assert from "node:assert/strict";
import { parseConsolidateRequest, parseAuditRequest } from "../scripts/lib/context/maintenance.mjs";
import { AUDIT_CLASS_VALUES } from "../scripts/lib/context/enums.mjs";

test("parseConsolidateRequest freezes and passes the flags through verbatim", () => {
  const req = parseConsolidateRequest({
    dryRun: true,
    ifDue: false,
    force: true,
    llm: false,
    passes: ["dedupe-by-sha256"],
  });
  assert.ok(Object.isFrozen(req));
  assert.equal(req.dryRun, true);
  assert.equal(req.ifDue, false);
  assert.equal(req.force, true);
  assert.equal(req.llm, false);
  assert.deepEqual(req.passes, ["dedupe-by-sha256"]);
});

test("parseConsolidateRequest keeps `target` a RAW string (C6: runtime brain-only refusal)", () => {
  const shared = "/home/u/repo/.llm-wiki-memory";
  const req = parseConsolidateRequest({ target: shared });
  assert.equal(req.target, shared, "target is not resolved to a level here");
});

test("parseConsolidateRequest coerces cosineThreshold to a Number at the boundary", () => {
  assert.equal(parseConsolidateRequest({ cosineThreshold: 0.95 }).cosineThreshold, 0.95);
  assert.equal(parseConsolidateRequest({}).cosineThreshold, undefined);
});

test("parseAuditRequest defaults an empty/absent class list to ALL audit classes", () => {
  assert.deepEqual(parseAuditRequest({}).classes, [...AUDIT_CLASS_VALUES]);
  assert.deepEqual(parseAuditRequest({ classes: [] }).classes, [...AUDIT_CLASS_VALUES]);
});

test("parseAuditRequest keeps an explicit subset of classes", () => {
  const one = ["missing-metadata"];
  const req = parseAuditRequest({ classes: one });
  assert.deepEqual(req.classes, one);
  assert.ok(Object.isFrozen(req));
});

test("parseAuditRequest rejects an off-vocabulary class with an actionable envelope", () => {
  try {
    parseAuditRequest({ classes: ["missing-metadata", "not-a-class"] });
    assert.fail("expected a ContextValidationError");
  } catch (err) {
    assert.equal(err.name, "ContextValidationError");
    assert.equal(err.envelope.field, "classes");
    assert.ok(err.envelope.allowed.includes("duplicate-error-pattern"));
  }
});

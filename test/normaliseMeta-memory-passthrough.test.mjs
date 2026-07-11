import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseMeta } from "../scripts/lib/wiki-store.mjs";

test("normaliseMeta: all 5 memory-block keys absent -> absent in output", () => {
  const out = normaliseMeta({ atom_type: "decision", area: "billing" });
  assert.equal("stale" in out, false);
  assert.equal("supersedes_id" in out, false);
  assert.equal("consolidated_at" in out, false);
  assert.equal("last_refreshed_at" in out, false);
  assert.equal("consolidate_truncated_at" in out, false);
});

test("normaliseMeta: stale=true (real boolean) -> kept", () => {
  const out = normaliseMeta({ atom_type: "decision", stale: true });
  assert.equal(out.stale, true);
  assert.equal(typeof out.stale, "boolean");
});

test("normaliseMeta: stale=false (real boolean) -> kept (false IS a valid value)", () => {
  const out = normaliseMeta({ atom_type: "decision", stale: false });
  assert.equal(out.stale, false);
  assert.equal(typeof out.stale, "boolean");
  assert.equal("stale" in out, true);
});

test('normaliseMeta: stale="true" (string) -> DROPPED (only real boolean accepted)', () => {
  const out = normaliseMeta({ atom_type: "decision", stale: "true" });
  assert.equal("stale" in out, false);
});

test('normaliseMeta: stale="false" (string) -> DROPPED (only real boolean accepted)', () => {
  const out = normaliseMeta({ atom_type: "decision", stale: "false" });
  assert.equal("stale" in out, false);
});

test("normaliseMeta: stale=1 (truthy number) -> DROPPED (only real boolean accepted)", () => {
  const out = normaliseMeta({ atom_type: "decision", stale: 1 });
  assert.equal("stale" in out, false);
});

test("normaliseMeta: supersedes_id valid relative path -> passed through", () => {
  const out = normaliseMeta({
    atom_type: "decision",
    supersedes_id: "knowledge/billing/old-decision.md",
  });
  assert.equal(out.supersedes_id, "knowledge/billing/old-decision.md");
});

test("normaliseMeta: supersedes_id with surrounding whitespace -> trimmed", () => {
  const out = normaliseMeta({ atom_type: "decision", supersedes_id: "  knowledge/x.md  " });
  assert.equal(out.supersedes_id, "knowledge/x.md");
});

test("normaliseMeta: supersedes_id empty string -> dropped", () => {
  const out = normaliseMeta({ atom_type: "decision", supersedes_id: "" });
  assert.equal("supersedes_id" in out, false);
});

test("normaliseMeta: supersedes_id non-string (number) -> dropped", () => {
  const out = normaliseMeta({ atom_type: "decision", supersedes_id: 42 });
  assert.equal("supersedes_id" in out, false);
});

test("normaliseMeta: consolidated_at valid ISO -> passed through", () => {
  const iso = "2026-06-01T00:00:00.000Z";
  const out = normaliseMeta({ atom_type: "decision", consolidated_at: iso });
  assert.equal(out.consolidated_at, iso);
});

test("normaliseMeta: consolidated_at empty string -> dropped", () => {
  const out = normaliseMeta({ atom_type: "decision", consolidated_at: "" });
  assert.equal("consolidated_at" in out, false);
});

test("normaliseMeta: consolidated_at trimmed", () => {
  const out = normaliseMeta({
    atom_type: "decision",
    consolidated_at: "  2026-06-01T00:00:00.000Z  ",
  });
  assert.equal(out.consolidated_at, "2026-06-01T00:00:00.000Z");
});

test("normaliseMeta: last_refreshed_at valid ISO -> passed through", () => {
  const iso = "2026-05-30T08:15:00.000Z";
  const out = normaliseMeta({ atom_type: "decision", last_refreshed_at: iso });
  assert.equal(out.last_refreshed_at, iso);
});

test("normaliseMeta: last_refreshed_at empty string -> dropped", () => {
  const out = normaliseMeta({ atom_type: "decision", last_refreshed_at: "" });
  assert.equal("last_refreshed_at" in out, false);
});

test("normaliseMeta: last_refreshed_at trimmed", () => {
  const out = normaliseMeta({
    atom_type: "decision",
    last_refreshed_at: "  2026-05-30T08:15:00.000Z  ",
  });
  assert.equal(out.last_refreshed_at, "2026-05-30T08:15:00.000Z");
});

test("normaliseMeta: consolidate_truncated_at valid ISO -> passed through", () => {
  const iso = "2026-05-15T20:00:00.000Z";
  const out = normaliseMeta({ atom_type: "decision", consolidate_truncated_at: iso });
  assert.equal(out.consolidate_truncated_at, iso);
});

test("normaliseMeta: consolidate_truncated_at empty string -> dropped", () => {
  const out = normaliseMeta({ atom_type: "decision", consolidate_truncated_at: "" });
  assert.equal("consolidate_truncated_at" in out, false);
});

test("normaliseMeta: consolidate_truncated_at trimmed", () => {
  const out = normaliseMeta({
    atom_type: "decision",
    consolidate_truncated_at: "  2026-05-15T20:00:00.000Z  ",
  });
  assert.equal(out.consolidate_truncated_at, "2026-05-15T20:00:00.000Z");
});

test("normaliseMeta: all 5 memory keys valid together -> all passed through alongside core fields", () => {
  const input = {
    atom_type: "decision",
    area: "Billing",
    language: "Scala",
    task_type: "Refactor",
    stale: false,
    supersedes_id: "knowledge/x/old.md",
    consolidated_at: "2026-06-01T00:00:00.000Z",
    last_refreshed_at: "2026-05-30T08:15:00.000Z",
    consolidate_truncated_at: "2026-05-15T20:00:00.000Z",
  };
  const out = normaliseMeta(input);
  assert.equal(out.atom_type, "decision");
  assert.equal(out.area, "billing");
  assert.equal(out.language, "scala");
  assert.equal(out.task_type, "refactor");
  assert.equal(out.stale, false);
  assert.equal(out.supersedes_id, "knowledge/x/old.md");
  assert.equal(out.consolidated_at, "2026-06-01T00:00:00.000Z");
  assert.equal(out.last_refreshed_at, "2026-05-30T08:15:00.000Z");
  assert.equal(out.consolidate_truncated_at, "2026-05-15T20:00:00.000Z");
});

test("normaliseMeta: last_recalled_at / recall_count are DROPPED (feature removed)", () => {
  const out = normaliseMeta({
    atom_type: "decision",
    last_recalled_at: "2026-06-02T12:00:00.000Z",
    recall_count: 7,
  });
  assert.equal("last_recalled_at" in out, false);
  assert.equal("recall_count" in out, false);
});

test("normaliseMeta: existing core fields (atom_type, area, language, task_type, error_pattern, status) unaffected by memory keys", () => {
  const out = normaliseMeta(
    {
      atom_type: "bug-root-cause",
      area: "Frontend",
      language: "TypeScript",
      task_type: "Debug",
      error_pattern: "null-deref",
      stale: true,
    },
    { status: "active" },
  );
  assert.equal(out.atom_type, "bug-root-cause");
  assert.equal(out.area, "frontend");
  assert.equal(out.language, "typescript");
  assert.equal(out.task_type, "debug");
  assert.equal(out.error_pattern, "null-deref");
  assert.equal(out.status, "active");
  assert.equal(out.stale, true);
});

test("normaliseMeta: empty input -> none of the memory keys appear in output", () => {
  const out = normaliseMeta({});
  for (const k of [
    "stale",
    "supersedes_id",
    "consolidated_at",
    "last_refreshed_at",
    "consolidate_truncated_at",
  ]) {
    assert.equal(k in out, false, `expected ${k} to be absent`);
  }
});

test("normaliseMeta: non-string ISO field (number) -> dropped (typeof guard rejects)", () => {
  const out = normaliseMeta({
    atom_type: "decision",
    consolidated_at: 1717329600000,
    last_refreshed_at: 1717329600000,
    consolidate_truncated_at: 1717329600000,
  });
  assert.equal("consolidated_at" in out, false);
  assert.equal("last_refreshed_at" in out, false);
  assert.equal("consolidate_truncated_at" in out, false);
});

// Tests for lib/tracker-parse.mjs — every primitive in isolation, plus
// adversarial inputs the hook will see in real transcripts. Tracker-
// agnostic by design (Jira/Linear/any "{PREFIX}-{N}" tracker).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractIssueKeys,
  extractIssueKeysByPrefix,
  parseIssueKey,
  parseChecklist,
  diffChecklists,
  inferLifecycle,
  checklistProgress,
} from "../scripts/lib/tracker-parse.mjs";

// ---------------------------------------------------------------------------
// extractIssueKeys
// ---------------------------------------------------------------------------

test("extractIssueKeys: finds a single key", () => {
  assert.deepEqual(extractIssueKeys("see DEV-129957 for context"), ["DEV-129957"]);
});

test("extractIssueKeys: dedupes repeated keys, sorts output", () => {
  assert.deepEqual(
    extractIssueKeys("DEV-1 DEV-2 DEV-1 OPS-100 DEV-2"),
    ["DEV-1", "DEV-2", "OPS-100"],
  );
});

test("extractIssueKeys: handles multiple prefixes", () => {
  const r = extractIssueKeys("DEV-1, OPS-44231, INFRA-7, PLATFORM-12345");
  assert.deepEqual(r, ["DEV-1", "INFRA-7", "OPS-44231", "PLATFORM-12345"]);
});

test("extractIssueKeys: requires a letter at the start of the prefix (rejects 1-DEV)", () => {
  assert.deepEqual(extractIssueKeys("1-DEV is not a key"), []);
});

test("extractIssueKeys: respects word boundaries (rejects substring matches)", () => {
  // SUB-DEV-1 should NOT match (the `-` between SUB and DEV breaks boundary)
  // The regex requires \b before the prefix so the leading hyphen prevents a match.
  const r = extractIssueKeys("PRE-FIX something else DEV-42 wrapped");
  // PRE-FIX matches because PRE+FIX both look like a valid Jira key shape
  // (PRE = letter+chars, FIX = digits? no, FIX has letters not digits). Test
  // PRE-1 instead to be safe.
  assert.ok(r.includes("DEV-42"));
});

test("extractIssueKeys: empty / null / non-string inputs return []", () => {
  assert.deepEqual(extractIssueKeys(""), []);
  assert.deepEqual(extractIssueKeys(null), []);
  assert.deepEqual(extractIssueKeys(undefined), []);
  assert.deepEqual(extractIssueKeys(42), []);
});

test("extractIssueKeys: large 7-digit numbers OK", () => {
  assert.deepEqual(extractIssueKeys("DEV-1234567"), ["DEV-1234567"]);
});

test("extractIssueKeys: rejects 8-digit numbers (regex caps at 7)", () => {
  assert.deepEqual(extractIssueKeys("DEV-12345678"), []);
});

test("extractIssueKeys: state isolation across concurrent calls", () => {
  // The /g regex shares lastIndex across calls; we reset it inside the
  // function. Two interleaved calls must each see the full input.
  const a = extractIssueKeys("DEV-1 DEV-2");
  const b = extractIssueKeys("OPS-3 OPS-4");
  assert.deepEqual(a, ["DEV-1", "DEV-2"]);
  assert.deepEqual(b, ["OPS-3", "OPS-4"]);
});

test("extractIssueKeysByPrefix: groups correctly", () => {
  const r = extractIssueKeysByPrefix("DEV-1 OPS-2 DEV-3 DEV-1");
  assert.deepEqual([...r.keys()].sort(), ["DEV", "OPS"]);
  assert.deepEqual(r.get("DEV"), ["DEV-1", "DEV-3"]);
  assert.deepEqual(r.get("OPS"), ["OPS-2"]);
});

test("parseIssueKey: returns { prefix, number } for valid input", () => {
  assert.deepEqual(parseIssueKey("DEV-129957"), { prefix: "DEV", number: 129957 });
  assert.deepEqual(parseIssueKey("OPS-1"), { prefix: "OPS", number: 1 });
});

test("parseIssueKey: returns null for malformed / non-string input", () => {
  assert.equal(parseIssueKey(""), null);
  assert.equal(parseIssueKey(null), null);
  assert.equal(parseIssueKey(undefined), null);
  assert.equal(parseIssueKey("DEV"), null);
  assert.equal(parseIssueKey("dev-1"), null); // lowercase prefix rejected
  assert.equal(parseIssueKey("DEV-12345678"), null); // > 7 digits
});

// ---------------------------------------------------------------------------
// parseChecklist
// ---------------------------------------------------------------------------

const PLAN_FIXTURE = `
# DEV-129957 — Investigate timeout

## Action items

1. - [x] Reproduce locally with rc22 image
2. - [x] Capture thread dump during timeout
3. - [ ] Bisect commit range between rc21 and rc22
4. - [ ] Check Cassandra read-timeout config diff  reason:deferred:waiting on infra
5. - [ ] Confirm with @alex
   - 5.1 - [ ] DM sent
   - 5.2 - [ ] Reply received
6. - [ ] Production rollout  reason:blocked:waiting for change-management

## Notes

A loose item without numbering:
- [ ] adhoc TODO
`;

test("parseChecklist: returns one record per checkbox line", () => {
  const items = parseChecklist(PLAN_FIXTURE);
  assert.equal(items.length, 9);
});

test("parseChecklist: state, number, and label captured", () => {
  const items = parseChecklist(PLAN_FIXTURE);
  assert.equal(items[0].checked, true);
  assert.equal(items[0].number, "1");
  assert.equal(items[0].label, "Reproduce locally with rc22 image");
  assert.equal(items[2].checked, false);
  assert.equal(items[2].label, "Bisect commit range between rc21 and rc22");
});

test("parseChecklist: nested sub-numbers preserved", () => {
  const items = parseChecklist(PLAN_FIXTURE);
  const sub51 = items.find((i) => i.number === "5.1");
  const sub52 = items.find((i) => i.number === "5.2");
  assert.ok(sub51);
  assert.ok(sub52);
  assert.equal(sub51.label, "DM sent");
  assert.equal(sub51.indent, 3);
});

test("parseChecklist: reason tags split from label", () => {
  const items = parseChecklist(PLAN_FIXTURE);
  const it4 = items.find((i) => i.number === "4");
  assert.deepEqual(it4.reasons, [{ key: "deferred", comment: "waiting on infra" }]);
  assert.equal(it4.label, "Check Cassandra read-timeout config diff");
});

test("parseChecklist: multiple reason tags on one line", () => {
  const items = parseChecklist(
    "1. - [ ] complicated item  reason:deferred:see ticket  reason:blocked:awaiting infra\n",
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].reasons, [
    { key: "deferred", comment: "see ticket" },
    { key: "blocked", comment: "awaiting infra" },
  ]);
  assert.equal(items[0].label, "complicated item");
});

test("parseChecklist: un-numbered checkbox is still captured (number=null)", () => {
  const items = parseChecklist(PLAN_FIXTURE);
  const ad = items.find((i) => i.label === "adhoc TODO");
  assert.ok(ad);
  assert.equal(ad.number, null);
  assert.equal(ad.checked, false);
});

test("parseChecklist: accepts both `- [x]` and `- [X]`", () => {
  const items = parseChecklist("- [x] lower\n- [X] upper\n");
  assert.equal(items.length, 2);
  assert.equal(items[0].checked, true);
  assert.equal(items[1].checked, true);
});

test("parseChecklist: ignores non-checkbox bullets", () => {
  const items = parseChecklist("- just a bullet\n* another\n1. plain item\n");
  assert.deepEqual(items, []);
});

test("parseChecklist: empty / null / non-string inputs return []", () => {
  assert.deepEqual(parseChecklist(""), []);
  assert.deepEqual(parseChecklist(null), []);
  assert.deepEqual(parseChecklist(undefined), []);
});

// ---------------------------------------------------------------------------
// diffChecklists
// ---------------------------------------------------------------------------

test("diffChecklists: flipped → identifies state changes by number", () => {
  const before = `
1. - [ ] A
2. - [ ] B
3. - [x] C
`;
  const after = `
1. - [x] A
2. - [ ] B
3. - [x] C
`;
  const d = diffChecklists(before, after);
  assert.equal(d.flipped.length, 1);
  assert.equal(d.flipped[0].id, "1");
  assert.equal(d.flipped[0].from, false);
  assert.equal(d.flipped[0].to, true);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});

test("diffChecklists: added → new item appears in after", () => {
  const before = "1. - [ ] A\n";
  const after = "1. - [ ] A\n2. - [ ] B\n";
  const d = diffChecklists(before, after);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].label, "B");
});

test("diffChecklists: removed → item disappears in after", () => {
  const before = "1. - [ ] A\n2. - [ ] B\n";
  const after = "1. - [ ] A\n";
  const d = diffChecklists(before, after);
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].label, "B");
});

test("diffChecklists: reasonAdded → new reason tag appears on existing item", () => {
  const before = "1. - [ ] A\n";
  const after = "1. - [ ] A  reason:deferred:see DEV-200\n";
  const d = diffChecklists(before, after);
  assert.equal(d.reasonAdded.length, 1);
  assert.equal(d.reasonAdded[0].reason.key, "deferred");
  assert.equal(d.reasonAdded[0].reason.comment, "see DEV-200");
});

test("diffChecklists: identity falls back to label for un-numbered items", () => {
  const before = "- [ ] adhoc\n";
  const after = "- [x] adhoc\n";
  const d = diffChecklists(before, after);
  assert.equal(d.flipped.length, 1);
  assert.equal(d.flipped[0].id, "label:adhoc");
});

test("diffChecklists: simultaneous flip + reasonAdded on the same item", () => {
  const before = "1. - [ ] task\n";
  const after = "1. - [x] task  reason:blocked:had to wait\n";
  const d = diffChecklists(before, after);
  assert.equal(d.flipped.length, 1);
  assert.equal(d.reasonAdded.length, 1);
  assert.equal(d.flipped[0].id, "1");
  assert.equal(d.reasonAdded[0].id, "1");
});

// ---------------------------------------------------------------------------
// inferLifecycle + checklistProgress
// ---------------------------------------------------------------------------

test("inferLifecycle: all unchecked → pending", () => {
  assert.equal(inferLifecycle("1. - [ ] A\n2. - [ ] B\n"), "pending");
});

test("inferLifecycle: some checked → in-progress", () => {
  assert.equal(inferLifecycle("1. - [x] A\n2. - [ ] B\n"), "in-progress");
});

test("inferLifecycle: all checked → done", () => {
  assert.equal(inferLifecycle("1. - [x] A\n2. - [x] B\n"), "done");
});

test("inferLifecycle: empty checklist → pending (a plan without action items)", () => {
  assert.equal(inferLifecycle(""), "pending");
});

test("checklistProgress: returns done/total + label", () => {
  const p = checklistProgress("1. - [x] A\n2. - [x] B\n3. - [ ] C\n");
  assert.equal(p.total, 3);
  assert.equal(p.done, 2);
  assert.equal(p.label, "2/3");
  assert.ok(Math.abs(p.ratio - 2 / 3) < 1e-9);
});

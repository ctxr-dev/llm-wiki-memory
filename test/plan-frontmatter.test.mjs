// Tests for lib/plan-frontmatter.mjs — pure transforms + I/O wrapper.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import {
  buildUpdatedFrontmatter,
  applyFrontmatterUpdate,
  updatePlanFrontmatter,
} from "../scripts/lib/plan-frontmatter.mjs";
import { parseChecklist } from "../scripts/lib/tracker-parse.mjs";

const FIXED_NOW = new Date("2026-05-26T12:00:00Z");

test("buildUpdatedFrontmatter: inferred status flips pending→in-progress→done", () => {
  const checklist0 = parseChecklist("1. - [ ] A\n2. - [ ] B\n");
  const r0 = buildUpdatedFrontmatter({ data: {}, checklist: checklist0, now: FIXED_NOW });
  assert.equal(r0.status, "pending");

  const checklist1 = parseChecklist("1. - [x] A\n2. - [ ] B\n");
  const r1 = buildUpdatedFrontmatter({ data: {}, checklist: checklist1, now: FIXED_NOW });
  assert.equal(r1.status, "in-progress");

  const checklist2 = parseChecklist("1. - [x] A\n2. - [x] B\n");
  const r2 = buildUpdatedFrontmatter({ data: {}, checklist: checklist2, now: FIXED_NOW });
  assert.equal(r2.status, "done");
});

test("buildUpdatedFrontmatter: progress fields capture done/total/label", () => {
  const cl = parseChecklist("1. - [x] A\n2. - [x] B\n3. - [ ] C\n");
  const r = buildUpdatedFrontmatter({ data: {}, checklist: cl, now: FIXED_NOW });
  assert.deepEqual(r.progress, { total: 3, done: 2, label: "2/3" });
});

test("buildUpdatedFrontmatter: empty checklist → pending, 0/0", () => {
  const r = buildUpdatedFrontmatter({ data: {}, checklist: [], now: FIXED_NOW });
  assert.equal(r.status, "pending");
  assert.deepEqual(r.progress, { total: 0, done: 0, label: "0/0" });
});

test("buildUpdatedFrontmatter: archived plans never auto-flip their status", () => {
  const cl = parseChecklist("1. - [x] A\n");
  const r = buildUpdatedFrontmatter({
    data: { status: "archived", archived: true },
    checklist: cl,
    now: FIXED_NOW,
  });
  assert.equal(r.status, "archived");
  assert.equal(r.archived, true);
});

test("buildUpdatedFrontmatter: last_updated is the ISO date of `now`", () => {
  const r = buildUpdatedFrontmatter({ data: {}, checklist: [], now: FIXED_NOW });
  assert.equal(r.last_updated, "2026-05-26");
});

test("buildUpdatedFrontmatter: unrelated frontmatter keys are preserved", () => {
  const r = buildUpdatedFrontmatter({
    data: {
      issue_key: "DEV-129957",
      plan_title: "Investigate timeout",
      derived_from: ["pending/DEV-129957-initial-triage.plan.md"],
      tags: ["hermes", "timeout"],
    },
    checklist: [],
    now: FIXED_NOW,
  });
  assert.equal(r.issue_key, "DEV-129957");
  assert.equal(r.plan_title, "Investigate timeout");
  assert.deepEqual(r.derived_from, ["pending/DEV-129957-initial-triage.plan.md"]);
  assert.deepEqual(r.tags, ["hermes", "timeout"]);
});

test("buildUpdatedFrontmatter: flip_log is NOT written (dropped as read-by-nothing)", () => {
  const r = buildUpdatedFrontmatter({
    data: {},
    checklist: parseChecklist("1. - [x] A\n"),
    now: FIXED_NOW,
  });
  assert.equal(r.flip_log, undefined, "no flip_log persisted");
  assert.deepEqual(r.progress, { total: 1, done: 1, label: "1/1" });
  assert.equal(r.last_updated, "2026-05-26");
});

test("buildUpdatedFrontmatter: a legacy flip_log is STRIPPED on re-save", () => {
  const r = buildUpdatedFrontmatter({
    data: { flip_log: [{ num: "1", from: " ", to: "x", at: "2026-05-22" }], status: "pending" },
    checklist: parseChecklist("1. - [x] A\n"),
    now: FIXED_NOW,
  });
  assert.equal(r.flip_log, undefined, "legacy flip_log removed on re-save");
});

const PLAN_FIXTURE = `---
issue_key: DEV-129957
plan_title: "Investigate timeout"
slug: investigate-timeout
status: pending
created: 2026-05-22
tags:
  - hermes
  - timeout
---

# Investigate timeout — DEV-129957

## Action items

1. - [x] Reproduce locally with rc22 image
2. - [ ] Bisect commit range
3. - [ ] Confirm with @alex
`;

test("applyFrontmatterUpdate: status, progress, last_updated written into frontmatter", () => {
  const r = applyFrontmatterUpdate(PLAN_FIXTURE, { now: FIXED_NOW });
  assert.equal(r.changed, true);
  const parsed = matter(r.text);
  assert.equal(parsed.data.status, "in-progress");
  assert.deepEqual(parsed.data.progress, { total: 3, done: 1, label: "1/3" });
  assert.equal(parsed.data.last_updated, "2026-05-26");
});

test("applyFrontmatterUpdate: body is byte-identical (only frontmatter rewritten)", () => {
  const r = applyFrontmatterUpdate(PLAN_FIXTURE, { now: FIXED_NOW });
  const before = matter(PLAN_FIXTURE).content;
  const after = matter(r.text).content;
  assert.equal(after, before, "plan body must not be touched by the frontmatter updater");
});

test("applyFrontmatterUpdate: returns changed=false when nothing differs", () => {
  // First pass writes the frontmatter; second pass against the OUTPUT should
  // be a no-op (the values are already correct).
  const first = applyFrontmatterUpdate(PLAN_FIXTURE, { now: FIXED_NOW });
  const second = applyFrontmatterUpdate(first.text, { now: FIXED_NOW });
  assert.equal(second.changed, false, "idempotent on stable state");
});

test("applyFrontmatterUpdate: no flip_log written; flips are only counted", () => {
  const r = applyFrontmatterUpdate(PLAN_FIXTURE, {
    flips: [{ id: "1", from: false, to: true }],
    now: FIXED_NOW,
  });
  const parsed = matter(r.text);
  assert.equal(parsed.data.flip_log, undefined, "no flip_log frontmatter written");
  assert.equal(r.summary.flips_detected, 1, "flips are counted in the summary");
});

test("applyFrontmatterUpdate: no flip_log when flips omitted", () => {
  const r = applyFrontmatterUpdate(PLAN_FIXTURE, { now: FIXED_NOW });
  const parsed = matter(r.text);
  assert.equal(parsed.data.flip_log, undefined);
  assert.equal(r.summary.flips_detected, 0);
});

test("updatePlanFrontmatter: reads, transforms, writes the plan file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-io-"));
  const fp = path.join(dir, "DEV-1-test.plan.md");
  fs.writeFileSync(fp, PLAN_FIXTURE);
  const r = updatePlanFrontmatter(fp, { now: FIXED_NOW });
  assert.equal(r.changed, true);
  assert.equal(r.status, "in-progress");
  const onDisk = fs.readFileSync(fp, "utf8");
  const parsed = matter(onDisk);
  assert.equal(parsed.data.status, "in-progress");
  assert.deepEqual(parsed.data.progress, { total: 3, done: 1, label: "1/3" });
});

test("updatePlanFrontmatter: idempotent (second call is a no-op)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-io-idem-"));
  const fp = path.join(dir, "DEV-2-test.plan.md");
  fs.writeFileSync(fp, PLAN_FIXTURE);
  updatePlanFrontmatter(fp, { now: FIXED_NOW });
  const r2 = updatePlanFrontmatter(fp, { now: FIXED_NOW });
  assert.equal(r2.changed, false);
});

test("updatePlanFrontmatter: refuses to mangle a plan with no frontmatter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-io-bare-"));
  const fp = path.join(dir, "bare.plan.md");
  // No frontmatter — just body
  fs.writeFileSync(fp, "# Bare plan\n\n1. - [ ] Item one\n");
  const r = updatePlanFrontmatter(fp, { now: FIXED_NOW });
  // gray-matter adds frontmatter when stringifying; the file will be changed,
  // but the body stays intact (covered by the byte-identical body test
  // above). We document that "no frontmatter" → status/progress get added.
  assert.equal(r.changed, true);
  const onDisk = fs.readFileSync(fp, "utf8");
  const parsed = matter(onDisk);
  assert.equal(parsed.data.status, "pending");
  assert.deepEqual(parsed.data.progress, { total: 1, done: 0, label: "0/1" });
});

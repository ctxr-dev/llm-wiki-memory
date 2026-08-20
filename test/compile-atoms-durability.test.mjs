import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scoreAtomQuality } from "../scripts/compile-atoms.mjs";
import { hasAttribution } from "../scripts/lib/depersonalize.mjs";
import { STALENESS_ELIGIBLE_ATOM_TYPES } from "../scripts/consolidate-constants.mjs";
import { PROMPTS_DIR } from "../scripts/lib/env.mjs";

function readPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");
}

// ── scoreAtomQuality: volatile-locator durability backstop ────────────────
test("scoreAtomQuality drops an atom dominated by line-number locators with no framing", () => {
  const atom = {
    type: "pattern-gotcha",
    title: "Bumblebee context propagation wiring",
    body:
      "Snapshot Baggage before async boundaries. See BumblebeeFilter.scala:42, then " +
      "BaggageUtil.scala:88, and finally ContextPropagator.scala:130 for the wiring.",
    tags: ["bumblebee"],
    evidence: "DEV-1: baggage lost across async hop",
    metadata: { area: "bumblebee" },
  };
  const res = scoreAtomQuality(atom);
  assert.equal(res.ok, false, "a line-number-dominated atom must not pass");
  assert.ok(
    res.reasons.some((r) => /volatile|locator|line/i.test(r)),
    `expected a volatile-locator reason, got ${JSON.stringify(res.reasons)}`,
  );
});

test("scoreAtomQuality KEEPS a conceptual lesson that merely names a file/symbol", () => {
  const atom = {
    type: "bug-root-cause",
    title: "Kafka partition key must derive from WebhooksOrder.id",
    body:
      "Kafka partition key must derive from the original WebhooksOrder.id, not the optional " +
      "eventContext.\nWhy: routing broke when it was keyed on eventContext because that field " +
      "is absent for replays.\nHow to apply: always key the producer on WebhooksOrder.id.",
    tags: ["kafka"],
    metadata: { area: "webhooks" },
  };
  const res = scoreAtomQuality(atom);
  assert.equal(res.ok, true, `naming a symbol is fine; got reasons ${JSON.stringify(res.reasons)}`);
  assert.ok(
    !res.reasons.some((r) => /volatile|locator/i.test(r)),
    "mere file/symbol mention must not trip the volatile-locator backstop",
  );
});

test("scoreAtomQuality keeps a single dated locator hint when conceptual framing is present", () => {
  const atom = {
    type: "bug-root-cause",
    title: "Retry the upstream fetch with backoff",
    body:
      "Retry the upstream fetch with exponential backoff on 429.\nWhy: the vendor rate-limits " +
      "under burst load.\nHow to apply: as of 2026-07 the retry lives in FetchService.scala:210 " +
      "— re-verify before relying on it.",
    tags: ["retry"],
    metadata: { area: "fetch" },
  };
  const res = scoreAtomQuality(atom);
  assert.ok(
    !res.reasons.some((r) => /volatile|locator/i.test(r)),
    "one dated hint alongside Why/How framing is durable enough to keep",
  );
});

test("scoreAtomQuality does NOT flag durable host:port / image:tag / version tokens", () => {
  const durableConfigDumps = [
    "Local services: grafana at grafana.example.com:3000, prometheus at prometheus.example.com:9090, alertmanager at alertmanager.example.com:9093.",
    "Container images pinned in the deploy: node:18 for the api, redis:7 for cache, postgres:14 for the primary store.",
    "Redis topology: redis-prod.internal:6379, redis-replica.internal:6380, sentinel.internal:26379 are the three endpoints.",
  ];
  for (const body of durableConfigDumps) {
    const res = scoreAtomQuality({
      type: "reference",
      title: "Service endpoints",
      body,
      tags: ["infra"],
      evidence: "infra topology",
      metadata: { area: "infra" },
    });
    assert.ok(
      !res.reasons.some((r) => /volatile|locator/i.test(r)),
      `host:port / image:tag / version tokens are durable anchors, not line locators: ${body}`,
    );
  }
});

test("scoreAtomQuality still flags user attribution (regression)", () => {
  const text = "The user said to snapshot Baggage on the request thread before any async boundary.";
  const atom = {
    type: "feedback-rule",
    title: "Snapshot baggage on the request thread",
    body: `${text}\nWhy: async hops lose the Kamon context.\nHow to apply: capture at ingress.`,
    tags: ["baggage"],
    metadata: { area: "bumblebee" },
  };
  const res = scoreAtomQuality(atom);
  assert.equal(
    res.reasons.some((r) => /attribution/i.test(r)),
    hasAttribution(`${atom.title}\n${atom.body}`),
    "the attribution reason must track hasAttribution",
  );
});

// ── consolidate staleness eligibility ─────────────────────────────────────
test("STALENESS_ELIGIBLE covers the volatile-locator carriers; reference stays excluded", () => {
  // These embed volatile code locators as evidence, so the de-volatilizing
  // refresh pass revisits them — this cleans pre-existing bumblebee-style leaves.
  for (const t of [
    "bug-root-cause",
    "pattern-gotcha",
    "feedback-rule",
    "self-improvement-lesson",
  ]) {
    assert.ok(STALENESS_ELIGIBLE_ATOM_TYPES.has(t), `${t} stays staleness-eligible`);
  }
  // `reference`'s canonical pointer IS its payload — de-volatilizing it would gut
  // it and it would perpetually re-trip staleness, so it is deliberately excluded.
  assert.ok(!STALENESS_ELIGIBLE_ATOM_TYPES.has("reference"), "reference is not refresh-eligible");
});

// ── durability directives in the auto-distill prompts ─────────────────────
test("flush.md + compile.md carry a durability directive (no volatile locators)", () => {
  const flush = readPrompt("flush.md");
  const compile = readPrompt("compile.md");
  assert.match(flush, /line number/i, "flush.md must forbid line-number locators");
  assert.match(compile, /line number/i, "compile.md merge must forbid line-number locators");
});

test("consolidate-refresh.md de-volatilizes rather than re-points drifted locators", () => {
  const refresh = readPrompt("consolidate-refresh.md");
  assert.doesNotMatch(
    refresh,
    /never reduce specificity/i,
    "the old 'never reduce specificity' clause contradicts de-volatilization and must be gone",
  );
  assert.match(
    refresh,
    /de-volatili[sz]e/i,
    "the refresh prompt must instruct de-volatilization of drifted locators",
  );
});

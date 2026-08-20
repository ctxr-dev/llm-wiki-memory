import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasAttribution,
  hasReviewableAttribution,
  neutralizeAttribution,
} from "../scripts/lib/depersonalize.mjs";
import { validateAtoms } from "../scripts/hooks/flush.mjs";

test("neutralizeAttribution strips a leading attribution opener, keeping the technical clause", () => {
  const r = neutralizeAttribution("The user said to prefer IO for concurrency in the fetcher.");
  assert.equal(r.changed, true);
  assert.equal(r.text, "Prefer IO for concurrency in the fetcher.");
});

test("neutralizeAttribution handles 'you told me to …' and re-capitalises", () => {
  assert.equal(
    neutralizeAttribution("you told me to key on WebhooksOrder.id").text,
    "Key on WebhooksOrder.id",
  );
});

test("neutralizeAttribution preserves multi-line body structure when stripping an opener", () => {
  const r = neutralizeAttribution(
    "The user said to prefer IO for concurrency.\n\n**Why:** avoids blocking.\n**How to apply:** thread IO through.",
  );
  assert.equal(r.changed, true);
  assert.equal(
    r.text,
    "Prefer IO for concurrency.\n\n**Why:** avoids blocking.\n**How to apply:** thread IO through.",
    "only the leading opener is removed; newlines / paragraph breaks are kept intact",
  );
});

test("neutralizeAttribution leaves de-personalized text unchanged", () => {
  const clean = "Kafka partition key must derive from WebhooksOrder.id.";
  const r = neutralizeAttribution(clean);
  assert.equal(r.changed, false);
  assert.equal(r.text, clean);
});

test("hasAttribution matches only line-opening conversational attribution", () => {
  assert.equal(hasAttribution("The user said to prefer IO"), true);
  assert.equal(hasAttribution("you told me to do Y"), true);
  assert.equal(hasAttribution("User: use IO"), true);
  assert.equal(hasAttribution("the user interface is slow"), false);
  assert.equal(hasAttribution("you should use IO for concurrency"), false);
  assert.equal(hasAttribution("Prefer IO; keep var out of the hot path"), false);
});

test("hasAttribution does NOT touch end-customer domain prose (ambiguous verbs excluded)", () => {
  // "the user" is frequently the end customer here — these are technical facts, not
  // attribution to the human operating the AI, and must survive.
  assert.equal(hasAttribution("the user wants faster checkout"), false);
  assert.equal(hasAttribution("the user requested a refund via the API"), false);
  assert.equal(hasAttribution("the user prefers express shipping"), false);
});

test("hasAttribution is line-anchored: mid-sentence 'the user said' is not attribution", () => {
  assert.equal(hasAttribution("count the number of times the user said no"), false);
});

test("hasReviewableAttribution (remediation pre-filter) catches mid-sentence operator attribution", () => {
  // Real corpus samples the line-anchored backstop deliberately skips.
  assert.equal(
    hasReviewableAttribution("Here the user said 'I merged' but PR #18 was open."),
    true,
  );
  assert.equal(hasReviewableAttribution("**Why:** The user wants the methodology reusable."), true);
  assert.equal(
    hasReviewableAttribution("the user pushed back, 'Why did you make that change?'"),
    true,
  );
  assert.equal(
    hasReviewableAttribution("after the user asked me to think harder about edge cases"),
    true,
  );
  // Anything the strict backstop flags, the loose detector also flags.
  assert.equal(hasReviewableAttribution("The user said to prefer IO"), true);
});

test("hasReviewableAttribution ignores non-attribution prose (LLM keeps false positives cheaply)", () => {
  assert.equal(
    hasReviewableAttribution("Kafka partition key must derive from WebhooksOrder.id."),
    false,
  );
  assert.equal(hasReviewableAttribution("the user interface is slow to render"), false);
  assert.equal(hasReviewableAttribution("you should use IO for concurrency"), false);
});

test("validateAtoms de-personalizes an atom body + evidence (always-on, backstop)", () => {
  const [atom] = validateAtoms({
    atoms: [
      {
        type: "reference",
        title: "Concurrency preference",
        body: "The user said to prefer IO for concurrency in SafeDeployTrafficFilter.",
        tags: ["concurrency"],
        metadata: { area: "safedeployment" },
        evidence: "The user said to avoid unsafeRunSync",
      },
    ],
  });
  assert.ok(atom, "atom survives");
  assert.ok(!/user said/i.test(atom.body), "attribution stripped from body");
  assert.match(atom.body, /prefer IO for concurrency/i, "technical content kept");
  assert.ok(!/user said/i.test(String(atom.evidence)), "attribution stripped from evidence");
});

test("validateAtoms drops an atom that is nothing but attribution", () => {
  const atoms = validateAtoms({
    atoms: [{ type: "reference", title: "User:", body: "the user said", tags: ["x"] }],
  });
  assert.equal(atoms.length, 0, "all-attribution atom neutralizes to empty and is dropped");
});

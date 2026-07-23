import { test, expect } from "vitest";
import { buildSnippet, queryTerms } from "./snippet.mjs";

const TITLE = "Kafka choice for the event bus";

test("centers the snippet on the first query match and marks the trim with ellipses", () => {
  const body =
    "# Kafka choice for the event bus\n\nA long preamble sentence that pushes the interesting bit far to the right so the window has to trim. We ultimately picked Kafka for durable partitioned streaming across services.";
  const snippet = buildSnippet(body, "durable partitioned streaming", TITLE, 120);
  expect(snippet).toContain("durable partitioned streaming");
  expect(snippet.startsWith("…")).toBe(true);
});

test("falls back to prose, skipping a first line that duplicates the title and the metadata list", () => {
  const body =
    "# Kafka choice for the event bus\n\n- type: decision\n- area: backend\n\nWe compared brokers.\nKafka won on durability.";
  const snippet = buildSnippet(body, "nomatchhere", TITLE, 200);
  expect(snippet).toBe("We compared brokers. Kafka won on durability.");
  expect(snippet).not.toContain("Kafka choice for the event bus");
  expect(snippet).not.toContain("type: decision");
});

test("joins several short lines up to the display cap", () => {
  const body = "# Title\n\none\ntwo\nthree\nfour\nfive\nsix";
  const snippet = buildSnippet(body, "zzz", "Title", 12);
  expect(snippet).toBe("one two thre");
});

test("a match inside the metadata preamble is ignored in favor of prose", () => {
  const body =
    "# Consolidate notes\n\n- tags: consolidate, layout\n- area: docs\n\nThe consolidate pass merges near-duplicate leaves.";
  const snippet = buildSnippet(body, "consolidate", "Consolidate notes", 200);
  expect(snippet).toBe("The consolidate pass merges near-duplicate leaves.");
  expect(snippet).not.toContain("tags:");
  expect(snippet).not.toContain("# Consolidate");
});

test("strips a yaml-ish preamble that precedes the title heading", () => {
  const body =
    "\nstatus: verified\nsubject:\n  - audit\n  - request_id\n\n# DEV-129957 requestId divergence\n\nFor the update_order path, requestId did not match.";
  const snippet = buildSnippet(body, "requestId", "DEV-129957 requestId divergence", 200);
  expect(snippet).toBe("For the update_order path, requestId did not match.");
  expect(snippet).not.toContain("# DEV-129957");
  expect(snippet).not.toContain("subject:");
});

test("preserves a body whose content is a bulleted checklist (no prose)", () => {
  const body = "# Checklist\n\n- [ ] first task\n- [ ] second task";
  expect(buildSnippet(body, "second", "Checklist", 200)).toContain("second task");
});

test("a body of only bare yaml keys yields no leaked-preamble snippet", () => {
  const body = "status: draft\nowner: alice\nupdated: 2024";
  expect(buildSnippet(body, "alice", "Some Title", 200)).toBe("");
});

test("an empty body yields an empty snippet", () => {
  expect(buildSnippet("", "kafka", TITLE, 100)).toBe("");
});

test("queryTerms drops punctuation and sub-2-char tokens", () => {
  expect(queryTerms("Kafka, a topic!")).toEqual(["kafka", "topic"]);
});

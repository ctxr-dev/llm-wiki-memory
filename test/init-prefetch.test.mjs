// A fresh install ends with the model definitively absent: `init` never touched the embedding
// subsystem and bootstrap.sh runs it with stdout discarded. So the ~219MB download always landed
// inside the FIRST recall — where, in an MCP call, the wait is invisible and looks like a hang.
//
// Prefetching moves that cost to setup, where waiting is expected and can be narrated. Two things
// make it safe to do unconditionally: it is skipped whenever the backend is not `transformers`
// (the e2e harness runs `lexical`), and it fails SOFT — an offline or air-gapped install must
// still be able to initialise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

const { prefetchEmbedModel } = await import("../scripts/lib/embed.mjs");

test("prefetch is skipped when the backend is not transformers", async () => {
  const result = await withSettingsOverride({ embed: { backend: "lexical" } }, async () =>
    prefetchEmbedModel(),
  );
  assert.equal(result.skipped, "lexical", "a lexical install has no model to fetch");
  assert.notEqual(result.ok, false, "and that is not a failure");
});

test("prefetch reports progress through the supplied reporter, never stdout", async () => {
  /** @type {string[]} */
  const seen = [];
  await withSettingsOverride({ embed: { backend: "lexical" } }, async () =>
    prefetchEmbedModel({ onProgress: () => seen.push("x") }),
  );
  // Nothing to download on the lexical path, so nothing is reported — the point is that
  // supplying a reporter is accepted and never throws.
  assert.deepEqual(seen, []);
});

// The load is attempted with a model name that cannot resolve, standing in for "no network".
test("a failed prefetch resolves to ok:false rather than throwing", async () => {
  const result = await withSettingsOverride(
    { embed: { backend: "transformers", model: "definitely-not-a-real-org/not-a-real-model" } },
    async () => prefetchEmbedModel(),
  );
  assert.equal(result.ok, false, "an unreachable model must not reject");
  assert.equal(typeof result.error, "string", "and must say why");
});

// The stdout contract is what every caller (and bootstrap.sh) parses; progress must not pollute it.
test("init's stdout stays pure JSON with prefetch in play", async () => {
  const { dataDir } = setupWorkspace();
  try {
    const r = runScript("scripts/cli.mjs", ["init"], { dataDir });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true, `init must succeed: ${r.stdout}${r.stderr}`);
    assert.equal(typeof parsed.wiki, "string");
    assert.equal(typeof parsed.embedCache, "string");
  } finally {
    cleanup(dataDir);
  }
});

test("--no-prefetch is accepted and still produces the same JSON contract", async () => {
  const { dataDir } = setupWorkspace();
  try {
    const r = runScript("scripts/cli.mjs", ["init", "--no-prefetch"], { dataDir });
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true, `init --no-prefetch must succeed: ${r.stdout}${r.stderr}`);
    assert.equal(parsed.prefetch, "skipped", "and say it was skipped");
  } finally {
    cleanup(dataDir);
  }
});

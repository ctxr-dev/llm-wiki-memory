// The worker opt-out is an operator-facing switch, so every spelling an operator
// plausibly writes must work. A strict `!== "1"` compare accepted exactly one, and
// silently ignored the rest — indistinguishable from the opt-out taking effect.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { embedMany } from "../scripts/lib/embed.mjs";
import { __resetForTest } from "../scripts/lib/embed-backend-state.mjs";
import { __setWorkerFactoryForTest } from "../scripts/lib/embed-runner.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

const TRANSFORMERS = { embed: { backend: "transformers", model: "test/plain-model" } };

after(() => {
  __setWorkerFactoryForTest(null);
  __resetForTest();
  delete process.env.LWM_EMBED_NO_WORKER;
});

/** @param {string} value @returns {Promise<boolean>} whether the worker was built */
async function workerBuiltWith(value) {
  __resetForTest();
  let built = false;
  __setWorkerFactoryForTest(() => {
    built = true;
    throw new Error("worker construction observed");
  });
  process.env.LWM_EMBED_NO_WORKER = value;
  try {
    await withSettingsOverride(TRANSFORMERS, async () => {
      await embedMany(["hello"]);
    });
  } finally {
    delete process.env.LWM_EMBED_NO_WORKER;
  }
  return built;
}

for (const value of ["1", "true", "TRUE", "yes", "on"]) {
  test(`LWM_EMBED_NO_WORKER=${value} disables the worker`, async () => {
    assert.equal(await workerBuiltWith(value), false, `"${value}" must opt out`);
  });
}

for (const value of ["0", "false", "no", "off"]) {
  test(`LWM_EMBED_NO_WORKER=${value} leaves the worker ENABLED`, async () => {
    assert.equal(await workerBuiltWith(value), true, `"${value}" must not opt out`);
  });
}

test("an unparseable value falls back to the default (worker enabled)", async () => {
  assert.equal(await workerBuiltWith("perhaps"), true, "garbage must not silently opt out");
});

// CHARACTERIZATION tests: they pin behaviour that currently has NO coverage, so
// the embed.mjs split has a safety net over the parts most likely to break
// silently. Every test here must pass against the UNMODIFIED embed.mjs — if one
// only goes green after a refactor, it is describing the refactor, not the
// behaviour, and is worthless as a net.
//
// Three genuinely uncovered paths, found while planning the split:
//   1. syncWorkerRef's ref/unref contract — the fake worker elsewhere stubs both
//      as no-ops and nothing asserts them. This is what stops a one-shot CLI
//      exiting mid-inference.
//   2. the ENTIRE in-process path (LWM_EMBED_NO_WORKER=1) — ~35 lines with no test.
//   3. removeFromCache — no direct test anywhere.
// Plus the warn-once latches, which a split could easily duplicate.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { embed, embedMany, removeFromCache } from "../scripts/lib/embed.mjs";
import { __resetForTest } from "../scripts/lib/embed-backend-state.mjs";
import { __setWorkerFactoryForTest } from "../scripts/lib/embed-runner.mjs";
import { withSettingsOverride } from "../scripts/lib/settings.mjs";

const TRANSFORMERS = { embed: { backend: "transformers", model: "test/plain-model" } };

/**
 * A fake worker that RECORDS ref/unref instead of stubbing them, so the
 * process-liveness contract is observable.
 * @param {(msg: any, worker: any) => void} reply
 */
function makeRecordingWorker(reply) {
  const listeners = new Map();
  /** @type {string[]} */
  const refCalls = [];
  const worker = {
    refCalls,
    postMessage(msg) {
      queueMicrotask(() => reply(msg, worker));
    },
    on(event, cb) {
      listeners.set(event, cb);
    },
    emit(event, arg) {
      listeners.get(event)?.(arg);
    },
    ref() {
      refCalls.push("ref");
    },
    unref() {
      refCalls.push("unref");
    },
    terminate() {},
  };
  return worker;
}

beforeEach(() => {
  __resetForTest();
});

after(() => {
  __setWorkerFactoryForTest(null);
  __resetForTest();
  delete process.env.LWM_EMBED_NO_WORKER;
});

// ─── 1. the worker ref/unref contract ────────────────────────────────────────

test("the worker is REF'd while a request is pending and UNREF'd once it settles", async () => {
  /** @type {any} */
  let created;
  __setWorkerFactoryForTest(() => {
    created = makeRecordingWorker((msg, worker) => {
      // At the moment the request is in flight, the worker must be ref'd — an
      // unref'd worker cannot hold the process open, and a pending promise alone
      // never does, so a one-shot CLI would exit mid-inference.
      assert.ok(worker.refCalls.includes("ref"), "ref() before the reply lands");
      worker.emit("message", { id: msg.id, ok: true, vectors: msg.texts.map(() => [1, 2]) });
    });
    return created;
  });

  await withSettingsOverride(TRANSFORMERS, async () => {
    await embedMany(["a"]);
  });
  assert.equal(created.refCalls.at(-1), "unref", "unref() once nothing is pending");
});

test("the worker is UNREF'd even when the request REJECTS", async () => {
  /** @type {any} */
  let created;
  __setWorkerFactoryForTest(() => {
    created = makeRecordingWorker((msg, worker) => {
      worker.emit("message", { id: msg.id, ok: false, error: "nope" });
    });
    return created;
  });

  await withSettingsOverride(TRANSFORMERS, async () => {
    await embedMany(["a"]); // falls back to lexical; must not leak a ref
  });
  assert.equal(created.refCalls.at(-1), "unref", "a failed request still releases the ref");
});

// ─── 2. the in-process path (LWM_EMBED_NO_WORKER=1) ──────────────────────────

test("LWM_EMBED_NO_WORKER=1 bypasses the worker entirely", async () => {
  let workerBuilt = false;
  __setWorkerFactoryForTest(() => {
    workerBuilt = true;
    return makeRecordingWorker(() => {});
  });
  process.env.LWM_EMBED_NO_WORKER = "1";
  try {
    await withSettingsOverride(TRANSFORMERS, async () => {
      // No real model is downloadable here, so the in-process embedder rejects and
      // the lexical fallback serves the vector. What matters for the split is that
      // the WORKER was never constructed.
      const [vector] = await embedMany(["hello"]);
      assert.ok(Array.isArray(vector) && vector.length > 0, "a vector is still returned");
    });
  } finally {
    delete process.env.LWM_EMBED_NO_WORKER;
  }
  assert.equal(workerBuilt, false, "the worker factory is never called when opted out");
});

test("with the worker disabled, a failure still opens the lexical fallback window", async () => {
  process.env.LWM_EMBED_NO_WORKER = "1";
  try {
    await withSettingsOverride(TRANSFORMERS, async () => {
      const first = await embed("alpha");
      const second = await embed("alpha");
      assert.deepEqual(first, second, "the fallback is deterministic for the same text");
    });
  } finally {
    delete process.env.LWM_EMBED_NO_WORKER;
  }
});

// ─── 3. removeFromCache ──────────────────────────────────────────────────────

test("removeFromCache deletes a present id and is a no-op for an absent one", () => {
  const cache = { entries: { a: { hash: "h", vector: [1] }, b: { hash: "h2", vector: [2] } } };
  removeFromCache(cache, "a");
  assert.deepEqual(Object.keys(cache.entries), ["b"], "the id is gone");

  removeFromCache(cache, "missing");
  assert.deepEqual(Object.keys(cache.entries), ["b"], "an absent id changes nothing");
});

test("removeFromCache leaves OTHER entries untouched (no wholesale clear)", () => {
  const kept = { hash: "h2", vector: [2, 3] };
  const cache = { entries: { a: { hash: "h", vector: [1, 9] }, b: kept } };
  removeFromCache(cache, "a");
  assert.equal(cache.entries.b, kept, "the surviving entry is the same object");
});

// ─── 4. warn-once latches ────────────────────────────────────────────────────

test("the worker-unavailable warning is emitted ONCE across repeated failures", async () => {
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  __setWorkerFactoryForTest(() => {
    throw new Error("worker cannot start");
  });
  try {
    await withSettingsOverride(TRANSFORMERS, async () => {
      await embedMany(["a"]);
      __resetForTest(); // reopen the window so a second attempt really runs
      await embedMany(["b"]);
    });
  } finally {
    process.stderr.write = write;
  }
  const warnings = lines.filter((l) => l.includes("inference worker unavailable"));
  assert.equal(warnings.length, 1, `warned once, got ${warnings.length}: ${warnings.join("")}`);
});

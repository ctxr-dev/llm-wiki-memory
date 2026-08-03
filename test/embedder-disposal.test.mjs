// The disposal seam added when the embedder memo became keyed. Both hazards below were
// MEASURED against the naive `dispose = () => model.dispose?.()`, not theorised:
//
//   1. Use-after-release. The worker's message handler admits concurrent requests, and
//      its error path drops the memo entry. One request's failure therefore released the
//      native session another request was mid-forward-pass on — failing every concurrent
//      embed instead of just its own.
//   2. Async rejection. `dispose()` is async upstream (it awaits `session.release()`), so
//      a rejected returned promise escaped every synchronous try/catch and killed the
//      worker thread as an unhandled rejection.
//
// createEmbedder needs a real model to construct, so these drive the PRODUCTION seam
// (`withDisposal`, exported for exactly this) over a stand-in whose release is observable.
// Binding to the real function is what makes them fail if the seam regresses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { keyedMemo } from "../scripts/lib/keyed-memo.mjs";
import { withDisposal } from "../scripts/lib/embed-inference.mjs";

/**
 * A stand-in embedder with the production disposal contract: release is DEFERRED until
 * no call is in flight, and it is always adapted through a promise.
 * @param {{ releaseFails?: boolean }} [opts]
 */
function fakeEmbedder({ releaseFails = false } = {}) {
  const state = { released: false, releaseCalls: 0, rejectedDuringRun: 0 };
  /** @type {(() => void) | null} */
  let unblock = null;
  const embed = withDisposal(
    async () => {
      await new Promise((r) => {
        unblock = r;
      });
      if (state.released) {
        state.rejectedDuringRun += 1;
        throw new Error("session released mid-run");
      }
      return [[1, 2, 3]];
    },
    async () => {
      state.releaseCalls += 1;
      if (releaseFails) throw new Error("release failed");
      state.released = true;
    },
  );
  return { embed, state, finish: () => unblock?.() };
}

test("a concurrent request is NEVER cut off by another request's eviction", async () => {
  const built = fakeEmbedder();
  const memo = keyedMemo(async () => built.embed, { onEvict: (e) => e.dispose?.() });

  const embedder = await memo.get("k1", null);
  const inFlight = embedder(["a"]); // request B, mid-forward-pass

  memo.resetKey("k1"); // request A fails and drops the memo entry
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(built.state.released, false, "release must WAIT for the in-flight request");

  built.finish();
  const vectors = await inFlight;
  assert.deepEqual(vectors, [[1, 2, 3]], "the concurrent request completes normally");
  assert.equal(built.state.rejectedDuringRun, 0, "no use-after-release");

  await new Promise((r) => setTimeout(r, 5));
  assert.equal(built.state.released, true, "and the session IS released once idle");
});

test("release happens exactly once when idle, not once per eviction call", async () => {
  const built = fakeEmbedder();
  const memo = keyedMemo(async () => built.embed, { onEvict: (e) => e.dispose?.() });
  await memo.get("k1", null);
  memo.resetKey("k1");
  memo.reset();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(built.state.releaseCalls, 1, "an idle embedder releases once");
});

test("an ASYNC release that REJECTS cannot become an unhandled rejection", async () => {
  // The regression: an async disposer's rejection escaped the synchronous try/catch and
  // took the worker thread down. If this test process survives, the adaptation works.
  const built = fakeEmbedder({ releaseFails: true });
  const memo = keyedMemo(async () => built.embed, { onEvict: (e) => e.dispose?.() });
  await memo.get("k1", null);
  memo.reset();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(built.state.releaseCalls, 1, "the release was attempted");
  assert.equal(built.state.released, false, "and it failed, without crashing the process");
});

test("keyedMemo reports an async onEvict rejection once instead of swallowing it", async () => {
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    const memo = keyedMemo(async (v) => v, {
      onEvict: () => Promise.reject(new Error("native release blew up")),
    });
    await memo.get("k1", "a");
    await memo.get("k2", "b");
    await memo.get("k3", "c");
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    process.stderr.write = write;
  }
  const warnings = lines.filter((l) => l.includes("a non-GC resource may have leaked"));
  assert.equal(warnings.length, 1, `warned exactly once, got ${warnings.length}`);
});

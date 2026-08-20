// The keyed promise memo behind every "build it once" latch in the embed stack.
//
// It exists because three separate latches were memoized WITHOUT a key while the
// settings they were built from hot-reload underneath them:
//   - embed-worker.mjs   getEmbedder(opts)       -> used opts on the FIRST message only
//   - embed-runner.mjs   _inProcessEmbedder      -> same
//   - embed.mjs          _tokenizerPromise       -> captured the model on first call
// Meanwhile cacheStamp() re-reads the same settings on every save, so a live
// settings edit changed the STAMP without changing the thing that produced the
// vectors — writing q4 vectors labelled q8, permanently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { keyedMemo, inferenceKey } from "../scripts/lib/keyed-memo.mjs";

test("builds once and reuses while the key is unchanged", async () => {
  let builds = 0;
  const memo = keyedMemo(async (input) => {
    builds += 1;
    return `built:${input}`;
  });
  assert.equal(await memo.get("k1", "a"), "built:a");
  assert.equal(await memo.get("k1", "a"), "built:a");
  assert.equal(builds, 1, "the second call is a memo hit");
});

test("REBUILDS when the key changes — the whole point", async () => {
  let builds = 0;
  const memo = keyedMemo(async (input) => {
    builds += 1;
    return `built:${input}`;
  });
  await memo.get("k1", "a");
  assert.equal(await memo.get("k2", "b"), "built:b", "a changed key yields the NEW value");
  assert.equal(builds, 2);
});

test("a REJECTED build is not latched — the next call retries", async () => {
  let attempts = 0;
  const memo = keyedMemo(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("first attempt fails");
    return "ok";
  });
  await assert.rejects(() => memo.get("k", "x"));
  assert.equal(await memo.get("k", "x"), "ok", "a failed build does not poison the memo");
  assert.equal(attempts, 2);
});

test("reset() drops the memo so the next call rebuilds", async () => {
  let builds = 0;
  const memo = keyedMemo(async () => {
    builds += 1;
    return builds;
  });
  await memo.get("k", null);
  memo.reset();
  await memo.get("k", null);
  assert.equal(builds, 2, "reset forces a rebuild even for the same key");
});

test("concurrent callers on the same key share ONE build", async () => {
  let builds = 0;
  const memo = keyedMemo(async (input) => {
    builds += 1;
    await new Promise((r) => setTimeout(r, 5));
    return input;
  });
  const [a, b] = await Promise.all([memo.get("k", "v"), memo.get("k", "v")]);
  assert.equal(a, "v");
  assert.equal(b, "v");
  assert.equal(builds, 1, "the in-flight promise is shared, not duplicated");
});

// ─── inferenceKey: what counts as "a different embedder" ─────────────────────

test("inferenceKey changes when ANY field that affects the vectors changes", () => {
  const base = { model: "m", dtype: "q4", threads: 2, cacheDir: "/c" };
  const key = inferenceKey(base);
  assert.equal(inferenceKey({ ...base }), key, "same config -> same key");

  for (const [field, value] of [
    ["model", "other"],
    ["dtype", "q8"],
    ["cacheDir", "/d"],
  ]) {
    assert.notEqual(
      inferenceKey({ ...base, [field]: value }),
      key,
      `${field} must change the key — it changes the artefact or its cache stamp`,
    );
  }

  // `threads` reaches only onnxruntime's intraOpNumThreads — never a vector, never the cache
  // stamp — so keying on it bought a full ~300MB model reload for a knob measured as FLAT.
  // It still reaches createEmbedder, so a new build honours it.
  assert.equal(
    inferenceKey({ ...base, threads: 14 }),
    key,
    "threads must NOT change the key: it cannot change the artefact",
  );
});

test("inferenceKey tolerates absent optional fields without collapsing distinct configs", () => {
  assert.notEqual(
    inferenceKey({ model: "m" }),
    inferenceKey({ model: "m", dtype: "q8" }),
    "an unset dtype is not the same config as an explicit one",
  );
  assert.equal(inferenceKey({ model: "m" }), inferenceKey({ model: "m" }));
});

test("inferenceKey cannot be confused by a field value containing the separator", () => {
  // A model id legitimately contains slashes; the key must not alias two configs.
  assert.notEqual(
    inferenceKey({ model: "a", dtype: "b|c" }),
    inferenceKey({ model: "a|b", dtype: "c" }),
    "field boundaries survive a separator inside a value",
  );
});

test("a SYNCHRONOUS throw from build does not corrupt the memo", async () => {
  // The hazard: `memoKey` is assigned BEFORE the build runs. If build throws
  // synchronously, the `.catch` that clears the key never attaches and the
  // assignment `memoized = pending` never happens — leaving memoKey pointing at the
  // NEW key while memoized still holds the OLD value. The next get() for that key
  // would then be a "hit" that returns a value built for a different config.
  let builds = 0;
  const memo = keyedMemo((input) => {
    builds += 1;
    if (input === "boom") throw new Error("sync throw");
    return Promise.resolve(`built:${input}`);
  });

  assert.equal(await memo.get("good", "a"), "built:a");
  await assert.rejects(() => memo.get("bad", "boom"), /sync throw/);

  assert.equal(
    await memo.get("bad", "b"),
    "built:b",
    "after a sync throw the key must NOT be considered satisfied",
  );
  assert.equal(await memo.get("good", "a"), "built:a", "and the good key still rebuilds correctly");
  assert.equal(builds, 4, "each miss built exactly once — no spurious rebuild slipped in");
});

test("a late rejection never clears a NEWER memo entry", async () => {
  let resolveSlow;
  const memo = keyedMemo((input) =>
    input === "slow"
      ? new Promise((_, rej) => {
          resolveSlow = rej;
        })
      : Promise.resolve(`built:${input}`),
  );
  const slow = memo.get("k1", "slow");
  const fast = memo.get("k2", "fast"); // supersedes k1 while k1 is still in flight
  assert.equal(await fast, "built:fast");
  resolveSlow(new Error("late failure"));
  await assert.rejects(() => slow);
  assert.equal(await memo.get("k2", "fast"), "built:fast", "the newer entry survived");
});

// ─── onEvict: releasing what the memo replaces ───────────────────────────────
//
// Keying the memo made a REBUILD possible for the first time. The value being
// replaced can hold memory the JS garbage collector does not manage (a native ONNX
// session), so the memo has to hand it back before it drops the reference.

test("onEvict fires with the REPLACED value when the key changes", async () => {
  const evicted = [];
  const memo = keyedMemo(async (input) => `built:${input}`, {
    onEvict: (value) => evicted.push(value),
  });
  await memo.get("k1", "a");
  await memo.get("k2", "b");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(evicted, ["built:a"], "the superseded value is released, the new one is not");
});

test("onEvict does NOT fire on a memo hit", async () => {
  const evicted = [];
  const memo = keyedMemo(async (input) => `built:${input}`, {
    onEvict: (value) => evicted.push(value),
  });
  await memo.get("k", "a");
  await memo.get("k", "a");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(evicted, [], "a hit replaces nothing, so nothing is released");
});

test("reset() releases the current value", async () => {
  const evicted = [];
  const memo = keyedMemo(async (input) => `built:${input}`, {
    onEvict: (value) => evicted.push(value),
  });
  await memo.get("k", "a");
  memo.reset();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(evicted, ["built:a"]);
});

test("a REJECTED build is never handed to onEvict, and does not break the next get", async () => {
  const evicted = [];
  let attempts = 0;
  const memo = keyedMemo(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("build failed");
      return "ok";
    },
    { onEvict: (value) => evicted.push(value) },
  );
  await assert.rejects(() => memo.get("k1", null));
  assert.equal(await memo.get("k2", null), "ok", "the failed build did not poison eviction");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(evicted, [], "there was nothing to release — the build produced no value");
});

test("an onEvict that THROWS cannot fail the get() that triggered it", async () => {
  const memo = keyedMemo(async (input) => `built:${input}`, {
    onEvict: () => {
      throw new Error("dispose blew up");
    },
  });
  await memo.get("k1", "a");
  assert.equal(
    await memo.get("k2", "b"),
    "built:b",
    "a broken disposer is not the caller's problem",
  );
});

// ─── resetKey: concurrent callers must not evict each other ──────────────────

test("resetKey drops the entry only when the key still matches", async () => {
  let builds = 0;
  const memo = keyedMemo(async (input) => {
    builds += 1;
    return `built:${input}`;
  });
  await memo.get("k1", "a");
  memo.resetKey("k2");
  await memo.get("k1", "a");
  assert.equal(builds, 1, "a reset for a DIFFERENT key leaves the current entry alone");

  memo.resetKey("k1");
  await memo.get("k1", "a");
  assert.equal(builds, 2, "a reset for the current key forces a rebuild");
});

test("resetKey from a stale failure cannot evict a NEWER key's build", async () => {
  // The worker multiplexes concurrent messages against one memo. m1 (key A) fails;
  // meanwhile m2 (key B, corrected settings) has already replaced the entry. An
  // unconditional reset would wipe B and make m3 start a SECOND model load
  // concurrently with the one still running.
  let builds = 0;
  const memo = keyedMemo(async (input) => {
    builds += 1;
    return `built:${input}`;
  });
  await memo.get("A", "a");
  await memo.get("B", "b"); // m2 supersedes
  memo.resetKey("A"); // m1's failure lands late
  assert.equal(await memo.get("B", "b"), "built:b");
  assert.equal(builds, 2, "B was never evicted, so no duplicate load");
});

// ─── use(): a borrow defers eviction ─────────────────────────────────────────
//
// get() hands out the value and records nothing, so an eviction could release a
// resource a caller was still using — or had not yet received. All three shapes below
// were measured against the real embed worker: each released a native inference session
// under live work, which surfaced as a search silently degrading to lexical for 30s.

test("a borrow DEFERS eviction until the work finishes", async () => {
  const evicted = [];
  let release;
  const memo = keyedMemo(async (v) => v, { onEvict: (v) => evicted.push(v) });

  const work = memo.use("k1", "A", async (value) => {
    await new Promise((r) => {
      release = r;
    });
    // The eviction below must NOT have run while this borrow is outstanding.
    assert.deepEqual(evicted, [], "the borrowed value was released mid-use");
    return value;
  });

  await new Promise((r) => setTimeout(r, 0));
  memo.resetKey("k1"); // a concurrent request fails and drops the entry
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(evicted, [], "eviction is queued, not applied, while borrowed");

  release();
  assert.equal(await work, "A");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(evicted, ["A"], "and it drains once the borrow ends");
});

test("a KEY CHANGE cannot release a value a borrower is still awaiting", async () => {
  // The subtlest trigger: get(newKey) evicts the outgoing promise. If that promise is
  // still in flight, the eviction lands the instant it resolves — handing the borrower
  // an already-released value.
  const evicted = [];
  let finishBuildA;
  const memo = keyedMemo(
    async (v) => (v === "A" ? new Promise((r) => (finishBuildA = () => r("A"))) : v),
    { onEvict: (v) => evicted.push(v) },
  );

  let sawEvictedDuringUse = null;
  const work = memo.use("k1", "A", async (value) => {
    sawEvictedDuringUse = [...evicted];
    return value;
  });
  await new Promise((r) => setTimeout(r, 0));

  await memo.use("k2", "B", async (v) => v); // supersedes k1 while A is still building
  finishBuildA();

  assert.equal(await work, "A");
  assert.deepEqual(sawEvictedDuringUse, [], "A was live when its borrower received it");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(evicted, ["A"], "A is released only after its borrower is done");
});

test("concurrent borrows all complete; eviction waits for the LAST one", async () => {
  const evicted = [];
  const gates = [];
  const memo = keyedMemo(async (v) => v, { onEvict: (v) => evicted.push(v) });
  const start = (n) =>
    memo.use("k", "shared", async (value) => {
      await new Promise((r) => gates.push(r));
      assert.deepEqual(evicted, [], `borrow ${n} saw a released value`);
      return value;
    });
  const all = [start(1), start(2), start(3)];
  await new Promise((r) => setTimeout(r, 0));
  memo.reset();
  gates.forEach((g) => g());
  assert.deepEqual(await Promise.all(all), ["shared", "shared", "shared"]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(evicted, ["shared"], "released once, after the last borrow");
});

test("use() propagates the build's rejection and still balances the borrow", async () => {
  const evicted = [];
  const memo = keyedMemo(
    async () => {
      throw new Error("build failed");
    },
    { onEvict: (v) => evicted.push(v) },
  );
  await assert.rejects(() => memo.use("k", null, async (v) => v), /build failed/);
  // A balanced borrow means a later eviction is not queued forever.
  const memo2 = keyedMemo(async (v) => v, { onEvict: (v) => evicted.push(v) });
  await memo2.use("k", "V", async (v) => v);
  memo2.reset();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(evicted, ["V"], "eviction still drains after a failed borrow");
});

test("threads is out of the KEY but still reaches the builder", async () => {
  // The load-bearing half of removing it from the key: a new build must still honour it.
  // Asserted in code, not only in a comment — dropping `threads` from the worker message or
  // from createEmbedder's options would otherwise be a silent, green regression.
  const src = await import("node:fs");
  const runner = src.readFileSync(
    new URL("../scripts/lib/embed-runner.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /threads:\s*embedThreads\(\)/, "inferenceConfig still reads the setting");
  assert.match(runner, /threads,/, "and still ships it to the worker / in-process builder");
  const inference = src.readFileSync(
    new URL("../scripts/lib/embed-inference.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    inference,
    /intraOpNumThreads:\s*threads/,
    "createEmbedder still applies it to the session",
  );
});

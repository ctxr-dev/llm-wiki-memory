// A build-once memo that REBUILDS when its inputs change.
//
// Every expensive singleton in the embed stack (the worker's embedder, the
// in-process embedder, the tokenizer) is built from `settings()`, which
// hot-reloads on an mtime change. An unkeyed `if (!promise) promise = build()`
// latch therefore keeps serving an object built from settings that no longer
// apply — while everything else in the process has already moved on. That is not
// a stale cache, it is a silent correctness bug: the cache stamp is re-read from
// live settings at save time, so vectors from the OLD model get written under the
// NEW model's name and are accepted as valid forever after.
//
// Keying the memo is the fix, and it belongs in one place because the same latch
// was written three times.

/**
 * @template I, V
 * @param {(input: I) => Promise<V>} build
 * @param {{ onEvict?: (value: V) => void }} [opts] released when a value is replaced
 *   or reset — the caller's chance to free a resource the GC cannot (a native ONNX
 *   session). Best-effort: never allowed to reject the get() that triggered it.
 * @returns {{ get: (key: string, input: I) => Promise<V>, use: <R>(key: string, input: I, fn: (value: V) => Promise<R>) => Promise<R>, reset: () => void, resetKey: (key: string) => void }}
 */
export function keyedMemo(build, { onEvict } = {}) {
  /** @type {string | null} */
  let memoKey = null;
  /** @type {Promise<V> | null} */
  let memoized = null;

  let warnedEvictFailure = false;
  // BORROW COUNTING. `get()` hands out the value and keeps no record that it is in use,
  // so an eviction could release a resource a caller was still using — or was about to
  // receive. Three real triggers were measured: a per-request failure evicting the entry
  // a CONCURRENT request was mid-batch on; a key change evicting a build that had not
  // been handed out yet; and an unconditional reset evicting an entry built for another
  // key. Each one released a native inference session out from under live work, which
  // surfaced as a whole search silently degrading to lexical for 30s.
  //
  // So an eviction is QUEUED while any borrow is outstanding and drains at zero. Callers
  // that USE the value must borrow it via `use()`; `get()` remains for callers that only
  // need the value transiently and hold it across no awaits.
  let borrows = 0;
  /** @type {Array<Promise<V>>} */
  let queuedEvictions = [];

  /** @param {Promise<V> | null} promise */
  const evict = (promise) => {
    if (!promise || !onEvict) return;
    if (borrows > 0) {
      queuedEvictions.push(promise);
      return;
    }
    release(promise);
  };

  const drainEvictions = () => {
    if (borrows > 0 || queuedEvictions.length === 0) return;
    const draining = queuedEvictions;
    queuedEvictions = [];
    for (const p of draining) release(p);
  };

  /** @param {Promise<V>} promise */
  const release = (promise) => {
    const dispose = onEvict;
    if (!dispose) return;
    promise.then(
      (value) => {
        // Adapted through Promise.resolve because a disposer may be ASYNC: a rejected
        // returned promise escapes a synchronous try/catch entirely and would take the
        // whole process down as an unhandled rejection.
        Promise.resolve()
          .then(() => dispose(value))
          .catch((err) => {
            // Best-effort, but NOT silent: a failed release leaks whatever the GC does
            // not manage (a native inference session), and a leak presents as quiet
            // degradation rather than a crash — the failure mode that must be reported.
            // Once per memo: a rebuild loop would otherwise flood stderr.
            if (!warnedEvictFailure) {
              const reason = err instanceof Error ? err.message : String(err);
              // Write BEFORE arming, matching warnDowngradeOnce.
              process.stderr.write(
                `keyed-memo: releasing a superseded value failed (${reason}); a non-GC resource may have leaked\n`,
              );
              warnedEvictFailure = true;
            }
          });
      },
      // A superseded build that REJECTED produced no value, so there is nothing to
      // release and nothing to report — that path is handled by the build's own catch.
      () => {},
    );
  };

  return {
    get(key, input) {
      if (memoized && memoKey === key) return memoized;
      evict(memoized);
      // The async wrapper is load-bearing, not style: it turns a SYNCHRONOUS throw
      // from `build` into a rejection. Without it the throw would escape before
      // `memoized` was assigned, leaving memoKey advanced to the new key while
      // memoized still held the OLD value — so the next get() for that key would be
      // a "hit" returning something built for a different config, which is the exact
      // class of bug this module exists to prevent.
      const pending = (async () => build(input))().catch((err) => {
        // Only clear if THIS build is still the current one: a late rejection from a
        // superseded key must not evict a newer, valid entry. A rejected build must
        // not latch either, or one transient failure (a half-written model file, a
        // momentary OOM) disables the backend for the whole process lifetime.
        if (memoized === pending) {
          memoized = null;
          memoKey = null;
        }
        throw err;
      });
      memoKey = key;
      memoized = pending;
      return pending;
    },
    reset() {
      evict(memoized);
      memoKey = null;
      memoized = null;
    },
    // Borrow the value for the duration of `fn`. The borrow is taken BEFORE the build is
    // awaited, so a replacement cannot release the outgoing value while this caller is
    // still waiting for, or working with, it.
    /**
     * @template R
     * @param {string} key @param {I} input @param {(value: V) => Promise<R>} fn
     * @returns {Promise<R>}
     */
    async use(key, input, fn) {
      borrows += 1;
      try {
        return await fn(await this.get(key, input));
      } finally {
        borrows -= 1;
        drainEvictions();
      }
    },
    // Drop the entry ONLY if it is still the one the caller is complaining about.
    // Callers that fail per-request run concurrently against a shared memo, so an
    // unconditional reset lets a stale failure evict a newer, valid build for a
    // DIFFERENT key — which then races a second full model load against it.
    resetKey(key) {
      if (memoKey !== key) return;
      evict(memoized);
      memoKey = null;
      memoized = null;
    },
  };
}

/**
 * The IDENTITY of an embedder: every field that changes the artefact — its vectors or the
 * cache stamp recorded beside them.
 *
 * `threads` is deliberately NOT part of it. It reaches only onnxruntime's
 * `intraOpNumThreads`, never a vector and never `cacheStamp` (model + backend + dtype), so
 * keying on it forced a full ~190MB model reload (the q4 weights; q8 is ~295MB) for a knob
 * `docs/embeddings.md` measures as FLAT — 44.5-45.4 ms/doc across 1-14 threads, on the
 * bge-large path it benchmarked, and the shape carries over — pure cost, and every rebuild is
 * itself an eviction event. A `threads` edit applies at the next natural rebuild or restart;
 * it is still passed to `createEmbedder`, so new builds honour it.
 *
 * JSON encoding rather than a joined string: a model id contains slashes and a dtype could
 * contain any separator we picked, and two different configs must never collapse to one key.
 * @param {{ model?: string, dtype?: string, threads?: number, cacheDir?: string }} config
 * @returns {string}
 */
export function inferenceKey(config) {
  const c = config || {};
  return JSON.stringify([c.model ?? null, c.dtype ?? null, c.cacheDir ?? null]);
}

// A fresh install's first recall blocks ~12s downloading ~219MB and printed NOTHING, which is
// indistinguishable from a hung MCP call. transformers exposes `progress_callback`; this turns its
// event stream into a few legible lines.
//
// The last three tests here exist because a REAL cold download exposed three defects that a
// hand-modelled event stream did not: the total grows as files are discovered (so a percentage runs
// backwards), `done` fires per file (so the first one announced completion while 175MB was still
// pending), and tiny config files round to "0 MB". Unit tests over an idealised single-file stream
// passed through all three.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDownloadReporter } from "../scripts/lib/model-download-progress.mjs";

/** Collects written lines and drives a controllable clock. */
function harness({ minIntervalMs = 1000, quietMs = 0 } = {}) {
  /** @type {string[]} */
  const lines = [];
  let clock = 0;
  const report = makeDownloadReporter({
    label: "embedding model",
    write: (s) => lines.push(String(s)),
    now: () => clock,
    minIntervalMs,
    quietMs,
  });
  return { lines, report, tick: (ms) => (clock += ms) };
}

const MB = 1_000_000;
const progress = (file, loaded, total) => ({ status: "progress", file, loaded, total, name: "m" });

test("the first sizeable progress event reports immediately, so the wait is never silent", () => {
  const { lines, report } = harness();
  report(progress("model.onnx_data", 1 * MB, 200 * MB));
  assert.equal(lines.length, 1, "a user must learn at once that something is downloading");
  assert.match(lines[0], /embedding model/, "naming what is being fetched");
  assert.match(lines[0], /200 MB/, "and the size, so a 219MB wait does not look like a hang");
});

test("a progress_total event is IGNORED, so bytes are never double-counted", () => {
  const { lines, report, tick } = harness();
  report(progress("a.bin", 50 * MB, 100 * MB));
  const afterRaw = lines.length;
  tick(10_000);
  // The wrapper emits this for the SAME bytes already reported above.
  report({ status: "progress_total", progress: 50, loaded: 50 * MB, total: 100 * MB, name: "m" });
  assert.equal(lines.length, afterRaw, "progress_total must produce no output of its own");
});

test("bytes are aggregated across concurrent files, not reported per file", () => {
  const { lines, report, tick } = harness();
  report(progress("weights.onnx_data", 100 * MB, 200 * MB));
  tick(10_000);
  report(progress("tokenizer.json", 10 * MB, 20 * MB));
  assert.match(lines[lines.length - 1], /110 MB of 220 MB/, `got: ${lines[lines.length - 1]}`);
});

test("a later event for the SAME file replaces its byte count rather than adding to it", () => {
  const { lines, report, tick } = harness();
  report(progress("w.bin", 10 * MB, 100 * MB));
  tick(10_000);
  report(progress("w.bin", 90 * MB, 100 * MB));
  assert.match(
    lines[lines.length - 1],
    /90 MB of 100 MB/,
    "a cumulative `loaded` must not be summed",
  );
});

test("output is throttled — a per-chunk event stream cannot flood stderr", () => {
  const { lines, report } = harness({ minIntervalMs: 1000 });
  for (let i = 1; i <= 500; i += 1) report(progress("w.bin", i * 0.4 * MB, 400 * MB));
  assert.ok(lines.length < 25, `500 chunk events produced ${lines.length} lines`);
});

test("a byte milestone reports even inside the throttle window", () => {
  const { lines, report } = harness({ minIntervalMs: 10 ** 9 });
  report(progress("w.bin", 1 * MB, 400 * MB));
  const first = lines.length;
  report(progress("w.bin", 200 * MB, 400 * MB));
  assert.ok(lines.length > first, "200MB of new bytes is worth a line despite the throttle");
});

test("completion is announced exactly once", () => {
  const { lines, report, tick } = harness();
  report(progress("w.bin", 50 * MB, 100 * MB));
  tick(10_000);
  report(progress("w.bin", 100 * MB, 100 * MB));
  tick(10_000);
  report(progress("w.bin", 100 * MB, 100 * MB));
  const doneLines = lines.filter((l) => /ready/i.test(l));
  assert.equal(doneLines.length, 1, `expected one completion line, got ${doneLines.length}`);
});

test("non-progress events alone produce no output", () => {
  const { lines, report } = harness();
  report({ status: "initiate", file: "w.bin", name: "m" });
  report({ status: "done", file: "w.bin", name: "m" });
  report({ status: "ready", task: "feature-extraction", model: "m" });
  assert.deepEqual(lines, [], "there is no byte count to report");
});

// THE cache-hit case, and the reason a duration gate exists at all. A real second run showed a
// fully cached model emitting a complete fake download: transformers dispatches `download`
// unconditionally on both sides of its cacheHit branch, and supplying a callback is itself what
// moves Node off the `arrayBuffer()` shortcut onto the streaming path. No event says which it is,
// so anything that finishes inside the quiet window is treated as a local read.
test("an already-cached model that loads fast stays completely SILENT", () => {
  const { lines, report, tick } = harness({ quietMs: 1500 });
  // 219MB read from local disk, done in 400ms.
  report(progress("weights.onnx_data", 100 * MB, 219 * MB));
  tick(200);
  report(progress("weights.onnx_data", 219 * MB, 219 * MB));
  tick(200);
  report({ status: "ready", task: "feature-extraction", model: "m" });
  assert.deepEqual(lines, [], "a cached load must not claim to be downloading");
});

test("a genuinely slow fetch DOES report, once past the quiet window", () => {
  const { lines, report, tick } = harness({ quietMs: 1500 });
  report(progress("weights.onnx_data", 10 * MB, 219 * MB));
  assert.deepEqual(lines, [], "silent while it might still be a cache read");
  tick(3000);
  report(progress("weights.onnx_data", 40 * MB, 219 * MB));
  assert.equal(lines.length, 1, "past the window, a real download is announced");
  assert.match(lines[0], /40 MB of 219 MB/);
});

test("a malformed event is ignored rather than throwing into the model load", () => {
  const { report } = harness();
  for (const bad of [undefined, null, {}, { status: "progress" }, { status: 42 }]) {
    assert.doesNotThrow(() => report(/** @type {any} */ (bad)));
  }
});

// ── regressions from a real cold download ──────────────────────────────────

// Observed: "downloading ... 96%", then "93%", then "20%", because each newly discovered file adds
// to the denominator. No percentage is reported for exactly this reason; the byte pair stays true.
test("a growing total never produces a backwards-running report", () => {
  const { lines, report, tick } = harness();
  report(progress("tokenizer.json", 20 * MB, 21 * MB));
  tick(10_000);
  report(progress("weights.onnx_data", 25 * MB, 198 * MB));
  for (const l of lines) assert.doesNotMatch(l, /%/, `no percentage may be reported: ${l}`);
  const bytes = lines.map((l) => Number(/(\d+) MB of/.exec(l)?.[1] ?? -1));
  for (let i = 1; i < bytes.length; i += 1) {
    assert.ok(bytes[i] >= bytes[i - 1], `downloaded bytes must never decrease: ${bytes}`);
  }
});

// Observed: "embedding model ready (1 MB)" fired after the 1MB config file, then 219MB followed.
test("completion is not announced while a later file is still pending", () => {
  const { lines, report, tick } = harness();
  report(progress("tokenizer.json", 21 * MB, 21 * MB));
  tick(10_000);
  const afterFirstComplete = lines.filter((l) => /ready/i.test(l)).length;
  report(progress("weights.onnx_data", 10 * MB, 198 * MB));
  tick(10_000);
  report(progress("weights.onnx_data", 198 * MB, 198 * MB));
  const readyLines = lines.filter((l) => /ready/i.test(l));
  assert.equal(readyLines.length, afterFirstComplete + 1, "one more completion, for the real end");
  assert.match(readyLines[readyLines.length - 1], /219 MB/, "reporting the FULL payload");
});

// Observed: eleven lines of "0 MB / 1 MB" for a config file before anything real started.
test("a sub-5MB fetch is silent — no 0 MB noise", () => {
  const { lines, report, tick } = harness();
  for (let i = 1; i <= 10; i += 1) {
    report(progress("config.json", i * 0.1 * MB, 1 * MB));
    tick(10_000);
  }
  assert.deepEqual(lines, [], "a 1MB config file is not worth a word");
});

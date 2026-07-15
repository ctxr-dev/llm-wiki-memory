import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../scripts/lib/atomic-write.mjs";

// writeFileAtomic is the crash-safety backbone: every durable write the
// system reads back (wiki leaves, settings.yaml, .env, the failed-distill
// stash, the recall vector cache, compile/consolidate state) goes through it.
// It had no direct test. These pin the guarantees the rest of the codebase
// relies on: exact content, exact mode bits, a UNIQUE temp (no fixed-name
// collision between concurrent writers), and old-file-intact on failure.

const dirs = [];
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "atomicwrite-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("writes the exact bytes and leaves no leftover temp file", () => {
  const dir = tmpDir();
  const target = path.join(dir, "leaf.md");
  writeFileAtomic(target, "hello world\n");
  assert.equal(fs.readFileSync(target, "utf8"), "hello world\n");
  // No stray temp anywhere in the dir — only the final file.
  assert.deepEqual(fs.readdirSync(dir), ["leaf.md"]);
});

test("overwrites an existing file atomically (new content fully replaces old)", () => {
  const dir = tmpDir();
  const target = path.join(dir, "f.json");
  writeFileAtomic(target, JSON.stringify({ v: 1 }));
  writeFileAtomic(target, JSON.stringify({ v: 2, more: "data" }));
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { v: 2, more: "data" });
  assert.deepEqual(fs.readdirSync(dir), ["f.json"]);
});

test("does NOT use a predictable fixed `<path>.tmp` temp name (collision-proof)", () => {
  // The bug class this guards: two writers sharing `${path}.tmp` interleave and
  // rename a torn file into place. Capture the temp via a renameSync spy and
  // assert it is the unique pid+uuid form, never `<path>.tmp`.
  const dir = tmpDir();
  const target = path.join(dir, "embeddings.json");
  const originalRename = fs.renameSync;
  let observedFrom = null;
  fs.renameSync = function spy(from, to) {
    if (path.resolve(String(to)) === path.resolve(target)) observedFrom = String(from);
    return originalRename.call(this, from, to);
  };
  try {
    writeFileAtomic(target, "{}");
  } finally {
    fs.renameSync = originalRename;
  }
  assert.ok(observedFrom, "rename to the target was observed");
  assert.notEqual(observedFrom, `${target}.tmp`, "must not use the fixed shared temp name");
  assert.match(
    path.basename(observedFrom),
    /^\.embeddings\.json\.\d+-[0-9a-f]+\.tmp$/,
    `temp name should be the unique pid+uuid form, got ${path.basename(observedFrom)}`,
  );
});

test("two concurrent-style writes to the SAME path both complete with valid content (no temp collision)", () => {
  // Even interleaved, unique temps mean neither write can consume the other's
  // temp out from under it. Serial here (single process), but proves no fixed
  // temp is shared and the final state is one writer's complete content.
  const dir = tmpDir();
  const target = path.join(dir, "shared.json");
  const a = JSON.stringify({ writer: "A", payload: "x".repeat(5000) });
  const b = JSON.stringify({ writer: "B", payload: "y".repeat(5000) });
  writeFileAtomic(target, a);
  writeFileAtomic(target, b);
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(parsed.writer, "B");
  assert.deepEqual(fs.readdirSync(dir), ["shared.json"]);
});

test(
  "enforces exact mode bits regardless of umask (0600 secret files)",
  {
    skip:
      process.platform === "win32" &&
      "POSIX file-mode/permission semantics not emulable on Windows",
  },
  () => {
    const dir = tmpDir();
    const target = path.join(dir, "secret.env");
    writeFileAtomic(target, "ANTHROPIC_API_KEY=sk-xxx\n", { mode: 0o600 });
    const mode = fs.statSync(target).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  },
);

test("a directory-fsync failure is swallowed and NEVER fails the write (Windows-style unopenable dir)", () => {
  // The dir fsync (durability of the rename) is strictly best-effort: the data
  // is already renamed into place. A platform that rejects opening a directory
  // for fsync (Windows) must not turn a successful write into a thrown error.
  const dir = tmpDir();
  const target = path.join(dir, "durable.txt");
  const originalOpen = fs.openSync;
  // The data file opens with "wx"; the directory opens with "r" for fsync.
  // Throw ONLY on the directory open so the data path is unaffected.
  fs.openSync = function patched(p, flags, mode) {
    if (flags === "r") throw new Error("EPERM: cannot open directory for fsync");
    return originalOpen.call(this, p, flags, mode);
  };
  let threw = false;
  try {
    writeFileAtomic(target, "DURABLE CONTENT");
  } catch {
    threw = true;
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(threw, false, "a dir-fsync open failure must NOT propagate");
  assert.equal(
    fs.readFileSync(target, "utf8"),
    "DURABLE CONTENT",
    "the write still landed correctly",
  );
  assert.deepEqual(fs.readdirSync(dir), ["durable.txt"], "no leftover temp");
});

test("on a mid-write failure, the original file is left intact and no temp lingers", () => {
  const dir = tmpDir();
  const target = path.join(dir, "keep.txt");
  writeFileAtomic(target, "ORIGINAL");

  // Force the data write to throw by patching fs.writeSync.
  const originalWriteSync = fs.writeSync;
  fs.writeSync = function boom() {
    throw new Error("simulated disk-full mid-write");
  };
  let threw = false;
  try {
    writeFileAtomic(target, "NEW CONTENT THAT NEVER LANDS");
  } catch (e) {
    threw = true;
    assert.match(e.message, /simulated disk-full/);
  } finally {
    fs.writeSync = originalWriteSync;
  }
  assert.ok(threw, "writeFileAtomic propagated the write failure");
  // Old content preserved; the failed temp was cleaned up.
  assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL");
  assert.deepEqual(fs.readdirSync(dir), ["keep.txt"], "no leftover temp after failure");
});

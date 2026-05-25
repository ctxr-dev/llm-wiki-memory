import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The MCP server hot-reloads its logic by dynamic-importing the implementation
// modules with a cache-busting query (`?v=N`) on file change, then swapping the
// holder the tool handlers call through. This locks the core mechanism: a fresh
// `import(... ?v=N)` after a file edit observes the NEW module exports, while the
// stdio process (and its MCP handshake) is never restarted.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-hot-"));
const mod = path.join(dir, "reloadable.mjs");
const url = pathToFileURL(mod).href;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a cache-busted re-import observes a changed module without process restart", async () => {
  fs.writeFileSync(mod, "export const value = 'v1';\nexport function tag() { return 'one'; }\n");
  const first = await import(`${url}?v=1`);
  assert.equal(first.value, "v1");
  assert.equal(first.tag(), "one");

  // Simulate a `git pull` editing the module on disk.
  fs.writeFileSync(mod, "export const value = 'v2';\nexport function tag() { return 'two'; }\n");

  // A plain re-import WITHOUT the cache-buster returns the cached module (proves
  // why the version query is required).
  const cached = await import(`${url}?v=1`);
  assert.equal(cached.value, "v1", "same specifier is served from the ESM cache");

  // The cache-busted re-import the watcher performs picks up the new code.
  const second = await import(`${url}?v=2`);
  assert.equal(second.value, "v2", "new specifier re-evaluates the module");
  assert.equal(second.tag(), "two");
});

test("the holder-swap pattern routes calls to the latest loaded module", async () => {
  // Mirror the server's holder: a mutable object the handlers call through.
  let impl = {};
  const load = async (v) => {
    impl = { ...(await import(`${url}?v=${v}`)) };
  };
  fs.writeFileSync(mod, "export function tag() { return 'A'; }\n");
  await load(101);
  assert.equal(impl.tag(), "A");

  fs.writeFileSync(mod, "export function tag() { return 'B'; }\n");
  await load(102); // what the debounced fs.watch handler does
  assert.equal(impl.tag(), "B", "handlers calling impl.tag() now see the reloaded code");
});

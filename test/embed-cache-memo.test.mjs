import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCache, saveCache } from "../scripts/lib/embed.mjs";

const created = [];
function tmpFile() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-embed-memo-")));
  created.push(dir);
  return path.join(dir, "cache.json");
}
after(() => {
  for (const d of created) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("loadCache returns a memoized object for an unchanged file (no re-parse)", () => {
  const p = tmpFile();
  saveCache(p, { entries: { a: { hash: "h", vector: [0.1, 0.2] } } });
  const a = loadCache(p);
  const b = loadCache(p);
  assert.equal(a, b, "same mtime+size → identical memoized object");
  assert.deepEqual(a.entries.a.vector, [0.1, 0.2]);
});

test("saveCache never persists the in-memory _dirty flag", () => {
  const p = tmpFile();
  saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } }, _dirty: true });
  const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal("_dirty" in onDisk, false);
});

test("loadCache re-reads after an external write changes the file", () => {
  const p = tmpFile();
  saveCache(p, { entries: { a: { hash: "h", vector: [0.1] } } });
  const first = loadCache(p);
  fs.writeFileSync(
    p,
    JSON.stringify({
      model: first.model,
      backend: first.backend,
      dim: 1,
      entries: { a: { hash: "h2", vector: [0.9] }, b: { hash: "h3", vector: [0.8] } },
    }),
  );
  const second = loadCache(p);
  assert.notEqual(first, second, "changed size/mtime invalidates the memo");
  assert.deepEqual(second.entries.a.vector, [0.9]);
});

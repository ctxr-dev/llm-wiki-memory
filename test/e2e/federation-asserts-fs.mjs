import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * @param {string} root
 * @param {string} rel forward-slash relative path
 * @returns {string}
 */
function abs(root, rel) {
  return path.join(root, rel.split("/").join(path.sep));
}

/**
 * @param {string} root
 * @param {{ present?: string[], absent?: string[] }} shape
 * @returns {void}
 */
export function assertFolderTree(root, shape) {
  for (const rel of shape.present || []) {
    assert.ok(fs.existsSync(abs(root, rel)), `expected present: ${rel}`);
  }
  for (const rel of shape.absent || []) {
    assert.ok(!fs.existsSync(abs(root, rel)), `expected absent: ${rel}`);
  }
}

/**
 * @param {string} wikiRoot
 * @param {string} rel
 * @param {boolean} [exists]
 * @returns {string} absolute leaf path
 */
export function assertResolvedLeafPath(wikiRoot, rel, exists = true) {
  const p = abs(wikiRoot, rel);
  assert.equal(fs.existsSync(p), exists, `leaf ${rel} existence`);
  return p;
}

/**
 * @param {unknown} obj
 * @param {string} dotPath
 * @returns {unknown}
 */
function getPath(obj, dotPath) {
  return dotPath.split(".").reduce((/** @type {any} */ acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * @param {string} wikiRoot
 * @param {{ categories?: string[], equal?: Record<string, unknown>, matches?: RegExp[] }} expected
 * @returns {Record<string, unknown>} the parsed layout
 */
export function assertLayoutYaml(wikiRoot, expected) {
  const layoutPath = path.join(wikiRoot, ".layout", "layout.yaml");
  const text = fs.readFileSync(layoutPath, "utf8");
  const doc = /** @type {Record<string, unknown>} */ (parseYaml(text) || {});
  if (expected.categories) {
    const entries = /** @type {{ path: string }[]} */ (Array.isArray(doc.layout) ? doc.layout : []);
    const got = entries.map((e) => e.path).sort();
    assert.deepEqual(got, [...expected.categories].sort(), "layout categories");
  }
  for (const [dp, val] of Object.entries(expected.equal || {})) {
    assert.deepEqual(getPath(doc, dp), val, `layout ${dp}`);
  }
  for (const re of expected.matches || []) {
    assert.match(text, re, `layout matches ${re}`);
  }
  return doc;
}

/**
 * @param {string} dataDir
 * @param {Record<string, unknown>} expectedByDotPath
 * @returns {void}
 */
export function assertSettingsYaml(dataDir, expectedByDotPath) {
  const p = path.join(dataDir, "settings", "settings.yaml");
  const doc = parseYaml(fs.readFileSync(p, "utf8")) || {};
  for (const [dp, val] of Object.entries(expectedByDotPath)) {
    assert.deepEqual(getPath(doc, dp), val, `settings ${dp}`);
  }
}

/**
 * @param {string} dataDir
 * @param {{ present?: string[], absent?: string[] }} spec present/absent UNCOMMENTED env keys
 * @returns {void}
 */
export function assertEnvFile(dataDir, spec) {
  const p = path.join(dataDir, "settings", ".env");
  const lines = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#"));
  const keys = new Set(lines.map((l) => l.split("=")[0].trim()));
  for (const k of spec.present || []) assert.ok(keys.has(k), `.env has uncommented ${k}`);
  for (const k of spec.absent || []) assert.ok(!keys.has(k), `.env lacks uncommented ${k}`);
}

/**
 * @template T
 * @param {{ depth?: number, adjustedConfidence?: number, documentId?: string }[]} hits
 * @param {(h: any) => string} idOf maps a hit to its expected corpus id
 * @param {string[]} expectedOrder deepest/highest first
 * @returns {void}
 */
export function assertDepthOrder(hits, idOf, expectedOrder) {
  const got = hits.map(idOf);
  assert.deepEqual(got, expectedOrder, "recall order by adjustedConfidence");
  for (let i = 1; i < hits.length; i++) {
    const a = hits[i - 1].adjustedConfidence ?? 0;
    const b = hits[i].adjustedConfidence ?? 0;
    assert.ok(a >= b, `adjustedConfidence descending at ${i}`);
  }
}

/**
 * Run an operation twice and assert the snapshot is byte-stable.
 * @template T
 * @param {() => (void | Promise<void>)} run
 * @param {() => T} snapshot
 * @returns {Promise<void>}
 */
export async function assertIdempotent(run, snapshot) {
  await run();
  const first = snapshot();
  await run();
  const second = snapshot();
  assert.deepEqual(second, first, "operation is idempotent (stable snapshot)");
}

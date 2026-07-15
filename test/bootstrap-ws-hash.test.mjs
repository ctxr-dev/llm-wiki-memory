import { test } from "node:test";
import assert from "node:assert/strict";
import { wsHash } from "../scripts/bootstrap/ws-hash.mjs";

test("wsHash: deterministic, 12 lowercase-hex chars, filename-safe", () => {
  const h = wsHash("C:\\Users\\dev\\repos\\proj");
  assert.match(h, /^[0-9a-f]{12}$/, "12 hex chars");
  assert.equal(
    h,
    wsHash("C:\\Users\\dev\\repos\\proj"),
    "deterministic — install and uninstall derive the same id",
  );
});

test("wsHash: distinct workspaces get distinct ids; a prefix sibling does not collide", () => {
  assert.notEqual(wsHash("/a/proj"), wsHash("/a/proj2"));
  assert.notEqual(wsHash("C:\\a\\proj"), wsHash("C:\\a\\other"));
});

test("wsHash: empty input is stable (never throws)", () => {
  assert.match(wsHash(""), /^[0-9a-f]{12}$/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFsRetry, renameWithRetry } from "../scripts/lib/fs-retry.mjs";

test("withFsRetry: retries a transient EBUSY/EPERM/EACCES then succeeds", () => {
  let calls = 0;
  const r = withFsRetry(() => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return "ok";
  });
  assert.equal(r, "ok");
  assert.equal(calls, 3, "retried twice, landed on the third attempt");
});

test("withFsRetry: a non-lock error is rethrown immediately (no retry)", () => {
  let calls = 0;
  assert.throws(
    () =>
      withFsRetry(() => {
        calls++;
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }),
    /gone/,
  );
  assert.equal(calls, 1, "ENOENT is not a lock — thrown on the first attempt");
});

test("withFsRetry: gives up after the bounded attempts (persistent lock)", () => {
  let calls = 0;
  assert.throws(() =>
    withFsRetry(() => {
      calls++;
      throw Object.assign(new Error("stuck"), { code: "EPERM" });
    }),
  );
  assert.equal(calls, 11, "attempt 0 + 10 retries, then rethrows");
});

test("renameWithRetry: retries a locked rename via the injected fn", () => {
  let calls = 0;
  renameWithRetry("a", "b", () => {
    calls++;
    if (calls < 2) throw Object.assign(new Error("busy"), { code: "EEXIST" });
  });
  assert.equal(calls, 2);
});

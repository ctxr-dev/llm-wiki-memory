import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withSystemMaintenance,
  isSystemMaintenance,
  getMaintenanceContext,
} from "../scripts/lib/maintenance-tag.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("isSystemMaintenance: false outside withSystemMaintenance", () => {
  assert.equal(isSystemMaintenance(), false);
});

test("getMaintenanceContext: undefined outside withSystemMaintenance", () => {
  assert.equal(getMaintenanceContext(), undefined);
});

test("withSystemMaintenance: inside, isSystemMaintenance is true and ctx.maintenance is true", () => {
  withSystemMaintenance(() => {
    assert.equal(isSystemMaintenance(), true);
    const ctx = getMaintenanceContext();
    assert.ok(ctx);
    assert.equal(ctx.maintenance, true);
  });
});

test("withSystemMaintenance: returns the fn's return value", () => {
  const result = withSystemMaintenance(() => 42);
  assert.equal(result, 42);
});

test("withSystemMaintenance: returns the fn's async return value (Promise)", async () => {
  const promise = withSystemMaintenance(async () => "ok");
  assert.ok(promise instanceof Promise);
  assert.equal(await promise, "ok");
});

test("withSystemMaintenance: propagates through async/await", async () => {
  const observed = await withSystemMaintenance(async () => {
    await tick();
    return isSystemMaintenance();
  });
  assert.equal(observed, true);
});

test("withSystemMaintenance: propagates through Promise chains", async () => {
  const observed = await withSystemMaintenance(() =>
    Promise.resolve().then(() => isSystemMaintenance()),
  );
  assert.equal(observed, true);
});

test("withSystemMaintenance: outer scope remains false before/after entering", async () => {
  assert.equal(isSystemMaintenance(), false);
  await withSystemMaintenance(async () => {
    await tick();
  });
  assert.equal(isSystemMaintenance(), false);
});

test("withSystemMaintenance: two concurrent windows do not bleed into each other or the outer scope", async () => {
  const outerBetweenSamples = [];

  const a = withSystemMaintenance(async () => {
    await tick();
    const here = isSystemMaintenance();
    await tick();
    return here;
  });

  outerBetweenSamples.push(isSystemMaintenance());

  const b = withSystemMaintenance(async () => {
    await tick();
    const here = isSystemMaintenance();
    await tick();
    return here;
  });

  outerBetweenSamples.push(isSystemMaintenance());

  const [aSeen, bSeen] = await Promise.all([a, b]);
  assert.equal(aSeen, true);
  assert.equal(bSeen, true);
  assert.deepEqual(outerBetweenSamples, [false, false]);
  assert.equal(isSystemMaintenance(), false);
});

test("withSystemMaintenance: synchronous throw propagates and outer scope sees false after", () => {
  assert.throws(
    () =>
      withSystemMaintenance(() => {
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(isSystemMaintenance(), false);
});

test("withSystemMaintenance: async rejection propagates and outer scope sees false after", async () => {
  await assert.rejects(
    withSystemMaintenance(async () => {
      await tick();
      throw new Error("async-boom");
    }),
    /async-boom/,
  );
  assert.equal(isSystemMaintenance(), false);
});

test("withSystemMaintenance: nested calls are idempotent — inner still true, outer scope false after", async () => {
  const innerSeen = await withSystemMaintenance(async () => {
    assert.equal(isSystemMaintenance(), true);
    const seen = await withSystemMaintenance(async () => {
      await tick();
      return isSystemMaintenance();
    });
    assert.equal(isSystemMaintenance(), true);
    return seen;
  });
  assert.equal(innerSeen, true);
  assert.equal(isSystemMaintenance(), false);
});

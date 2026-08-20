import { test, expect } from "vitest";
import { warmHomeWikiGradually } from "./index.mjs";

test("LWM_WEBAPP_NO_WARM=1 short-circuits the gradual warm", async () => {
  const prev = process.env.LWM_WEBAPP_NO_WARM;
  process.env.LWM_WEBAPP_NO_WARM = "1";
  try {
    await expect(warmHomeWikiGradually()).resolves.toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.LWM_WEBAPP_NO_WARM;
    else process.env.LWM_WEBAPP_NO_WARM = prev;
  }
});

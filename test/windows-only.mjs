import { test as baseTest } from "node:test";

// Inverse of skip-windows: runs ONLY on win32 (native PS installer / scheduler).
const NON_WIN_SKIP = { skip: "Windows-only suite (native PowerShell installer)" };

export const test =
  process.platform === "win32"
    ? baseTest
    : (/** @type {string} */ name, /** @type {unknown} */ a, /** @type {unknown} */ b) =>
        baseTest(name, NON_WIN_SKIP, /** @type {() => void} */ (typeof a === "function" ? a : b));

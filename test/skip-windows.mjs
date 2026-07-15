import { test as baseTest } from "node:test";

// A drop-in `test` that skips the whole suite on Windows. For suites that drive a
// POSIX shell script (bootstrap.sh, mcp-config.sh, the sync-embeddings.sh hook) —
// Windows installs via the native bootstrap.ps1, so the POSIX installer/helper
// scripts are not exercised there. The platform-agnostic engine suites still run.
const WIN_SKIP = { skip: "POSIX shell suite; Windows uses the native installer" };

export const test =
  process.platform === "win32"
    ? (/** @type {string} */ name, /** @type {unknown} */ a, /** @type {unknown} */ b) =>
        baseTest(name, WIN_SKIP, /** @type {() => void} */ (typeof a === "function" ? a : b))
    : baseTest;

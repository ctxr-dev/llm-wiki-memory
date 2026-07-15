// Drive the REAL bootstrap.sh in a throwaway $HOME, C14-safe. The engine `src`
// is COPIED into $HOME/.llm-wiki-memory/src as a REAL directory (never a
// symlink — bootstrap.sh's `pwd -P` would resolve a whole-src symlink back to
// the real machine and write there); only node_modules is symlinked back to the
// dev checkout so the skill resolves without a network `npm install`.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC, realTmp, writeLexicalSettings } from "./federation-helpers.mjs";

const SKIP_COPY = new Set(["node_modules", ".git", "test", "docs"]);

/**
 * @param {string} prefix
 * @param {string[]} tmps sink for cleanup
 * @returns {{ home: string, dataDir: string, srcCopy: string }}
 */
export function buildBootstrapHome(prefix, tmps) {
  const home = realTmp(prefix);
  tmps.push(home);
  const dataDir = path.join(home, ".llm-wiki-memory");
  const srcCopy = path.join(dataDir, "src");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(SRC, srcCopy, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(SRC, src);
      return rel === "" || !SKIP_COPY.has(rel.split(path.sep)[0]);
    },
  });
  // 'junction' on Windows: a plain dir symlink needs admin/developer-mode there.
  fs.symlinkSync(
    path.join(SRC, "node_modules"),
    path.join(srcCopy, "node_modules"),
    process.platform === "win32" ? "junction" : undefined,
  );
  writeLexicalSettings(dataDir);
  return { home, dataDir, srcCopy };
}

/**
 * Drive the REAL bootstrap.ps1 (Windows only) in the same throwaway home.
 * @param {{ srcCopy: string, home: string }} h
 * @param {string[]} [args]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runBootstrapPs({ srcCopy, home }, args = []) {
  const r = spawnSync(
    "pwsh",
    ["-NoProfile", "-NonInteractive", "-File", path.join(srcCopy, "bootstrap.ps1"), ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        USERPROFILE: home, // os.homedir() on Windows reads USERPROFILE
        HOME: home,
        LWM_BOOTSTRAP_SKIP_NPM: "1",
        LWM_BOOTSTRAP_SKIP_SCHED_OS: "1",
        MEMORY_EMBED_BACKEND: "lexical",
      },
    },
  );
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * @param {{ srcCopy: string, home: string }} h
 * @param {string[]} [args]
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runBootstrap({ srcCopy, home }, args = []) {
  const r = spawnSync("bash", [path.join(srcCopy, "bootstrap.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      LWM_BOOTSTRAP_SKIP_NPM: "1",
      LWM_BOOTSTRAP_SKIP_SCHED_OS: "1",
      MEMORY_EMBED_BACKEND: "lexical",
    },
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

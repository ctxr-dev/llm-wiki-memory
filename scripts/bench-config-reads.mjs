// Reproduces the config-read numbers recorded in PERFORMANCE.md.
//
// The claim being made there is that caching the `.env` PARSE removes ~6 file reads from every
// `settings()` cache hit. That was previously measured by a throwaway script and deleted, leaving
// figures nobody could check — so this is committed instead.
//
// Two constraints are not optional:
//   - it refuses to run against a real brain. real-brain-guard would reject the import anyway; the
//     explicit check gives a usable message instead of a stack.
//   - it requires a representative `settings/.env`. The file's SIZE is the cost being measured, so
//     an empty one reports a win that will not reproduce. One is synthesised when absent.
//
// Usage:  node scripts/bench-config-reads.mjs [--iterations N]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const iterFlag = process.argv.indexOf("--iterations");
const ITERATIONS = iterFlag !== -1 ? Number(process.argv[iterFlag + 1]) || 20_000 : 20_000;

// A stand-in for a real install's .env: 14 lines / ~695 bytes on the machine these figures came
// from. Parsing cost scales with this, so it is fixed here rather than left to whatever is around.
const SAMPLE_ENV = [
  "# llm-wiki-memory environment",
  "MEMORY_DEFAULT_PROJECT_MODULE=repos",
  "# MEMORY_LLM_PROVIDER=claude",
  "# MEMORY_EMBED_CACHE_DIR=",
  "# ANTHROPIC_API_KEY=",
  "# OPENAI_API_KEY=",
  "MEMORY_FLUSH_SLOT=daily",
  "# MEMORY_LLM_BASE_URL=",
  "# MEMORY_LLM_MODEL=",
  "# MEMORY_SETTINGS_PATH=",
  "# LWM_EMBED_NO_WORKER=",
  "# MEMORY_EMBED_BACKEND=",
  "# LWM_WEBAPP_OPEN=1",
  "# end",
].join("\n");

function prepareDataDir() {
  const supplied = process.env.MEMORY_DATA_DIR;
  if (supplied) {
    const real = fs.realpathSync(supplied);
    const home = fs.realpathSync(os.homedir());
    if (real === path.join(home, ".llm-wiki-memory")) {
      process.stderr.write(
        "refusing to benchmark against the real brain — point MEMORY_DATA_DIR at a throwaway dir, " +
          "or unset it to have one created.\n",
      );
      process.exit(78);
    }
    return supplied;
  }
  // Under $HOME, not os.tmpdir(): a real install lives on the user volume, and macOS
  // /var/folders stats ~16x slower, which alone swings the reported ratio from ~28x to ~4x.
  // Benchmarking on the wrong filesystem produces numbers that cannot reproduce.
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".lwm-bench-"));
  process.env.MEMORY_DATA_DIR = dir;
  process.on("exit", () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  return dir;
}

const dataDir = prepareDataDir();
const envPath = path.join(dataDir, "settings", ".env");
fs.mkdirSync(path.dirname(envPath), { recursive: true });
if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, `${SAMPLE_ENV}\n`);

const { envValue, __resetEnvFileCache } = await import("./lib/env.mjs");
const { settings } = await import("./lib/settings.mjs");

/** @param {string} label @param {() => unknown} fn @param {number} n @returns {number} µs/call */
function bench(label, fn, n = ITERATIONS) {
  for (let i = 0; i < 300; i += 1) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) fn();
  const us = Number(process.hrtime.bigint() - start) / n / 1000;
  process.stdout.write(`  ${label.padEnd(38)}${us.toFixed(2)} us\n`);
  return us;
}

process.stdout.write(`env file: ${fs.statSync(envPath).size} bytes\n\n`);

settings();
envValue("MEMORY_DEFAULT_PROJECT_MODULE");

const cached = bench("envValue (config, cached)", () => envValue("MEMORY_DEFAULT_PROJECT_MODULE"));
const uncached = bench(
  "envValue (forced re-parse)",
  () => {
    __resetEnvFileCache();
    return envValue("MEMORY_DEFAULT_PROJECT_MODULE");
  },
  Math.min(ITERATIONS, 4000),
);
bench("envValue (secret, never cached)", () => envValue("ANTHROPIC_API_KEY"), 5000);
bench("settings() cache HIT", () => settings());

process.stdout.write(
  `\ncache speedup on a config read: ${(uncached / cached).toFixed(1)}x\n` +
    "A stat is ~1us and a parse of this file ~30us, so the ratio is the file-read count removed.\n" +
    "Absolute numbers vary ~16x by filesystem (macOS /var/folders stats far slower than a user\n" +
    "volume), so compare the RATIO across machines, not the microseconds.\n",
);

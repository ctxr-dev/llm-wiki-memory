import { spawn } from "node:child_process";
import { envValue } from "./env.mjs";
import { settings } from "./settings.mjs";
import { isLocalEndpoint } from "./llm-api-providers.mjs";

// Cheap availability probe for the resolved provider. Caller-visible via the
// `get_memory_config` MCP tool and the `where` CLI subcommand. Does NOT hit
// the network — only checks local signals (CLI on PATH / API key in env /
// base URL set) so it can run in every tool-call return without surprising
// latency. Network reachability is left to the actual call.
//
// Returns `{ provider, model, baseUrl, available, reason }`. `baseUrl` is
// present only for openai / openai-compatible.
/**
 * @typedef {Object} HealthResult
 * @property {string} provider
 * @property {boolean} available
 * @property {string} reason
 * @property {string | null} [model]
 * @property {string} [baseUrl]
 */
/** @returns {Promise<HealthResult>} */
export async function health() {
  // The probed provider is: an explicit MEMORY_LLM_PROVIDER *process-env*
  // override, else the HEAD of the resolved settings.providers.chain (which
  // honors the YAML chain + a .env-configured provider + auto-detection + any
  // settings override), else "claude". Reading the chain keeps `cli where`
  // aligned with what the real dispatcher (callLLMChain) actually uses — before
  // this, an install configured entirely via settings.yaml reported "claude"
  // and "CLI not on PATH" even though the pipeline correctly used anthropic.
  //
  // Read process.env directly here, NOT envValue(): envValue also reads the
  // settings/.env file, but a .env-configured provider is NOT an explicit
  // override — buildSettings already folds it into the chain (so a settings
  // override can re-head it). Using envValue would let the .env provider
  // short-circuit the chain and mis-report it (diverging from the dispatcher).
  let provider = (process.env.MEMORY_LLM_PROVIDER || "").trim().toLowerCase();
  if (!provider) {
    try {
      provider = settings().providers.chain[0] || "claude";
    } catch {
      provider = "claude";
    }
  }
  const memModel = envValue("MEMORY_LLM_MODEL", "");
  switch (provider) {
    case "mock":
      return {
        provider,
        available: Boolean(
          envValue("MEMORY_LLM_MOCK_RESPONSE", "") || envValue("MEMORY_LLM_MOCK_FILE", ""),
        ),
        reason: "mock provider; needs MEMORY_LLM_MOCK_RESPONSE or MEMORY_LLM_MOCK_FILE",
      };
    case "claude": {
      const ok = await isCmdAvailable("claude");
      return {
        provider,
        available: ok,
        reason: ok ? "claude CLI on PATH" : "claude CLI not on PATH",
      };
    }
    case "codex": {
      const ok = await isCmdAvailable("codex");
      return {
        provider,
        available: ok,
        reason: ok ? "codex CLI on PATH" : "codex CLI not on PATH",
      };
    }
    case "cursor": {
      const ok = await isCmdAvailable("cursor-agent");
      return {
        provider,
        available: ok,
        reason: ok ? "cursor-agent CLI on PATH" : "cursor-agent CLI not on PATH",
      };
    }
    case "anthropic": {
      const has = Boolean(envValue("ANTHROPIC_API_KEY", "").trim());
      const m = memModel || envValue("ANTHROPIC_MODEL", "");
      return {
        provider,
        model: m || null,
        available: has,
        reason: has ? "ANTHROPIC_API_KEY set" : "ANTHROPIC_API_KEY missing",
      };
    }
    case "openai":
    case "openai-compatible": {
      const baseUrl = (envValue("MEMORY_LLM_BASE_URL", "") || "https://api.openai.com/v1").replace(
        /\/+$/,
        "",
      );
      const apiKey = envValue("OPENAI_API_KEY", "").trim();
      const local = isLocalEndpoint(baseUrl);
      const available = Boolean(apiKey) || local;
      const m = memModel || envValue("OPENAI_MODEL", "");
      return {
        provider,
        baseUrl,
        model: m || null,
        available,
        reason: available
          ? apiKey
            ? "OPENAI_API_KEY set"
            : `local endpoint ${baseUrl} (no key required)`
          : `OPENAI_API_KEY missing for non-local endpoint ${baseUrl}`,
      };
    }
    default:
      return { provider, available: false, reason: `unknown provider: ${provider}` };
  }
}

// Resolve a command on PATH without invoking a shell. `which` lives at
// different paths on different platforms — /usr/bin/which on macOS + glibc
// Linux, /bin/which on Alpine, sometimes only available as a shell builtin
// — so we try each absolute path in turn, then fall back to a tiny
// `sh -c 'command -v ...'` (only when the cmd matches a safe regex, no
// shell-quoting risk). Returns false on every failure path.
const WHICH_PATHS = ["/usr/bin/which", "/bin/which"];

/**
 * @param {string} cmd
 * @returns {Promise<boolean>}
 */
async function isCmdAvailable(cmd) {
  if (typeof cmd !== "string" || !/^[A-Za-z0-9._/-]+$/.test(cmd)) return false;
  for (const whichBin of WHICH_PATHS) {
    const ok = await new Promise((resolve) => {
      let settled = false;
      try {
        const child = spawn(whichBin, [cmd], { stdio: "ignore" });
        child.on("close", (code) => {
          if (!settled) {
            settled = true;
            resolve(code === 0);
          }
        });
        child.on("error", () => {
          if (!settled) {
            settled = true;
            resolve(null);
          } // ENOENT on the which binary itself
        });
      } catch {
        resolve(null);
      }
    });
    if (ok === true) return true;
    if (ok === false) return false; // which ran but cmd missing
    // ok === null -> this `which` binary not present; try the next
  }
  // Fallback: `sh -c 'command -v <cmd>'`. The regex guard above already
  // restricted cmd to a safe charset, so shell interpolation is safe.
  return await new Promise((resolve) => {
    try {
      const child = spawn("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

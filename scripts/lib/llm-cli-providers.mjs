import { spawn } from "node:child_process";
import { reentryEnv } from "./reentry.mjs";
import { augmentSpawnEnv } from "./cron-path.mjs";
import { LLMProviderUnavailable } from "./llm-errors.mjs";

/**
 * The arguments accepted by the CLI-provider dispatch helpers.
 * @typedef {Object} CliCallArgs
 * @property {string} [systemPrompt]
 * @property {string} [userPrompt]
 * @property {number} [timeoutMs]
 */

/**
 * The subset of the `claude --output-format=json` wrapper this helper reads.
 * @typedef {Object} ClaudeCliWrapper
 * @property {string} [result]
 * @property {string} [text]
 * @property {Array<{ text?: string }>} [content]
 */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string | null, timeoutMs?: number, env?: Record<string, string | undefined> }} opts
 * @returns {Promise<string>}
 */
async function spawnCapture(cmd, args, { input, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    // env undefined -> Node inherits process.env (the API providers below
    // never spawn, so only the CLI providers pass an explicit env).
    // augmentSpawnEnv appends well-known CLI install dirs to the child PATH:
    // under launchd/cron's minimal PATH the provider CLIs are otherwise
    // invisible (2026-06-04 incident), and in an interactive session the
    // merge is a no-op dedup.
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: augmentSpawnEnv(env) });
    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];
    // SIGTERM first so the CLI gets a chance to flush auth state /
    // telemetry; SIGKILL after a short grace period if the child ignores it.
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 2000);
      child.once("close", () => clearTimeout(killTimer));
      reject(new LLMProviderUnavailable(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new LLMProviderUnavailable(`${cmd} failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const errOut = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new LLMProviderUnavailable(`${cmd} exited ${code}: ${errOut.trim() || out.trim()}`));
        return;
      }
      resolve(out);
    });

    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

// Build the claude CLI args for a distiller run. Exported for unit tests.
// The distiller only summarises the provided text, so it runs with NO tools
// at all (the CLI equivalent of allowed_tools=[]):
//   --strict-mcp-config + empty --mcp-config -> loads no project MCP servers
//     (pointless here, and a liability: a project MCP server with an invalid
//     tool schema would otherwise make the distiller's own API call fail);
//   --allowedTools "" (empty allow-list) -> no built-in tools either, so the
//     model cannot try to Write the atoms to a file and burn its single turn
//     on a denied tool call. With no tools it must return the JSON as text.
// Do NOT use --bare: it forces ANTHROPIC_API_KEY and never reads subscription
// auth.
/**
 * @param {CliCallArgs} args
 * @returns {string[]}
 */
export function buildClaudeArgs({ systemPrompt, userPrompt }) {
  const args = [
    "-p",
    "--output-format=json",
    "--max-turns=1",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--allowedTools",
    "",
  ];
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  args.push(/** @type {string} */ (userPrompt));
  return args;
}

/**
 * @param {CliCallArgs} args
 * @returns {Promise<string>}
 */
export async function callClaudeCli({ systemPrompt, userPrompt, timeoutMs }) {
  const args = buildClaudeArgs({ systemPrompt, userPrompt });
  // reentryEnv marks the forked distiller so its own session does not re-fire
  // the memory hooks (it would otherwise spawn another distiller, and so on).
  const raw = await spawnCapture("claude", args, {
    timeoutMs,
    env: reentryEnv("memory-distill"),
  });
  try {
    const wrapper = /** @type {ClaudeCliWrapper} */ (JSON.parse(raw));
    if (typeof wrapper?.result === "string") return wrapper.result;
    if (typeof wrapper?.text === "string") return wrapper.text;
    if (Array.isArray(wrapper?.content)) {
      const text = wrapper.content.find((c) => typeof c?.text === "string")?.text;
      if (text) return text;
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * @param {CliCallArgs} args
 * @returns {Promise<string>}
 */
export async function callCodexCli({ systemPrompt, userPrompt, timeoutMs }) {
  const combined = /** @type {string} */ (
    systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt
  );
  const candidates = [
    { args: ["exec", "--json", combined], parse: parseCodexJsonl },
    { args: ["exec", combined], parse: (/** @type {string} */ raw) => raw },
  ];
  // Carry the re-entry guard so a codex distiller does not re-fire the memory
  // hooks. MCP isolation is not applied for codex here: codex exec may not
  // load the project MCP config at all. If a future codex version does, add
  // its no-MCP flag to the candidate args above.
  let lastErr;
  for (const { args, parse } of candidates) {
    try {
      const raw = await spawnCapture("codex", args, {
        timeoutMs,
        env: reentryEnv("memory-distill"),
      });
      const text = parse(raw);
      return text || raw;
    } catch (err) {
      lastErr = err;
      if (
        err instanceof LLMProviderUnavailable &&
        /unknown|unexpected|unrecognized|invalid argument/i.test(err.message)
      ) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new LLMProviderUnavailable("codex exec failed");
}

// Cursor's headless distillation CLI (`cursor-agent --print <prompt>`). Model
// selection is deferred to the binary itself (same as claude / codex CLI),
// so the chain-iteration model loop does not apply here — one attempt per
// occurrence in the chain.
/**
 * @param {CliCallArgs} args
 * @returns {Promise<string>}
 */
export async function callCursorCli({ systemPrompt, userPrompt, timeoutMs }) {
  const combined = /** @type {string} */ (
    systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt
  );
  return spawnCapture("cursor-agent", ["--print", combined], {
    timeoutMs,
    env: reentryEnv("memory-distill"),
  });
}

/**
 * @param {string} raw
 * @returns {string}
 */
function parseCodexJsonl(raw) {
  const lines = String(raw)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  let lastAssistantText = "";
  let lastResultText = "";
  for (const line of lines) {
    /** @type {Record<string, unknown>} */
    let event;
    try {
      event = /** @type {Record<string, unknown>} */ (JSON.parse(line));
    } catch {
      continue;
    }
    // Codex emits JSONL events; collect agent_message / message / result text.
    const candidates = [event?.message, event?.text, event?.delta, event?.content, event?.result];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) {
        const role = String(event?.role || event?.type || "").toLowerCase();
        if (role.includes("result")) lastResultText = c;
        else lastAssistantText = c;
      }
    }
  }
  return lastResultText || lastAssistantText || "";
}

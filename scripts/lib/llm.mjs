import { spawn } from "node:child_process";
import fs from "node:fs";
import { envValue, envInt } from "./env.mjs";
import { reentryEnv } from "./reentry.mjs";

export class LLMProviderUnavailable extends Error {}
export class LLMOutputInvalid extends Error {
  constructor(message, raw) {
    super(message);
    this.raw = raw;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function callLLM({ systemPrompt, userPrompt, maxTokens = 1500 }) {
  const provider = (envValue("MEMORY_LLM_PROVIDER", "claude") || "claude").toLowerCase();
  const timeoutMs = envInt("MEMORY_LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  let raw;
  switch (provider) {
    case "mock":
      // Test/dev provider: return a canned response from MEMORY_LLM_MOCK_RESPONSE
      // (or the file at MEMORY_LLM_MOCK_FILE). Lets flush/compile run hermetically.
      raw = mockResponse();
      break;
    case "claude":
      raw = await callClaudeCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "codex":
      raw = await callCodexCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "anthropic":
      raw = await callAnthropicApi({ systemPrompt, userPrompt, maxTokens, timeoutMs });
      break;
    case "openai":
      raw = await callOpenAiApi({ systemPrompt, userPrompt, maxTokens, timeoutMs });
      break;
    default:
      throw new LLMProviderUnavailable(`Unknown MEMORY_LLM_PROVIDER: ${provider}`);
  }

  return parseStrictJson(raw);
}

export async function callLLMWithRetry(args) {
  try {
    return await callLLM(args);
  } catch (err) {
    if (!(err instanceof LLMOutputInvalid)) throw err;
    const stricter = {
      ...args,
      userPrompt:
        `${args.userPrompt}\n\n---\nIMPORTANT: respond with STRICT JSON only. ` +
        `No prose before or after. No markdown code fences.`,
    };
    return callLLM(stricter);
  }
}

function mockResponse() {
  const inline = envValue("MEMORY_LLM_MOCK_RESPONSE", "");
  if (inline) return inline;
  const file = envValue("MEMORY_LLM_MOCK_FILE", "");
  if (file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      /* fall through */
    }
  }
  throw new LLMProviderUnavailable("MEMORY_LLM_PROVIDER=mock but no MEMORY_LLM_MOCK_RESPONSE/FILE set");
}

function parseStrictJson(raw) {
  const text = stripCodeFence(String(raw || "").trim());
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}\s*$|^\s*\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
    throw new LLMOutputInvalid("LLM output was not valid JSON", text);
  }
}

function stripCodeFence(text) {
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : text;
}

async function spawnCapture(cmd, args, { input, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    // env undefined -> Node inherits process.env (the API providers below
    // never spawn, so only the CLI providers pass an explicit env).
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const stdout = [];
    const stderr = [];
    // SIGTERM first so the CLI gets a chance to flush auth state /
    // telemetry; SIGKILL after a short grace period if the child ignores it.
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
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
  args.push(userPrompt);
  return args;
}

async function callClaudeCli({ systemPrompt, userPrompt, timeoutMs }) {
  const args = buildClaudeArgs({ systemPrompt, userPrompt });
  // reentryEnv marks the forked distiller so its own session does not re-fire
  // the memory hooks (it would otherwise spawn another distiller, and so on).
  const raw = await spawnCapture("claude", args, {
    timeoutMs,
    env: reentryEnv("memory-distill"),
  });
  try {
    const wrapper = JSON.parse(raw);
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

async function callCodexCli({ systemPrompt, userPrompt, timeoutMs }) {
  const combined = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
  const candidates = [
    { args: ["exec", "--json", combined], parse: parseCodexJsonl },
    { args: ["exec", combined], parse: (raw) => raw },
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

function parseCodexJsonl(raw) {
  const lines = String(raw).split(/\r?\n/).filter((l) => l.trim());
  let lastAssistantText = "";
  let lastResultText = "";
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    // Codex emits JSONL events; collect agent_message / message / result text.
    const candidates = [
      event?.message,
      event?.text,
      event?.delta,
      event?.content,
      event?.result,
    ];
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

async function callAnthropicApi({ systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  // Defensive sanitisation: a key copied from a wrapped UI line may carry
  // trailing CR/LF that would CRLF-inject the x-api-key header. Strip it.
  const apiKey = envValue("ANTHROPIC_API_KEY").replace(/[\r\n]+/g, "").trim();
  const model = envValue("ANTHROPIC_MODEL", "claude-sonnet-4-6");
  if (!apiKey) throw new LLMProviderUnavailable("ANTHROPIC_API_KEY not set");

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt || undefined,
    messages: [{ role: "user", content: userPrompt }],
  };

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderUnavailable(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.content?.find?.((c) => c?.type === "text")?.text;
  if (!text) throw new LLMOutputInvalid("Anthropic response missing text content", JSON.stringify(json));
  return text;
}

async function callOpenAiApi({ systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  // Defensive sanitisation: strip stray CR/LF before interpolating into
  // the Bearer header (mirror of the Anthropic helper).
  const apiKey = envValue("OPENAI_API_KEY").replace(/[\r\n]+/g, "").trim();
  const model = envValue("OPENAI_MODEL", "gpt-4o-mini");
  if (!apiKey) throw new LLMProviderUnavailable("OPENAI_API_KEY not set");

  // OpenAI deprecated `max_tokens` in favour of `max_completion_tokens`
  // for newer models (gpt-4o family and later). Send the new key as
  // primary; older models that only accept `max_tokens` ignore it.
  const body = {
    model,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: userPrompt },
    ],
  };

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderUnavailable(`OpenAI API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new LLMOutputInvalid("OpenAI response missing content", JSON.stringify(json));
  return text;
}

async function fetchWithTimeout(url, { timeoutMs, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

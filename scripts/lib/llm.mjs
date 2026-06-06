import { spawn } from "node:child_process";
import fs from "node:fs";
import { envValue, envInt } from "./env.mjs";
import { reentryEnv } from "./reentry.mjs";
import { settings, isCliProvider, isApiProvider } from "./settings.mjs";
import { augmentSpawnEnv } from "./cron-path.mjs";

export class LLMProviderUnavailable extends Error {}
export class LLMOutputInvalid extends Error {
  constructor(message, raw) {
    super(message);
    this.raw = raw;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

// Detect "model is gone / wrong" errors from API providers. Promotes the
// chain iteration: we keep trying within the SAME provider's model list
// before giving up on that provider. Heuristic — providers emit slightly
// different messages, so the matcher errs on the side of including more
// signals than fewer.
export function looksLikeModelNotFound(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("model_not_found") ||
    msg.includes("not_found_error") ||
    msg.includes("model does not exist") ||
    msg.includes("invalid_model") ||
    msg.includes("model not found") ||
    msg.includes("unknown model") ||
    msg.includes("decommissioned") ||
    msg.includes("deprecated_model")
  );
}

// Single attempt at a (provider, model) pair. Returns parsed JSON; throws
// LLMProviderUnavailable / LLMOutputInvalid. The strict-JSON retry that
// previously lived inside callLLMWithRetry is kept at the WRAPPER level (not
// here), so each chain step is exactly one LLM call per pass; the wrapper
// can re-run the whole chain with a stricter prompt if the final answer
// was invalid.
async function attemptProvider({ provider, model, systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  let raw;
  switch (provider) {
    case "mock":
      raw = mockResponse();
      break;
    case "claude":
      raw = await callClaudeCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "codex":
      raw = await callCodexCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "cursor":
      raw = await callCursorCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "anthropic":
      raw = await callAnthropicApi({ systemPrompt, userPrompt, maxTokens, timeoutMs, model });
      break;
    case "openai":
    case "openai-compatible":
      raw = await callOpenAiApi({ systemPrompt, userPrompt, maxTokens, timeoutMs, model });
      break;
    default:
      throw new LLMProviderUnavailable(`Unknown provider in chain: ${provider}`);
  }
  return parseStrictJson(raw);
}

// Iterate the configured provider chain and (per API provider) the model
// list, returning `{ result, provenance }` where `result` is the parsed JSON
// and provenance carries which combinations were tried and which one
// answered. Callers that just want the parsed JSON should use `callLLM`.
//
// Within a provider: a model-not-found / deprecated error advances to the
// next model in the same provider's list. ANY other error (timeout, auth,
// network, output invalid) advances to the NEXT provider — never iterate
// past a transient error within the same provider, since the per-model
// retry budget would multiply by the model-list length.
export async function callLLMChain({ systemPrompt, userPrompt, maxTokens = 1500, configOverride } = {}) {
  // No sync cmdProbe here: detecting "claude on PATH" requires spawning
  // /usr/bin/which, which settings() is synchronous to support. We
  // accept that detectAvailableProviders' default keeps all CLIs in the
  // chain; the dispatcher then fast-fails an absent CLI via the spawn
  // 'error' event and moves on to the next provider — one ENOENT per
  // missing CLI is negligible.
  const config = configOverride || settings();
  const timeoutMs = envInt("MEMORY_LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  const chain = config.providers.chain;
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new LLMProviderUnavailable(
      "no LLM providers configured (chain empty; set MEMORY_LLM_PROVIDER, populate settings/settings.yaml, or supply an API key)",
    );
  }

  const tried = [];
  const failures = [];

  for (const provider of chain) {
    if (provider === "mock" || isCliProvider(provider)) {
      // No per-model loop: mock has no model, CLIs defer to their own
      // logged-in model. One attempt per CLI provider.
      const label = `${provider}:(default)`;
      tried.push(label);
      try {
        const result = await attemptProvider({
          provider,
          model: null,
          systemPrompt,
          userPrompt,
          maxTokens,
          timeoutMs,
        });
        return {
          result,
          provenance: {
            provider_chain_tried: tried.slice(),
            final_provider: label,
            failure_reasons: failures.slice(),
          },
        };
      } catch (err) {
        failures.push({ provider, model: null, error: err?.message || String(err) });
        continue;
      }
    }

    if (isApiProvider(provider)) {
      const models = config.providers[provider]?.models || [];
      if (models.length === 0) {
        failures.push({ provider, model: null, error: "no models configured for provider" });
        continue;
      }
      let movedToNextProvider = false;
      for (const model of models) {
        if (movedToNextProvider) break;
        const label = `${provider}:${model}`;
        tried.push(label);
        try {
          const result = await attemptProvider({
            provider,
            model,
            systemPrompt,
            userPrompt,
            maxTokens,
            timeoutMs,
          });
          return {
            result,
            provenance: {
              provider_chain_tried: tried.slice(),
              final_provider: label,
              failure_reasons: failures.slice(),
            },
          };
        } catch (err) {
          failures.push({ provider, model, error: err?.message || String(err) });
          if (looksLikeModelNotFound(err)) {
            // Try the next model under the same provider.
            continue;
          }
          // Anything else (timeout, auth, output invalid, network) — move
          // on to the next provider.
          movedToNextProvider = true;
        }
      }
      continue;
    }

    failures.push({ provider, model: null, error: `unknown provider in chain: ${provider}` });
  }

  const lastErr = failures[failures.length - 1];
  const detail = lastErr ? `${lastErr.provider}${lastErr.model ? `:${lastErr.model}` : ""}: ${lastErr.error}` : "no providers attempted";
  const err = new LLMProviderUnavailable(`all providers exhausted (${tried.join(", ") || "none"}); last: ${detail}`);
  err.provenance = {
    provider_chain_tried: tried.slice(),
    final_provider: null,
    failure_reasons: failures.slice(),
  };
  throw err;
}

export async function callLLM({ systemPrompt, userPrompt, maxTokens = 1500 } = {}) {
  const { result } = await callLLMChain({ systemPrompt, userPrompt, maxTokens });
  return result;
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

// Per-process call counter for the mock provider. Lets tests inject "first N
// calls fail" patterns via MEMORY_LLM_MOCK_FAIL_INDICES (comma-separated
// indices) without rewriting the dispatcher. The counter is shared across
// the whole process so a chain that retries through the same mock provider
// sees the index advance on every call.
let __mockCallIndex = 0;
export function __resetMockCallIndex() {
  __mockCallIndex = 0;
}

function mockResponse() {
  const current = __mockCallIndex++;
  // Test seam: throw a specific error on the listed call indices so tests
  // can drive the chain through its failure paths without HTTP mocking.
  const failIndices = envValue("MEMORY_LLM_MOCK_FAIL_INDICES", "");
  if (failIndices) {
    const indices = failIndices.split(",").map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
    if (indices.includes(current)) {
      const errType = envValue("MEMORY_LLM_MOCK_FAIL_ERROR", "model_not_found: mock-fail");
      // Use LLMProviderUnavailable so the chain treats it as a real provider
      // failure (transient → next provider, or model_not_found → next model).
      throw new LLMProviderUnavailable(errType);
    }
  }
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
    // augmentSpawnEnv appends well-known CLI install dirs to the child PATH:
    // under launchd/cron's minimal PATH the provider CLIs are otherwise
    // invisible (2026-06-04 incident), and in an interactive session the
    // merge is a no-op dedup.
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: augmentSpawnEnv(env) });
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

// Cursor's headless distillation CLI (`cursor-agent --print <prompt>`). Model
// selection is deferred to the binary itself (same as claude / codex CLI),
// so the chain-iteration model loop does not apply here — one attempt per
// occurrence in the chain.
async function callCursorCli({ systemPrompt, userPrompt, timeoutMs }) {
  const combined = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
  return spawnCapture("cursor-agent", ["--print", combined], {
    timeoutMs,
    env: reentryEnv("memory-distill"),
  });
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

async function callAnthropicApi({ systemPrompt, userPrompt, maxTokens, timeoutMs, model: explicitModel }) {
  // Defensive sanitisation: a key copied from a wrapped UI line may carry
  // trailing CR/LF that would CRLF-inject the x-api-key header. Strip it.
  const apiKey = envValue("ANTHROPIC_API_KEY").replace(/[\r\n]+/g, "").trim();
  // Explicit model from the chain wins; falls back to env overrides. No
  // baked-in fallback string here — model names live only in
  // templates/settings.yaml / settings/settings.yaml / settings/.env.
  const model =
    (explicitModel && String(explicitModel).trim()) ||
    envValue("MEMORY_LLM_MODEL", "") ||
    envValue("ANTHROPIC_MODEL", "");
  if (!apiKey) throw new LLMProviderUnavailable("ANTHROPIC_API_KEY not set");
  if (!model) {
    throw new LLMProviderUnavailable(
      "no Anthropic model configured (set settings/settings.yaml providers.anthropic.models, MEMORY_LLM_MODEL, or ANTHROPIC_MODEL)",
    );
  }

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

// Returns true iff `baseUrl`'s hostname is loopback or RFC1918 (i.e. on a
// trust boundary the user has already accepted). Used to gate
// "API-key-optional" mode: a local model server (ollama, vLLM, lm-studio,
// llama.cpp, litellm) usually has no auth; an external endpoint without a
// key would either fail or, worse, leak prompts to a random host.
export function isLocalEndpoint(baseUrl) {
  try {
    const u = new URL(baseUrl);
    // WHATWG URL keeps the surrounding brackets on an IPv6 hostname (e.g.
    // `[::1]`); strip them so loopback comparison matches the bare address.
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "::1") return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
    const m = h.match(/^172\.(\d+)\.\d+\.\d+$/);
    if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
    return false;
  } catch {
    return false;
  }
}

async function callOpenAiApi({ systemPrompt, userPrompt, maxTokens, timeoutMs, model: explicitModel }) {
  // Defensive sanitisation: strip stray CR/LF before interpolating into
  // the Bearer header (mirror of the Anthropic helper).
  const apiKey = envValue("OPENAI_API_KEY").replace(/[\r\n]+/g, "").trim();
  const baseUrl =
    (envValue("MEMORY_LLM_BASE_URL", "") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const local = isLocalEndpoint(baseUrl);
  if (!apiKey && !local) {
    throw new LLMProviderUnavailable(
      `OPENAI_API_KEY not set; refusing to call ${baseUrl} unauthenticated. ` +
        "Only loopback / RFC1918 endpoints are allowed without an API key " +
        "(set MEMORY_LLM_BASE_URL=http://localhost:11434/v1 for ollama, etc.).",
    );
  }
  // Explicit model wins; falls back to env overrides. No baked-in fallback
  // string — model names live only in templates/settings.yaml /
  // settings/settings.yaml / settings/.env.
  const model =
    (explicitModel && String(explicitModel).trim()) ||
    envValue("MEMORY_LLM_MODEL", "") ||
    envValue("OPENAI_MODEL", "");
  if (!model) {
    throw new LLMProviderUnavailable(
      "no OpenAI-compatible model configured (set settings/settings.yaml providers.openai.models, MEMORY_LLM_MODEL, or OPENAI_MODEL)",
    );
  }

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

  const headers = { "content-type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderUnavailable(
      `OpenAI-compatible API ${res.status} at ${baseUrl}: ${text.slice(0, 300)}`,
    );
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) {
    throw new LLMOutputInvalid("OpenAI-compatible response missing content", JSON.stringify(json));
  }
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

// Cheap availability probe for the resolved provider. Caller-visible via the
// `get_memory_config` MCP tool and the `where` CLI subcommand. Does NOT hit
// the network — only checks local signals (CLI on PATH / API key in env /
// base URL set) so it can run in every tool-call return without surprising
// latency. Network reachability is left to the actual call.
//
// Returns `{ provider, model, baseUrl, available, reason }`. `baseUrl` is
// present only for openai / openai-compatible.
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
        available: Boolean(envValue("MEMORY_LLM_MOCK_RESPONSE", "") || envValue("MEMORY_LLM_MOCK_FILE", "")),
        reason: "mock provider; needs MEMORY_LLM_MOCK_RESPONSE or MEMORY_LLM_MOCK_FILE",
      };
    case "claude": {
      const ok = await isCmdAvailable("claude");
      return { provider, available: ok, reason: ok ? "claude CLI on PATH" : "claude CLI not on PATH" };
    }
    case "codex": {
      const ok = await isCmdAvailable("codex");
      return { provider, available: ok, reason: ok ? "codex CLI on PATH" : "codex CLI not on PATH" };
    }
    case "cursor": {
      const ok = await isCmdAvailable("cursor-agent");
      return { provider, available: ok, reason: ok ? "cursor-agent CLI on PATH" : "cursor-agent CLI not on PATH" };
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
      const baseUrl =
        (envValue("MEMORY_LLM_BASE_URL", "") || "https://api.openai.com/v1").replace(/\/+$/, "");
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
          ? (apiKey ? "OPENAI_API_KEY set" : `local endpoint ${baseUrl} (no key required)`)
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

async function isCmdAvailable(cmd) {
  if (typeof cmd !== "string" || !/^[A-Za-z0-9._/-]+$/.test(cmd)) return false;
  for (const whichBin of WHICH_PATHS) {
    const ok = await new Promise((resolve) => {
      let settled = false;
      try {
        const child = spawn(whichBin, [cmd], { stdio: "ignore" });
        child.on("close", (code) => {
          if (!settled) { settled = true; resolve(code === 0); }
        });
        child.on("error", () => {
          if (!settled) { settled = true; resolve(null); } // ENOENT on the which binary itself
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

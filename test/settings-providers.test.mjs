import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAvailableProviders } from "../scripts/lib/settings-providers.mjs";

// The CLI-add branches are gated on platform (injectable). The API-key adds are
// platform-independent. Clearing the process-env keys keeps the CLI-gate
// assertions independent of the host's real settings/.env.
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
const clearKeys = () => {
  for (const k of KEYS) delete process.env[k];
};

test("detectAvailableProviders: keyless else-branch adds the CLI providers on non-win32", (t) => {
  clearKeys();
  t.after(clearKeys);
  const s = detectAvailableProviders({ platform: "linux" });
  assert.ok(s.has("claude") && s.has("codex") && s.has("cursor"), "CLIs auto-detected on linux");
});

test("detectAvailableProviders: win32 NEVER adds a CLI provider (else-branch — can't spawn a .cmd shim)", (t) => {
  clearKeys();
  t.after(clearKeys);
  const s = detectAvailableProviders({ platform: "win32" });
  assert.ok(
    !s.has("claude") && !s.has("codex") && !s.has("cursor"),
    "no un-spawnable CLI on win32",
  );
});

test("detectAvailableProviders: win32 NEVER adds a CLI provider even when the probe finds it", (t) => {
  clearKeys();
  t.after(clearKeys);
  const s = detectAvailableProviders({ platform: "win32", cmdProbe: () => true });
  assert.ok(!s.has("claude") && !s.has("codex") && !s.has("cursor"), "probe branch also gated");
});

test("detectAvailableProviders: an API key IS added on win32 (fetch-based, no spawn)", (t) => {
  clearKeys();
  t.after(clearKeys);
  process.env.ANTHROPIC_API_KEY = "x";
  const s = detectAvailableProviders({ platform: "win32" });
  assert.ok(s.has("anthropic"), "the fetch-based API provider works on win32");
  assert.ok(!s.has("claude"), "but the CLI provider stays excluded");
});

test("detectAvailableProviders: the cmdProbe is honored on non-win32", (t) => {
  clearKeys();
  t.after(clearKeys);
  const s = detectAvailableProviders({ platform: "linux", cmdProbe: (c) => c === "claude" });
  assert.ok(s.has("claude") && !s.has("codex"), "only the probed CLI is added");
});

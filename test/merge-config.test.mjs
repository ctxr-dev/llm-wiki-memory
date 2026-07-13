// merge-config.mjs merges a top-level key (mcpServers / hooks) from our template
// into the user's JSON config. It must NOT clobber a customized launcher (a
// company-mandated security wrapper on our own server entry) and must NOT drop a
// user's own hooks on a shared event. Driven as a subprocess (it is a CLI script).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MERGE = path.join(SRC, "scripts/merge-config.mjs");

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/** @returns {string} */
function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-")));
  tmps.push(d);
  return d;
}

/** @param {string} file @param {unknown} obj */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
}

/** @param {string} target @param {string} template @param {string} topKey */
function merge(target, template, topKey) {
  const r = spawnSync("node", [MERGE, target, template, topKey], { encoding: "utf8" });
  assert.equal(r.status, 0, `merge-config exited ${r.status}: ${r.stderr}`);
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

test("merge-config mcpServers: a customized (wrapped) llm-wiki-memory entry is PRESERVED, siblings kept", () => {
  const dir = tmp();
  const target = path.join(dir, ".mcp.json");
  const template = path.join(dir, "template.json");
  writeJson(target, {
    mcpServers: {
      "llm-wiki-memory": {
        command: "/usr/local/bin/prompt_security/prompt_security_mcp",
        args: ["node", "${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs"],
      },
      "other-server": { command: "foo" },
    },
  });
  writeJson(template, {
    mcpServers: {
      "llm-wiki-memory": {
        command: "node",
        args: ["${HOME}/.llm-wiki-memory/src/mcp-server/index.mjs"],
      },
    },
  });

  const out = merge(target, template, "mcpServers");
  assert.equal(
    out.mcpServers["llm-wiki-memory"].command,
    "/usr/local/bin/prompt_security/prompt_security_mcp",
    "the mandated wrapper on our own entry survives a re-bootstrap",
  );
  assert.equal(out.mcpServers["other-server"].command, "foo", "a sibling server is untouched");

  // Idempotent: a second merge is byte-stable.
  const before = fs.readFileSync(target, "utf8");
  merge(target, template, "mcpServers");
  assert.equal(fs.readFileSync(target, "utf8"), before, "second merge is byte-stable");
});

test("merge-config mcpServers: a NON-customized entry (same launcher) is refreshed from the template", () => {
  const dir = tmp();
  const target = path.join(dir, ".mcp.json");
  const template = path.join(dir, "template.json");
  writeJson(target, {
    mcpServers: { "llm-wiki-memory": { command: "node", args: ["OLD/path/index.mjs"] } },
  });
  writeJson(template, {
    mcpServers: { "llm-wiki-memory": { command: "node", args: ["NEW/path/index.mjs"] } },
  });

  const out = merge(target, template, "mcpServers");
  assert.deepEqual(
    out.mcpServers["llm-wiki-memory"].args,
    ["NEW/path/index.mjs"],
    "an unwrapped entry (command === template's) is refreshed to the template",
  );
});

test("merge-config mcpServers: a fresh (absent) config gets our server written", () => {
  const dir = tmp();
  const target = path.join(dir, ".mcp.json");
  const template = path.join(dir, "template.json");
  writeJson(template, { mcpServers: { "llm-wiki-memory": { command: "node", args: ["x"] } } });
  const out = merge(target, template, "mcpServers");
  assert.equal(
    out.mcpServers["llm-wiki-memory"].command,
    "node",
    "our server installed on a fresh config",
  );
});

test("merge-config hooks: a user's own hook on a shared event is PRESERVED; ours is appended; idempotent", () => {
  const dir = tmp();
  const target = path.join(dir, "settings.json");
  const template = path.join(dir, "template.json");
  writeJson(target, {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/my/own/hook.sh" }] }] },
  });
  writeJson(template, {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "$HOME/.llm-wiki-memory/src/x.sh" }] }],
    },
  });

  const out = merge(target, template, "hooks");
  const cmds = out.hooks.SessionStart.flatMap((/** @type {{ hooks: { command: string }[] }} */ g) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(cmds.includes("/my/own/hook.sh"), "the user's own hook on SessionStart is preserved");
  assert.ok(cmds.includes("$HOME/.llm-wiki-memory/src/x.sh"), "our hook is appended, not replaced");

  // Idempotent: a re-merge adds nothing (dedupe by command set).
  const before = fs.readFileSync(target, "utf8");
  merge(target, template, "hooks");
  assert.equal(
    fs.readFileSync(target, "utf8"),
    before,
    "re-merge is byte-stable (no duplicate hook)",
  );
});

test("merge-config hooks: a user hook matching ours under a DIFFERENT matcher does NOT suppress ours (OBS2)", () => {
  const dir = tmp();
  const target = path.join(dir, "settings.json");
  const template = path.join(dir, "template.json");
  writeJson(target, {
    hooks: { PostToolUse: [{ matcher: "UserMatcher", hooks: [{ command: "/shared/cmd.sh" }] }] },
  });
  writeJson(template, {
    hooks: { PostToolUse: [{ matcher: "OurMatcher", hooks: [{ command: "/shared/cmd.sh" }] }] },
  });
  const out = merge(target, template, "hooks");
  const matchers = out.hooks.PostToolUse.map((/** @type {{ matcher: string }} */ g) => g.matcher);
  assert.ok(matchers.includes("UserMatcher"), "user group kept");
  assert.ok(
    matchers.includes("OurMatcher"),
    "ours is appended — dedupe is per-(matcher,hooks), so a same-command different-matcher user hook doesn't hide it",
  );
});

test("merge-config hooks: a user's timeout bump on OUR hook does NOT duplicate it on re-merge (command-set dedupe, R4-3)", () => {
  const dir = tmp();
  const target = path.join(dir, "settings.json");
  const template = path.join(dir, "template.json");
  // Our hook is already installed, but the user bumped its timeout (a documented, encouraged customization).
  writeJson(target, {
    hooks: {
      SessionStart: [
        { matcher: "M", hooks: [{ type: "command", command: "/ours.sh", timeout: 200 }] },
      ],
    },
  });
  writeJson(template, {
    hooks: {
      SessionStart: [
        { matcher: "M", hooks: [{ type: "command", command: "/ours.sh", timeout: 15 }] },
      ],
    },
  });
  const out = merge(target, template, "hooks");
  assert.equal(
    out.hooks.SessionStart.length,
    1,
    "no duplicate — dedupe is by (matcher, command set), so a differing timeout doesn't re-append ours",
  );
  assert.equal(
    out.hooks.SessionStart[0].hooks[0].timeout,
    200,
    "the user's bumped timeout is preserved",
  );
});

test("merge-config hooks: dedupe survives inner-key REORDERING of an on-disk group (R4-3)", () => {
  const dir = tmp();
  const target = path.join(dir, "settings.json");
  const template = path.join(dir, "template.json");
  // On-disk object key order differs from the template (a client reserialized it).
  writeJson(target, {
    hooks: { SessionStart: [{ matcher: "M", hooks: [{ command: "/ours.sh", type: "command" }] }] },
  });
  writeJson(template, {
    hooks: { SessionStart: [{ matcher: "M", hooks: [{ type: "command", command: "/ours.sh" }] }] },
  });
  const out = merge(target, template, "hooks");
  assert.equal(
    out.hooks.SessionStart.length,
    1,
    "reordered inner keys still dedupe (command-set, not raw bytes)",
  );
});

test("merge-config hooks: a group with a NON-string/missing command does not crash the dedup (R5)", () => {
  const dir = tmp();
  const target = path.join(dir, "settings.json");
  const template = path.join(dir, "template.json");
  writeJson(target, { hooks: { PostToolUse: [{ hooks: [{ type: "command" }] }] } }); // no command
  writeJson(template, {
    hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "/ours.sh" }] }] },
  });
  const out = merge(target, template, "hooks");
  const cmds = out.hooks.PostToolUse.flatMap((/** @type {{ hooks: { command?: string }[] }} */ g) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(
    cmds.includes("/ours.sh"),
    "ours installs; the malformed user group is preserved, no crash",
  );
});

test("merge-config hooks: a pre-existing NON-array event value is wrapped and merged (GAP6)", () => {
  const dir = tmp();
  const target = path.join(dir, "settings.json");
  const template = path.join(dir, "template.json");
  writeJson(target, { hooks: { SessionStart: { matcher: "U", hooks: [{ command: "/mine" }] } } });
  writeJson(template, {
    hooks: { SessionStart: [{ matcher: "O", hooks: [{ command: "/ours" }] }] },
  });
  const out = merge(target, template, "hooks");
  assert.ok(
    Array.isArray(out.hooks.SessionStart),
    "the scalar event value is wrapped into an array",
  );
  const cmds = out.hooks.SessionStart.flatMap((/** @type {{ hooks: { command: string }[] }} */ g) =>
    g.hooks.map((h) => h.command),
  );
  assert.ok(
    cmds.includes("/mine") && cmds.includes("/ours"),
    "user's scalar group + ours both present",
  );
});

test("merge-config mcpServers: an entry with NO string command is overwritten by the template (documented contract, GAP5)", () => {
  const dir = tmp();
  const target = path.join(dir, ".mcp.json");
  const template = path.join(dir, "template.json");
  // The 'customized' guard keys on a DIFFERING string command; an entry lacking one
  // is not recognized as a wrapper and is refreshed. (A real prompt_security wrapper
  // DOES carry a distinct string command, so this boundary doesn't affect it.)
  writeJson(target, { mcpServers: { "llm-wiki-memory": { type: "sse", url: "http://x" } } });
  writeJson(template, {
    mcpServers: { "llm-wiki-memory": { command: "node", args: ["idx"] } },
  });
  const out = merge(target, template, "mcpServers");
  assert.equal(
    out.mcpServers["llm-wiki-memory"].command,
    "node",
    "no-command entry is overwritten",
  );
});

test("merge-config: a CORRUPT target is backed up to .bak and rewritten from the template (GAP2)", () => {
  const dir = tmp();
  const target = path.join(dir, ".mcp.json");
  const template = path.join(dir, "template.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, "{ this is : not valid json");
  writeJson(template, { mcpServers: { "llm-wiki-memory": { command: "node", args: ["x"] } } });

  const out = merge(target, template, "mcpServers");
  assert.ok(fs.existsSync(`${target}.bak`), "the corrupt target is backed up");
  assert.equal(
    fs.readFileSync(`${target}.bak`, "utf8"),
    "{ this is : not valid json",
    "the backup holds the original bytes (user edits recoverable)",
  );
  assert.ok(out.mcpServers["llm-wiki-memory"], "the target is rewritten from the template");
});

test("merge-config: a top-level ARRAY topKey is reset to {} (warned) then merged, array discarded (R6)", () => {
  const dir = tmp();
  const target = path.join(dir, ".mcp.json");
  const template = path.join(dir, "template.json");
  writeJson(target, { mcpServers: ["stray"] }); // topKey is an ARRAY (typeof "object", truthy)
  writeJson(template, { mcpServers: { "llm-wiki-memory": { command: "node" } } });
  const r = spawnSync("node", [MERGE, target, template, "mcpServers"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /"mcpServers" is not an object; resetting/, "warns on the array reset");
  const out = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.ok(!Array.isArray(out.mcpServers), "no longer an array");
  assert.ok(out.mcpServers["llm-wiki-memory"], "our server merged (the stray array was discarded)");
});

test("merge-config: a top-level SCALAR topKey (hooks: string) is reset to {} (warned) then merged (R6)", () => {
  const dir = tmp();
  const target = path.join(dir, "settings.json");
  const template = path.join(dir, "template.json");
  writeJson(target, { hooks: "oops" }); // typeof !== "object"
  writeJson(template, { hooks: { SessionStart: [{ hooks: [{ command: "/x.sh" }] }] } });
  const r = spawnSync("node", [MERGE, target, template, "hooks"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /"hooks" is not an object; resetting/, "warns on the scalar reset");
  const out = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.ok(out.hooks.SessionStart, "the scalar was discarded and our hooks merged");
});

// The uninstall helper: removes the MCP registration from the JSON client
// configs and the marker-fenced sync-embeddings block from a repo's git hooks,
// idempotently, while preserving other servers / other hook content and NEVER
// touching memory data. Also reports the manual reversals it does not perform.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installSyncEmbeddingsHook, MARKER_START } from "../scripts/lib/mount-git.mjs";
import {
  removeMcpRegistration,
  removeSyncHookBlocks,
  removeMemorySurfaces,
  removeGitignoreBlock,
  removeAgentsSurface,
  removeClaudeHooks,
  manualUninstallSteps,
  uninstall,
} from "../scripts/lib/uninstall.mjs";
import { writeManifest, manifestPath, sha256 } from "../scripts/lib/install-manifest.mjs";
import {
  HASH_MARKER_START,
  HASH_MARKER_END,
  POINTER_FALLBACK_NOTE,
} from "../scripts/lib/memory-surface-constants.mjs";

/** A realistic @-pointer body (matches wire's pointerBody: @-line + fallback note). */
const ptr = (/** @type {string} */ ref) => `@${ref}\n\n${POINTER_FALLBACK_NOTE}\n${ref}\n`;

/** @type {string[]} */
const tmps = [];
function tmp(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `lwm-${prefix}-`)));
  tmps.push(d);
  return d;
}
function gitRepo(prefix) {
  const d = tmp(prefix);
  spawnSync("git", ["-C", d, "init", "-q"], { encoding: "utf8" });
  return d;
}
after(() => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * @param {string} dir
 * @param {string} rel
 * @param {unknown} obj
 */
function writeJson(dir, rel, obj) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

test("removeMcpRegistration deletes only our server, preserving others + top-level keys", () => {
  const ws = tmp("uninstall-mcp");
  writeJson(ws, ".mcp.json", {
    mcpServers: {
      "llm-wiki-memory": { command: "node", args: ["x"] },
      "other-server": { command: "foo" },
    },
    somethingElse: { keep: true },
  });
  writeJson(ws, ".agents/clients/cursor.json", {
    mcpServers: { "llm-wiki-memory": { command: "node" } },
  });

  const res = removeMcpRegistration(ws);
  assert.ok(res.removed.includes(".mcp.json"));
  assert.ok(res.removed.includes(".agents/clients/cursor.json"));

  const mcp = JSON.parse(fs.readFileSync(path.join(ws, ".mcp.json"), "utf8"));
  assert.ok(!("llm-wiki-memory" in mcp.mcpServers), "our server removed");
  assert.ok("other-server" in mcp.mcpServers, "sibling server preserved");
  assert.deepEqual(mcp.somethingElse, { keep: true }, "unrelated top-level key preserved");

  // Idempotent: a second run finds nothing to remove.
  assert.deepEqual(removeMcpRegistration(ws).removed, [], "second run is a no-op");
});

test("removeSyncHookBlocks strips our block, keeps user hook content, deletes inert hooks", () => {
  const repo = gitRepo("uninstall-hook");
  const hooksDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  // A pre-existing user hook: our block gets chained AFTER it.
  fs.writeFileSync(path.join(hooksDir, "post-merge"), "#!/usr/bin/env bash\necho user-hook\n", {
    mode: 0o755,
  });

  const inst = installSyncEmbeddingsHook(repo);
  assert.equal(inst.ok, true);
  assert.ok(
    fs.readFileSync(path.join(hooksDir, "post-merge"), "utf8").includes(MARKER_START),
    "block chained into pre-existing hook",
  );
  assert.ok(fs.existsSync(path.join(hooksDir, "post-checkout")), "fresh hook created by installer");

  const res = removeSyncHookBlocks(repo);
  assert.equal(res.ok, true);
  assert.equal(res.results?.["post-merge"], "stripped");
  assert.equal(res.results?.["post-checkout"], "removed");

  const postMerge = fs.readFileSync(path.join(hooksDir, "post-merge"), "utf8");
  assert.ok(postMerge.includes("echo user-hook"), "user hook content preserved");
  assert.ok(!postMerge.includes(MARKER_START), "our marker gone");
  assert.ok(
    !fs.existsSync(path.join(hooksDir, "post-checkout")),
    "an inert (only-ours) hook is removed",
  );

  // Idempotent: nothing left to strip.
  const again = removeSyncHookBlocks(repo);
  assert.equal(again.results?.["post-merge"], "no-marker");
  assert.equal(again.results?.["post-checkout"], "absent");
});

test("removeMemorySurfaces deletes prefixed @-pointers + strips the AGENTS/CLAUDE block, keeps user files", () => {
  const ws = tmp("uninstall-surfaces");
  fs.mkdirSync(path.join(ws, ".claude/skills"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".claude/skills/llm-wiki-memory-consolidate.md"),
    ptr("~/.llm-wiki-memory/src/templates/skills/consolidate.md"),
  );
  fs.writeFileSync(
    path.join(ws, ".claude/rules/llm-wiki-memory-priority.md"),
    ptr("~/.llm-wiki-memory/src/templates/rules/priority.md"),
  );
  fs.writeFileSync(path.join(ws, ".claude/rules/my-own.md"), "# mine\n");
  fs.writeFileSync(
    path.join(ws, "AGENTS.md"),
    "# Proj\n\nnotes.\n\n<!-- BEGIN llm-wiki-memory -->\n@~/z\n<!-- END llm-wiki-memory -->\n",
  );

  const res = removeMemorySurfaces(ws);
  assert.equal(res.pointers.length, 2, "both prefixed pointers removed");
  assert.ok(res.docs.includes("AGENTS.md"), "AGENTS.md block stripped");
  assert.ok(!fs.existsSync(path.join(ws, ".claude/skills/llm-wiki-memory-consolidate.md")));
  assert.ok(fs.existsSync(path.join(ws, ".claude/rules/my-own.md")), "user file kept");
  const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  assert.match(agents, /# Proj/, "user content preserved");
  assert.ok(!agents.includes("BEGIN llm-wiki-memory"), "our block gone");

  const second = removeMemorySurfaces(ws);
  assert.deepEqual(second, { pointers: [], docs: [], kept: [] }, "idempotent");
});

test("removeMemorySurfaces (manifest): hash-verified — deletes exact matches, KEEPS a drifted file, idempotent", () => {
  const w = tmp("uninstall-manifest");
  fs.mkdirSync(path.join(w, ".claude/skills"), { recursive: true });
  const okBody = "@~/a\n";
  const okRel = ".claude/skills/llm-wiki-memory-a.md";
  const driftRel = ".claude/skills/llm-wiki-memory-b.md";
  fs.writeFileSync(path.join(w, okRel), okBody);
  fs.writeFileSync(path.join(w, driftRel), "USER EDITED THIS\n");
  writeManifest(w, [
    { kind: "file", path: okRel, sha256: sha256(okBody) },
    { kind: "file", path: driftRel, sha256: sha256("@~/original-b\n") },
  ]);

  const res = removeMemorySurfaces(w);
  assert.deepEqual(res.pointers, [okRel], "the exact-match file is removed");
  assert.deepEqual(
    res.kept,
    [driftRel],
    "the drifted file is KEPT + surfaced, never blind-deleted",
  );
  assert.ok(!fs.existsSync(path.join(w, okRel)), "matched file gone");
  assert.ok(fs.existsSync(path.join(w, driftRel)), "drifted file preserved");

  const second = removeMemorySurfaces(w);
  assert.deepEqual(second.pointers, [], "re-run removes nothing new");
  assert.deepEqual(second.kept, [driftRel], "drifted file still tracked + kept (idempotent)");
});

test("removeSyncHookBlocks: repeated install→uninstall cycles do NOT accumulate blank lines in a user hook (R5)", () => {
  const repo = gitRepo("uninstall-hook-cycle");
  const hooksDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const pm = path.join(hooksDir, "post-merge");
  fs.writeFileSync(pm, "#!/usr/bin/env bash\necho USER\n", { mode: 0o755 });
  /** @type {number[]} */ const lengths = [];
  for (let i = 0; i < 3; i += 1) {
    installSyncEmbeddingsHook(repo);
    removeSyncHookBlocks(repo);
    lengths.push(fs.readFileSync(pm, "utf8").length);
  }
  assert.equal(lengths[0], lengths[1], "cycle 1 and 2 produce the same length");
  assert.equal(lengths[1], lengths[2], "and it stays stable (no unbounded blank-line growth)");
  assert.match(fs.readFileSync(pm, "utf8"), /echo USER/, "the user's command is preserved");
});

test("removeSyncHookBlocks reports skipped on a non-repo dir", () => {
  const res = removeSyncHookBlocks(tmp("uninstall-norepo"));
  assert.equal(res.ok, false);
  assert.equal(res.skipped, "not-a-repo");
});

test("scripts/uninstall.mjs CLI (bootstrap --uninstall entrypoint): [ws] fallback tears down the workspace repo's hooks (F6f)", () => {
  const repo = gitRepo("uninstall-cli");
  installSyncEmbeddingsHook(repo);
  assert.ok(fs.existsSync(path.join(repo, ".git", "hooks", "post-merge")), "hook installed");
  const cli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "scripts",
    "uninstall.mjs",
  );
  const r = spawnSync("node", [cli, repo], { encoding: "utf8" });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /"ok": true/, "CLI reports ok");
  for (const ev of ["post-merge", "post-checkout", "post-rewrite"]) {
    assert.ok(
      !fs.existsSync(path.join(repo, ".git", "hooks", ev)),
      `${ev} removed via the CLI's [ws] fallback (empty repoDirs)`,
    );
  }
});

test("removeSyncHookBlocks honors core.hooksPath (husky) on UNINSTALL, not just install (F6e)", () => {
  const repo = gitRepo("uninstall-hookspath");
  spawnSync("git", ["-C", repo, "config", "core.hooksPath", "myhooks"], { encoding: "utf8" });
  installSyncEmbeddingsHook(repo);
  const hooksDir = path.join(repo, "myhooks");
  assert.ok(fs.existsSync(path.join(hooksDir, "post-merge")), "installed into the husky dir");
  assert.ok(
    !fs.existsSync(path.join(repo, ".git", "hooks", "post-merge")),
    "default .git/hooks left untouched",
  );

  const res = removeSyncHookBlocks(repo);
  assert.equal(res.ok, true);
  for (const ev of ["post-merge", "post-checkout", "post-rewrite"]) {
    assert.ok(!fs.existsSync(path.join(hooksDir, ev)), `${ev} removed from the husky dir`);
  }
});

test("uninstall leaves memory data intact, reverses the gitignore block, and reports manual steps", () => {
  const ws = gitRepo("uninstall-data");
  writeJson(ws, ".mcp.json", { mcpServers: { "llm-wiki-memory": { command: "node" } } });
  installSyncEmbeddingsHook(ws);
  fs.writeFileSync(
    path.join(ws, ".gitignore"),
    "node_modules\n\n# >>> llm-wiki-memory >>>\n/.llm-wiki-memory\n# <<< llm-wiki-memory <<<\n",
  );
  const leaf = path.join(ws, ".llm-wiki-memory", "wiki", "knowledge", "keep.md");
  fs.mkdirSync(path.dirname(leaf), { recursive: true });
  fs.writeFileSync(leaf, "# keep me\n");

  const report = uninstall({ workspaceDir: ws });
  assert.ok(report.mcp.removed.includes(".mcp.json"));
  assert.equal(report.gitignore, true, "the gitignore block was mechanically reversed");
  const gi = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.ok(!gi.includes("llm-wiki-memory"), "our fenced gitignore block is gone");
  assert.match(gi, /node_modules/, "the user's own gitignore line survives");
  assert.ok(fs.existsSync(leaf), "memory data is never deleted by uninstall");
  const manualText = report.manual.join("\n");
  assert.ok(!/gitignore/i.test(manualText), "gitignore is now automated, not a manual step");
  assert.match(manualText, /personal/, "manual step names the personal git repo");
  assert.match(manualText, /rm -rf.*\.llm-wiki-memory/, "data deletion stays a manual step");

  const second = uninstall({ workspaceDir: ws });
  assert.deepEqual(second.mcp.removed, [], "second uninstall removes nothing new");
  assert.equal(second.gitignore, false, "gitignore block already gone (idempotent)");
  assert.ok(fs.existsSync(leaf), "memory data still intact after re-run");
});

test("removeGitignoreBlock: strips our fenced block, preserves other lines, idempotent", () => {
  const ws = tmp("uninstall-gi");
  fs.writeFileSync(
    path.join(ws, ".gitignore"),
    "*.log\n\n# >>> llm-wiki-memory >>>\n/.llm-wiki-memory\n/.llm-wiki-memory/state\n# <<< llm-wiki-memory <<<\n",
  );
  assert.equal(removeGitignoreBlock(ws), true, "block stripped");
  const gi = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.match(gi, /\*\.log/, "user line preserved");
  assert.ok(!gi.includes("llm-wiki-memory"), "our block gone");
  assert.equal(removeGitignoreBlock(ws), false, "idempotent: nothing left to strip");
});

test("removeGitignoreBlock: a .gitignore that was ONLY our block is deleted", () => {
  const ws = tmp("uninstall-gi-only");
  fs.writeFileSync(
    path.join(ws, ".gitignore"),
    "# >>> llm-wiki-memory >>>\n/.llm-wiki-memory\n# <<< llm-wiki-memory <<<\n",
  );
  removeGitignoreBlock(ws);
  assert.ok(
    !fs.existsSync(path.join(ws, ".gitignore")),
    "a gitignore that was only our block is removed",
  );
});

test("manualUninstallSteps enumerates ONLY the destructive/data reversals (gitignore, settings.json hooks, codex all automated)", () => {
  const steps = manualUninstallSteps("/tmp/some-ws");
  assert.ok(steps.length >= 2);
  assert.ok(!steps.some((s) => /gitignore/i.test(s)), "gitignore is automated, not a manual step");
  assert.ok(
    !steps.some((s) => /settings\.json|openai-codex/i.test(s)),
    "settings.json hooks + codex TOML are now auto-reversed, no longer manual",
  );
  assert.ok(steps.some((s) => s.includes("personal")));
  assert.ok(
    steps.some((s) => /rm -rf.*\.llm-wiki-memory/.test(s)),
    "data deletion stays manual",
  );
});

const HOOK_CMD = "$HOME/.llm-wiki-memory/src/scripts/hooks";

test("removeAgentsSurface: README removed, OUR emptied MCP configs deleted, .mcp.json + populated configs KEPT", () => {
  const ws = tmp("agents-surface");
  fs.mkdirSync(path.join(ws, ".agents", "clients"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".agents", "README.md"), "our readme\n");
  writeJson(ws, ".agents/mcp.json", { mcpServers: {} });
  writeJson(ws, ".agents/clients/cursor.json", { mcpServers: {} });
  writeJson(ws, ".agents/clients/claude-desktop.json", { mcpServers: { other: { command: "x" } } });
  writeJson(ws, ".mcp.json", { mcpServers: {} });

  const res = removeAgentsSurface(ws);
  assert.ok(res.removed.includes(".agents/README.md"), "README removed");
  assert.ok(res.removed.includes(".agents/mcp.json"), "emptied .agents/mcp.json removed");
  assert.ok(res.removed.includes(".agents/clients/cursor.json"), "emptied cursor.json removed");
  assert.ok(!fs.existsSync(path.join(ws, ".agents", "README.md")));
  assert.ok(!fs.existsSync(path.join(ws, ".agents", "mcp.json")));
  assert.ok(
    fs.existsSync(path.join(ws, ".agents", "clients", "claude-desktop.json")),
    "a config still holding another server is KEPT",
  );
  assert.ok(fs.existsSync(path.join(ws, ".mcp.json")), "user-owned .mcp.json is NEVER deleted");
  assert.deepEqual(removeAgentsSurface(ws).removed, [], "idempotent: 2nd run removes nothing");
});

test("removeAgentsSurface: our codex TOML table is stripped; a file that was ONLY our table is deleted", () => {
  const wsOnly = tmp("codex-only");
  fs.mkdirSync(path.join(wsOnly, ".agents", "clients"), { recursive: true });
  fs.writeFileSync(
    path.join(wsOnly, ".agents", "clients", "openai-codex.toml"),
    '[mcp_servers.llm-wiki-memory]\ncommand = "node"\nargs = ["x"]\n',
  );
  removeAgentsSurface(wsOnly);
  assert.ok(
    !fs.existsSync(path.join(wsOnly, ".agents", "clients", "openai-codex.toml")),
    "a codex TOML that was only our table is deleted",
  );

  const wsMixed = tmp("codex-mixed");
  fs.mkdirSync(path.join(wsMixed, ".agents", "clients"), { recursive: true });
  const codex = path.join(wsMixed, ".agents", "clients", "openai-codex.toml");
  fs.writeFileSync(
    codex,
    '[other]\nkeep = 1\n\n[mcp_servers.llm-wiki-memory]\ncommand = "node"\nargs = ["x"]\n',
  );
  removeAgentsSurface(wsMixed);
  const left = fs.readFileSync(codex, "utf8");
  assert.ok(!/mcp_servers\.llm-wiki-memory/.test(left), "our table stripped");
  assert.match(left, /\[other\]/, "the user's other TOML table survives");
});

test("removeClaudeHooks: prunes OUR hook entries, preserves user hooks + top-level keys, idempotent", () => {
  const ws = tmp("claude-hooks");
  writeJson(ws, ".claude/settings.json", {
    otherKey: true,
    hooks: {
      PostToolUse: [
        {
          matcher: "X",
          hooks: [{ command: `${HOOK_CMD}/exit-plan-mode.sh` }, { command: "user-hook" }],
        },
      ],
      SessionEnd: [{ hooks: [{ command: `${HOOK_CMD}/embed-gc-session-end.sh` }] }],
    },
  });
  const res = removeClaudeHooks(ws);
  assert.equal(res.removed, 2, "both our hook entries removed");
  const parsed = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"));
  assert.equal(parsed.otherKey, true, "top-level user key preserved");
  assert.equal(parsed.hooks.PostToolUse[0].hooks.length, 1, "user hook in the group survives");
  assert.equal(parsed.hooks.PostToolUse[0].hooks[0].command, "user-hook");
  assert.ok(!("SessionEnd" in parsed.hooks), "an event left with no hooks is dropped");
  assert.equal(removeClaudeHooks(ws).removed, 0, "idempotent: 2nd run removes nothing");
});

test("removeClaudeHooks: when hooks empties but OTHER top-level keys exist, the file is KEPT with hooks:{} (GAP1)", () => {
  const ws = tmp("claude-hooks-keep-file");
  writeJson(ws, ".claude/settings.json", {
    permissions: { allow: ["Read"] },
    model: "opus",
    hooks: { SessionEnd: [{ hooks: [{ command: `${HOOK_CMD}/gc.sh` }] }] },
  });
  const res = removeClaudeHooks(ws);
  assert.equal(res.removed, 1);
  assert.ok(
    fs.existsSync(path.join(ws, ".claude", "settings.json")),
    "file kept (other keys present)",
  );
  const parsed = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(parsed.permissions, { allow: ["Read"] }, "user permissions preserved");
  assert.equal(parsed.model, "opus", "user model preserved");
  assert.deepEqual(parsed.hooks, {}, "hooks emptied to {} (event with only-our-hooks dropped)");
});

test("removeClaudeHooks: a group with a NON-array .hooks is preserved verbatim (GAP4)", () => {
  const ws = tmp("claude-hooks-weird-group");
  writeJson(ws, ".claude/settings.json", {
    hooks: {
      PostToolUse: ["a-loose-string-group", { hooks: [{ command: `${HOOK_CMD}/x.sh` }] }],
    },
  });
  const res = removeClaudeHooks(ws);
  assert.equal(res.removed, 1, "our hook removed");
  const parsed = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"));
  assert.ok(
    parsed.hooks.PostToolUse.includes("a-loose-string-group"),
    "an unrecognized (non-array-hooks) group is preserved verbatim",
  );
});

test("removeClaudeHooks: a user's group with an EMPTY hooks:[] is preserved, not dropped (R3-3)", () => {
  const ws = tmp("claude-hooks-empty-group");
  writeJson(ws, ".claude/settings.json", {
    hooks: {
      PostToolUse: [
        { matcher: "Empty", hooks: [] },
        { matcher: "Ours", hooks: [{ command: `${HOOK_CMD}/x.sh` }] },
      ],
    },
  });
  removeClaudeHooks(ws);
  const parsed = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"));
  assert.ok(
    parsed.hooks.PostToolUse.some((/** @type {{ matcher: string }} */ g) => g.matcher === "Empty"),
    "a user's already-empty group survives (dropped ONLY groups that HELD hooks and were all ours)",
  );
  assert.ok(
    !parsed.hooks.PostToolUse.some((/** @type {{ matcher: string }} */ g) => g.matcher === "Ours"),
    "the group that was only our hook is dropped",
  );
});

test("removeClaudeHooks: a settings.json that was ONLY our hooks is deleted", () => {
  const ws = tmp("claude-hooks-only");
  writeJson(ws, ".claude/settings.json", {
    hooks: { SessionEnd: [{ hooks: [{ command: `${HOOK_CMD}/x.sh` }] }] },
  });
  removeClaudeHooks(ws);
  assert.ok(
    !fs.existsSync(path.join(ws, ".claude", "settings.json")),
    "a settings.json holding only our hooks is removed",
  );
});

test("removeGitignoreBlock: an orphan START with no END drops ONLY the stray marker, never user content (B1 invariant)", () => {
  const ws = tmp("gitignore-orphan");
  const before = `node_modules\n${HASH_MARKER_START}\n/.llm-wiki-memory\nUSER-KEPT-LINE\ndist\n`;
  fs.writeFileSync(path.join(ws, ".gitignore"), before);
  removeGitignoreBlock(ws);
  const after = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.doesNotMatch(after, />>> llm-wiki-memory/, "the dangling START marker line is removed");
  assert.match(
    after,
    /USER-KEPT-LINE/,
    "the user's line after the orphan START survives — never stripped to EOF",
  );
  assert.match(after, /node_modules/, "content before the orphan survives");
  assert.match(after, /dist/, "content after the orphan survives");
});

test("removeGitignoreBlock: TWO well-formed blocks are BOTH stripped, user lines preserved (M2)", () => {
  const ws = tmp("gitignore-double");
  fs.writeFileSync(
    path.join(ws, ".gitignore"),
    `node_modules\n${HASH_MARKER_START}\n/.llm-wiki-memory\n${HASH_MARKER_END}\n` +
      `dist\n${HASH_MARKER_START}\n/other\n${HASH_MARKER_END}\n`,
  );
  removeGitignoreBlock(ws);
  const left = fs.readFileSync(path.join(ws, ".gitignore"), "utf8");
  assert.ok(!/llm-wiki-memory/.test(left), "both blocks stripped");
  assert.match(left, /node_modules/);
  assert.match(left, /dist/);
});

test("removeMemorySurfaces: sweeps an orphan prefixed pointer NOT in the manifest; KEEPS a drifted one", () => {
  const ws = tmp("orphan-sweep");
  const surface = ".claude/skills";
  fs.mkdirSync(path.join(ws, surface), { recursive: true });
  const kept = "@~/.llm-wiki-memory/src/a.md\n";
  fs.writeFileSync(path.join(ws, surface, "llm-wiki-memory-drift.md"), "DRIFTED CONTENT\n");
  fs.writeFileSync(
    path.join(ws, surface, "llm-wiki-memory-orphan.md"),
    ptr("~/.llm-wiki-memory/src/templates/rules/orphan.md"),
  );
  writeManifest(ws, [
    { kind: "file", path: `${surface}/llm-wiki-memory-drift.md`, sha256: sha256(kept) },
  ]);

  const res = removeMemorySurfaces(ws);
  assert.ok(
    fs.existsSync(path.join(ws, surface, "llm-wiki-memory-drift.md")),
    "a manifest file whose content drifted is KEPT",
  );
  assert.ok(res.kept.includes(`${surface}/llm-wiki-memory-drift.md`));
  assert.ok(
    !fs.existsSync(path.join(ws, surface, "llm-wiki-memory-orphan.md")),
    "an untracked prefixed orphan is swept",
  );
  assert.ok(res.pointers.includes(`${surface}/llm-wiki-memory-orphan.md`));
});

test("removeMemorySurfaces: a path-escaping manifest artifact is NEVER acted on (M1)", () => {
  const ws = tmp("path-escape");
  const outside = tmp("path-escape-outside");
  const victim = path.join(outside, "victim.txt");
  fs.writeFileSync(victim, "do not touch\n");
  const rel = path.relative(ws, victim);
  writeManifest(ws, [{ kind: "file", path: rel, sha256: sha256("do not touch\n") }]);
  removeMemorySurfaces(ws);
  assert.ok(
    fs.existsSync(victim),
    "an artifact whose path resolves outside the workspace is skipped",
  );
});

test("removeMemorySurfaces: a malformed manifest artifact is skipped without throwing (M3)", () => {
  const ws = tmp("malformed-artifact");
  const goodSurface = ".claude/skills";
  fs.mkdirSync(path.join(ws, goodSurface), { recursive: true });
  const good = "@~/.llm-wiki-memory/src/g.md\n";
  fs.writeFileSync(path.join(ws, goodSurface, "llm-wiki-memory-g.md"), good);
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true });
  fs.writeFileSync(
    manifestPath(ws),
    JSON.stringify({
      version: 1,
      artifacts: [
        null,
        { kind: "file" },
        { kind: "file", path: `${goodSurface}/llm-wiki-memory-g.md`, sha256: sha256(good) },
      ],
    }),
  );
  assert.doesNotThrow(() => removeMemorySurfaces(ws));
  assert.ok(
    !fs.existsSync(path.join(ws, goodSurface, "llm-wiki-memory-g.md")),
    "the well-formed artifact is still removed despite the malformed siblings",
  );
});

test("removeMemorySurfaces: an unknown-kind artifact is PRESERVED in the rewritten manifest (O1)", () => {
  const ws = tmp("preserve-unknown");
  const surface = ".claude/skills";
  fs.mkdirSync(path.join(ws, surface), { recursive: true });
  const body = "@~/.llm-wiki-memory/src/p.md\n";
  fs.writeFileSync(path.join(ws, surface, "llm-wiki-memory-p.md"), body);
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true });
  fs.writeFileSync(
    manifestPath(ws),
    JSON.stringify({
      version: 1,
      artifacts: [
        { kind: "config", path: ".mcp.json", key: "llm-wiki-memory" },
        { kind: "file", path: `${surface}/llm-wiki-memory-p.md`, sha256: sha256(body) },
      ],
    }),
  );
  removeMemorySurfaces(ws);
  const left = JSON.parse(fs.readFileSync(manifestPath(ws), "utf8"));
  assert.equal(left.artifacts.length, 1, "the file artifact is gone, the config artifact remains");
  assert.equal(
    left.artifacts[0].kind,
    "config",
    "an unknown/config kind is preserved, never dropped",
  );
});

test("removeClaudeHooks: a non-array event value and a group with only user hooks are PRESERVED (no data loss)", () => {
  const ws = tmp("claude-hooks-preserve");
  writeJson(ws, ".claude/settings.json", {
    otherKey: 123,
    hooks: {
      PostToolUse: [
        { matcher: "X", hooks: [{ command: `${HOOK_CMD}/exit-plan-mode.sh` }] },
        { matcher: "B", hooks: [{ command: "user-only-hook" }] },
      ],
      WeirdEvent: "a user string value, not an array",
    },
  });
  const res = removeClaudeHooks(ws);
  assert.equal(res.removed, 1, "only our single hook is removed");
  const parsed = JSON.parse(fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"));
  assert.equal(parsed.otherKey, 123, "top-level user key preserved");
  assert.equal(
    parsed.hooks.WeirdEvent,
    "a user string value, not an array",
    "a non-array event value is preserved verbatim, never deleted",
  );
  assert.ok(
    parsed.hooks.PostToolUse.some((/** @type {{ matcher: string }} */ g) => g.matcher === "B"),
    "a group with only user hooks survives",
  );
  assert.ok(
    !parsed.hooks.PostToolUse.some((/** @type {{ matcher: string }} */ g) => g.matcher === "X"),
    "the group that was only our hook is dropped",
  );
});

test("removeMemorySurfaces sweep: a USER's prefixed file (real content) is PRESERVED; a prefixed DIRECTORY never crashes", () => {
  const ws = tmp("sweep-guard");
  const surface = ".claude/skills";
  fs.mkdirSync(path.join(ws, surface), { recursive: true });
  // A user's own file at a reserved name, with real content (no pointer body).
  fs.writeFileSync(path.join(ws, surface, "llm-wiki-memory-my-notes.md"), "# my real notes\n");
  // A prefixed DIRECTORY (pathological) must not throw.
  fs.mkdirSync(path.join(ws, surface, "llm-wiki-memory-weird.md"));
  // A genuine orphan pointer (our body) that SHOULD be swept.
  fs.writeFileSync(
    path.join(ws, surface, "llm-wiki-memory-orphan.md"),
    ptr("~/.llm-wiki-memory/src/templates/rules/orphan.md"),
  );

  assert.doesNotThrow(() => removeMemorySurfaces(ws));
  assert.ok(
    fs.existsSync(path.join(ws, surface, "llm-wiki-memory-my-notes.md")),
    "a user's real-content prefixed file is never blind-deleted",
  );
  assert.ok(
    fs.existsSync(path.join(ws, surface, "llm-wiki-memory-weird.md")),
    "a prefixed directory is left alone (no EISDIR crash)",
  );
  assert.ok(
    !fs.existsSync(path.join(ws, surface, "llm-wiki-memory-orphan.md")),
    "a genuine orphan pointer is still swept",
  );
});

test("removeMemorySurfaces (discovery fallback): a corrupt/version-skewed manifest is removed after discovery", () => {
  const ws = tmp("discovery-manifest");
  const surface = ".claude/skills";
  fs.mkdirSync(path.join(ws, surface), { recursive: true });
  fs.writeFileSync(
    path.join(ws, surface, "llm-wiki-memory-x.md"),
    ptr("~/.llm-wiki-memory/src/templates/skills/x.md"),
  );
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true });
  fs.writeFileSync(manifestPath(ws), JSON.stringify({ version: 0, artifacts: [] }));

  const res = removeMemorySurfaces(ws);
  assert.ok(
    res.pointers.includes(`${surface}/llm-wiki-memory-x.md`),
    "discovery removed the pointer",
  );
  assert.ok(
    !fs.existsSync(manifestPath(ws)),
    "the stale/version-skewed manifest is cleaned up too (converges with the manifest path)",
  );
});

test("uninstall(): multi-repo teardown + FIRST-run positive returns for agents/claudeHooks/hooks (GAP3)", () => {
  const ws = gitRepo("uninstall-multi-ws");
  const repoB = gitRepo("uninstall-multi-b");
  // sync hooks in BOTH the workspace repo and a chained sibling repo
  installSyncEmbeddingsHook(ws);
  installSyncEmbeddingsHook(repoB);
  // the .agents surface + a .claude capture hook we author
  fs.mkdirSync(path.join(ws, ".agents", "clients"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".agents", "README.md"), "our readme\n");
  writeJson(ws, ".claude/settings.json", {
    hooks: { SessionEnd: [{ hooks: [{ command: `${HOOK_CMD}/embed-gc-session-end.sh` }] }] },
  });

  const report = uninstall({ workspaceDir: ws, repoDirs: [ws, repoB] });

  assert.ok(report.hooks[ws], "workspace repo hooks reported");
  assert.ok(report.hooks[repoB], "sibling repo hooks reported");
  const wsResults = /** @type {{ results: Record<string, string> }} */ (report.hooks[ws]).results;
  const bResults = /** @type {{ results: Record<string, string> }} */ (report.hooks[repoB]).results;
  assert.ok(
    Object.values(wsResults).some((s) => s === "stripped" || s === "removed"),
    "workspace repo sync-hook block reversed",
  );
  assert.ok(
    Object.values(bResults).some((s) => s === "stripped" || s === "removed"),
    "sibling repo sync-hook block reversed",
  );
  // On-disk end state (not just the report): both repos' our-only sync hooks are GONE (F6d).
  for (const repo of [ws, repoB]) {
    for (const ev of ["post-merge", "post-checkout", "post-rewrite"]) {
      assert.ok(
        !fs.existsSync(path.join(repo, ".git", "hooks", ev)),
        `${ev} removed on disk from ${path.basename(repo)}`,
      );
    }
  }
  assert.ok(
    report.agents.removed.includes(".agents/README.md"),
    "first-run agents README reported",
  );
  assert.equal(report.claudeHooks.removed, 1, "first-run claudeHooks removal reported");
});

test("removeMemorySurfaces (manifest): an orphan-START doc has its stray marker removed, user tail preserved, block untracked", () => {
  const ws = tmp("block-strip-fail");
  // A doc with our START but no END (the user hand-deleted the END). The stray
  // marker line is removed; the ambiguous tail is left; nothing is deleted to EOF.
  fs.writeFileSync(
    path.join(ws, "AGENTS.md"),
    "<!-- BEGIN llm-wiki-memory -->\nleftover line\nuser tail\n",
  );
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true });
  fs.writeFileSync(
    manifestPath(ws),
    JSON.stringify({
      version: 1,
      artifacts: [{ kind: "block", path: "AGENTS.md", marker: "llm-wiki-memory" }],
    }),
  );

  removeMemorySurfaces(ws);
  const agents = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
  assert.doesNotMatch(agents, /BEGIN llm-wiki-memory/, "the dangling START marker line is removed");
  assert.match(agents, /user tail/, "the user's tail survives (never stripped to EOF)");
  assert.ok(
    !fs.existsSync(manifestPath(ws)),
    "the only artifact was handled → the manifest is dropped (idempotent end state)",
  );
});

test("uninstall: prunes emptied .claude/.cursor PARENT dirs, but KEEPS a .claude holding user content (R4-1)", () => {
  const ws = tmp("uninstall-parents");
  fs.mkdirSync(path.join(ws, ".cursor/rules"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".cursor/rules/llm-wiki-memory-x.md"),
    ptr("~/.llm-wiki-memory/src/templates/rules/x.md"),
  );
  fs.mkdirSync(path.join(ws, ".claude/skills"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".claude/skills/llm-wiki-memory-y.md"),
    ptr("~/.llm-wiki-memory/src/templates/skills/y.md"),
  );
  fs.writeFileSync(path.join(ws, ".claude/user-notes.md"), "# my own notes\n");

  uninstall({ workspaceDir: ws });
  assert.ok(!fs.existsSync(path.join(ws, ".cursor")), "an emptied .cursor parent is pruned");
  assert.ok(fs.existsSync(path.join(ws, ".claude")), "a .claude holding user content is preserved");
  assert.ok(fs.existsSync(path.join(ws, ".claude/user-notes.md")), "the user's file survives");
  assert.ok(
    !fs.existsSync(path.join(ws, ".claude/skills")),
    "the emptied .claude/skills leaf is pruned",
  );
});

test("removeAgentsSurface: our codex table FOLLOWED by another [table] — the trailing user table survives (R4-5.1)", () => {
  const ws = tmp("codex-trailing");
  fs.mkdirSync(path.join(ws, ".agents", "clients"), { recursive: true });
  const codex = path.join(ws, ".agents", "clients", "openai-codex.toml");
  fs.writeFileSync(codex, '[mcp_servers.llm-wiki-memory]\ncommand = "node"\n\n[other]\nkeep = 1\n');
  removeAgentsSurface(ws);
  const left = fs.readFileSync(codex, "utf8");
  assert.ok(!/mcp_servers\.llm-wiki-memory/.test(left), "our leading table stripped");
  assert.match(left, /\[other\]/, "the trailing user table survives (scan stops at the next '[')");
  assert.match(left, /keep = 1/, "its keys survive");
});

test("removeMemorySurfaces (manifest): a file artifact with NO sha256 is KEPT + re-tracked, never blind-deleted (R4-5.2)", () => {
  const ws = tmp("manifest-nohash");
  const surface = ".claude/skills";
  fs.mkdirSync(path.join(ws, surface), { recursive: true });
  const rel = `${surface}/llm-wiki-memory-x.md`;
  fs.writeFileSync(path.join(ws, rel), ptr("~/.llm-wiki-memory/src/templates/skills/x.md"));
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true });
  fs.writeFileSync(
    manifestPath(ws),
    JSON.stringify({ version: 1, artifacts: [{ kind: "file", path: rel }] }),
  );

  removeMemorySurfaces(ws);
  assert.ok(
    fs.existsSync(path.join(ws, rel)),
    "an unverifiable (no-sha256) artifact's file is kept",
  );
  const m = JSON.parse(fs.readFileSync(manifestPath(ws), "utf8"));
  assert.equal(m.artifacts.length, 1, "and it stays tracked in the manifest");
});

test("removeMemorySurfaces (manifest): a tracked file already GONE on disk drops from the manifest (ENOENT → converge, R4-5.3)", () => {
  const ws = tmp("manifest-gone");
  const surface = ".claude/skills";
  fs.mkdirSync(path.join(ws, surface), { recursive: true });
  const rel = `${surface}/llm-wiki-memory-x.md`; // recorded but never created on disk
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true });
  fs.writeFileSync(
    manifestPath(ws),
    JSON.stringify({ version: 1, artifacts: [{ kind: "file", path: rel, sha256: sha256("x") }] }),
  );
  const res = removeMemorySurfaces(ws);
  assert.ok(
    !res.pointers.includes(rel) && !res.kept.includes(rel),
    "an already-absent artifact isn't reported",
  );
  assert.ok(
    !fs.existsSync(manifestPath(ws)),
    "and the manifest converges (dropped, nothing left to track)",
  );
});

test("removeMcpRegistration / removeClaudeHooks: a hand-broken JSON config is left BYTE-untouched (R4-5.4)", () => {
  const ws = tmp("corrupt-json");
  const broken = "{ this is : not valid json";
  fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".mcp.json"), broken);
  fs.writeFileSync(path.join(ws, ".claude", "settings.json"), broken);
  assert.deepEqual(removeMcpRegistration(ws).removed, [], "corrupt .mcp.json → nothing removed");
  assert.equal(removeClaudeHooks(ws).removed, 0, "corrupt settings.json → nothing removed");
  assert.equal(
    fs.readFileSync(path.join(ws, ".mcp.json"), "utf8"),
    broken,
    ".mcp.json bytes untouched",
  );
  assert.equal(
    fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"),
    broken,
    "settings.json bytes untouched",
  );
});

test("removeClaudeHooks: a settings.json with ONLY the user's own hooks is left byte-intact (removed:0, R4-5.5)", () => {
  const ws = tmp("user-only-hooks");
  writeJson(ws, ".claude/settings.json", {
    hooks: { PreToolUse: [{ hooks: [{ command: "/user/only.sh" }] }] },
  });
  const before = fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8");
  assert.equal(removeClaudeHooks(ws).removed, 0, "nothing of ours to remove");
  assert.equal(
    fs.readFileSync(path.join(ws, ".claude", "settings.json"), "utf8"),
    before,
    "a user-only settings.json is not rewritten or deleted (byte-intact)",
  );
});

test("removeMemorySurfaces (manifest): a tracked file path that is a DIRECTORY (EISDIR) is KEPT, not dropped (R5)", () => {
  const ws = tmp("manifest-eisdir");
  const surface = ".claude/skills";
  const rel = `${surface}/llm-wiki-memory-x.md`;
  fs.mkdirSync(path.join(ws, rel), { recursive: true }); // a DIRECTORY at the artifact path
  fs.mkdirSync(path.dirname(manifestPath(ws)), { recursive: true });
  fs.writeFileSync(
    manifestPath(ws),
    JSON.stringify({ version: 1, artifacts: [{ kind: "file", path: rel, sha256: sha256("x") }] }),
  );
  const res = removeMemorySurfaces(ws);
  assert.ok(
    fs.existsSync(path.join(ws, rel)),
    "the directory is not deleted (readFileSync EISDIR → keep)",
  );
  assert.ok(res.kept.includes(rel), "and it is surfaced as kept");
  const m = JSON.parse(fs.readFileSync(manifestPath(ws), "utf8"));
  assert.equal(m.artifacts.length, 1, "still tracked in the manifest");
});

test("removeAgentsSurface: our codex table WITH a dotted sub-table (env) is fully stripped, user table survives (R7)", () => {
  const ws = tmp("codex-subtable");
  fs.mkdirSync(path.join(ws, ".agents", "clients"), { recursive: true });
  const codex = path.join(ws, ".agents", "clients", "openai-codex.toml");
  fs.writeFileSync(
    codex,
    '[mcp_servers.llm-wiki-memory]\ncommand = "node"\n\n[mcp_servers.llm-wiki-memory.env]\nFOO = "bar"\n\n[other]\nkeep = 1\n',
  );
  removeAgentsSurface(ws);
  const left = fs.readFileSync(codex, "utf8");
  assert.ok(
    !/mcp_servers\.llm-wiki-memory/.test(left),
    "both our table AND its .env sub-table are stripped",
  );
  assert.match(left, /\[other\]/, "the unrelated user table survives");
  assert.match(left, /keep = 1/);
});

test("removeAgentsSurface: a codex TOML with ONLY a user table (no table of ours) is left byte-untouched (R5)", () => {
  const ws = tmp("codex-useronly");
  fs.mkdirSync(path.join(ws, ".agents", "clients"), { recursive: true });
  const codex = path.join(ws, ".agents", "clients", "openai-codex.toml");
  const body = '[mcp_servers.user-thing]\ncommand = "x"\n';
  fs.writeFileSync(codex, body);
  removeAgentsSurface(ws);
  assert.ok(fs.existsSync(codex), "a codex TOML without our table is left in place");
  assert.equal(fs.readFileSync(codex, "utf8"), body, "byte-untouched");
});

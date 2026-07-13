// The uninstall helper: removes the MCP registration from the JSON client
// configs and the marker-fenced sync-embeddings block from a repo's git hooks,
// idempotently, while preserving other servers / other hook content and NEVER
// touching memory data. Also reports the manual reversals it does not perform.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installSyncEmbeddingsHook, MARKER_START } from "../scripts/lib/mount-git.mjs";
import {
  removeMcpRegistration,
  removeSyncHookBlocks,
  removeMemorySurfaces,
  manualUninstallSteps,
  uninstall,
} from "../scripts/lib/uninstall.mjs";

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
  fs.writeFileSync(path.join(ws, ".claude/skills/llm-wiki-memory-consolidate.md"), "@~/x\n");
  fs.writeFileSync(path.join(ws, ".claude/rules/llm-wiki-memory-priority.md"), "@~/y\n");
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
  assert.deepEqual(second, { pointers: [], docs: [] }, "idempotent");
});

test("removeSyncHookBlocks reports skipped on a non-repo dir", () => {
  const res = removeSyncHookBlocks(tmp("uninstall-norepo"));
  assert.equal(res.ok, false);
  assert.equal(res.skipped, "not-a-repo");
});

test("uninstall leaves memory data intact and reports manual steps", () => {
  const ws = gitRepo("uninstall-data");
  writeJson(ws, ".mcp.json", { mcpServers: { "llm-wiki-memory": { command: "node" } } });
  installSyncEmbeddingsHook(ws);
  // Seed memory data that must survive.
  const leaf = path.join(ws, ".llm-wiki-memory", "wiki", "knowledge", "keep.md");
  fs.mkdirSync(path.dirname(leaf), { recursive: true });
  fs.writeFileSync(leaf, "# keep me\n");

  const report = uninstall({ workspaceDir: ws });
  assert.ok(report.mcp.removed.includes(".mcp.json"));
  assert.ok(fs.existsSync(leaf), "memory data is never deleted by uninstall");
  assert.ok(Array.isArray(report.manual) && report.manual.length >= 1, "manual steps reported");
  const manualText = report.manual.join("\n");
  assert.match(manualText, /\.gitignore/, "manual step names the gitignore reversal");
  assert.match(manualText, /personal/, "manual step names the personal git repo");
  assert.match(manualText, /rm -rf.*\.llm-wiki-memory/, "manual step names deleting the mount");

  // Idempotent end to end.
  const second = uninstall({ workspaceDir: ws });
  assert.deepEqual(second.mcp.removed, [], "second uninstall removes nothing new");
  assert.ok(fs.existsSync(leaf), "memory data still intact after re-run");
});

test("manualUninstallSteps enumerates the non-automated reversals", () => {
  const steps = manualUninstallSteps("/tmp/some-ws");
  assert.ok(steps.length >= 3);
  assert.ok(steps.some((s) => s.includes(".gitignore")));
  assert.ok(steps.some((s) => s.includes("personal")));
});

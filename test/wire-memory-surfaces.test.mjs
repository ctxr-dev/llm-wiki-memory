import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wireMemorySurfaces } from "../scripts/wire-memory-surfaces.mjs";

/** @type {string[]} */
const tmps = [];
after(() => {
  for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
});

/** Build a fake home holding a src tree + an empty workspace. @returns {{ home: string, srcDir: string, ws: string }} */
function scaffold() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d-wire-")));
  tmps.push(home);
  const srcDir = path.join(home, ".llm-wiki-memory", "src");
  for (const [sub, names] of [
    ["templates/skills", ["consolidate.md", "plan-capture.md"]],
    ["templates/rules", ["priority.md", "tool-scopes.md"]],
    [".agents/rules", ["self-observability.md", "dev-principles.md"]],
  ]) {
    const dir = path.join(srcDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(dir, n), `# canonical ${sub}/${n}\n`);
  }
  fs.mkdirSync(path.join(srcDir, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "templates", "agents-memory-instructions.md"),
    "## Project memory (llm-wiki-memory)\n\ninstructions body.\n",
  );
  const ws = path.join(home, "proj");
  fs.mkdirSync(ws, { recursive: true });
  return { home, srcDir, ws };
}

/** @param {string} p @returns {string} */
function read(p) {
  return fs.readFileSync(p, "utf8");
}

test("wire: writes prefixed @-pointer FILES (never copies) to the right surfaces", () => {
  const { home, srcDir, ws } = scaffold();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });

  // skills → .agents/rules, .claude/skills, .cursor/rules
  for (const surface of [".agents/rules", ".claude/skills", ".cursor/rules"]) {
    const p = path.join(ws, surface, "llm-wiki-memory-consolidate.md");
    assert.ok(fs.existsSync(p), `skill pointer present on ${surface}`);
    const body = read(p);
    assert.match(
      body,
      /^@~\/\.llm-wiki-memory\/src\/templates\/skills\/consolidate\.md$/m,
      "@-include line",
    );
    assert.doesNotMatch(
      body,
      /canonical templates\/skills/,
      "it is a POINTER, not a copy of the body",
    );
    assert.match(
      body,
      /~\/\.llm-wiki-memory\/src\/templates\/skills\/consolidate\.md/,
      "fallback path line names the same target",
    );
  }
  // a skill is NOT wired into .claude/rules (skills go to .claude/skills only)
  assert.ok(!fs.existsSync(path.join(ws, ".claude/rules", "llm-wiki-memory-consolidate.md")));

  // shipped rules → .agents/rules, .claude/rules, .cursor/rules (NOT .claude/skills)
  for (const surface of [".agents/rules", ".claude/rules", ".cursor/rules"]) {
    assert.ok(
      fs.existsSync(path.join(ws, surface, "llm-wiki-memory-priority.md")),
      `rule pointer on ${surface}`,
    );
  }
  assert.ok(!fs.existsSync(path.join(ws, ".claude/skills", "llm-wiki-memory-priority.md")));

  // src-internal dev rules are NOT shipped to a consumer
  for (const surface of [".agents/rules", ".claude/rules", ".cursor/rules"]) {
    assert.ok(!fs.existsSync(path.join(ws, surface, "llm-wiki-memory-dev-principles.md")));
  }
});

test("wire: self-observability is opt-in (absent when disabled, present when enabled)", () => {
  const { home, srcDir, ws } = scaffold();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const p = path.join(ws, ".claude/rules", "llm-wiki-memory-self-observability.md");
  assert.ok(!fs.existsSync(p), "off by default");

  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: true });
  assert.ok(fs.existsSync(p), "present when enabled");
  assert.match(read(p), /@~\/\.llm-wiki-memory\/src\/\.agents\/rules\/self-observability\.md/);

  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  assert.ok(!fs.existsSync(p), "removed when disabled again");
});

test("wire: AGENTS.md/CLAUDE.md gain ONE marker-fenced @-include, preserving user content", () => {
  const { home, srcDir, ws } = scaffold();
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# My project\n\nUser's own notes.\n");
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });

  const agents = read(path.join(ws, "AGENTS.md"));
  assert.match(agents, /# My project/, "user content preserved");
  assert.match(agents, /User's own notes\./, "user content preserved");
  assert.match(
    agents,
    /@~\/\.llm-wiki-memory\/src\/templates\/agents-memory-instructions\.md/,
    "@-include of the extracted instructions",
  );
  assert.equal((agents.match(/BEGIN llm-wiki-memory/g) || []).length, 1, "exactly one block");

  const claude = read(path.join(ws, "CLAUDE.md"));
  assert.match(claude, /@~\/\.llm-wiki-memory\/src\/templates\/agents-memory-instructions\.md/);
});

test("wire: is idempotent — a second run is byte-stable on every surface and doc", () => {
  const { home, srcDir, ws } = scaffold();
  fs.writeFileSync(path.join(ws, "CLAUDE.md"), "# Existing\n");
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: true });
  const snap = () => {
    /** @type {Record<string, string>} */
    const m = {};
    for (const s of [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"]) {
      const dir = path.join(ws, s);
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
        m[`${s}/${f}`] = read(path.join(dir, f));
    }
    m["AGENTS.md"] = read(path.join(ws, "AGENTS.md"));
    m["CLAUDE.md"] = read(path.join(ws, "CLAUDE.md"));
    return m;
  };
  const before = snap();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: true });
  assert.deepEqual(snap(), before, "second run changes nothing");
});

test("wire: migration removes an OLD unprefixed copy/symlink of one of our rules, keeps the user's own", () => {
  const { home, srcDir, ws } = scaffold();
  fs.mkdirSync(path.join(ws, ".claude/skills"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".claude/skills", "consolidate.md"),
    "# stale hard copy of a shipped skill\n",
  );
  fs.mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".claude/rules", "priority.md"), "# stale copy\n");
  fs.writeFileSync(path.join(ws, ".claude/rules", "my-own-rule.md"), "# keep me\n");

  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });

  assert.ok(
    !fs.existsSync(path.join(ws, ".claude/skills", "consolidate.md")),
    "old unprefixed skill copy removed",
  );
  assert.ok(
    !fs.existsSync(path.join(ws, ".claude/rules", "priority.md")),
    "old unprefixed rule copy removed",
  );
  assert.ok(
    fs.existsSync(path.join(ws, ".claude/skills", "llm-wiki-memory-consolidate.md")),
    "replaced by the prefixed pointer",
  );
  assert.ok(
    fs.existsSync(path.join(ws, ".claude/rules", "my-own-rule.md")),
    "the user's own file is untouched",
  );
});

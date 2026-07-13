import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wireMemorySurfaces } from "../scripts/wire-memory-surfaces.mjs";
import { readManifest, manifestPath, sha256 } from "../scripts/lib/install-manifest.mjs";

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
    m["MANIFEST"] = read(manifestPath(ws));
    return m;
  };
  const before = snap();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: true });
  assert.deepEqual(
    snap(),
    before,
    "second run is byte-stable on every surface, both docs, and the manifest",
  );
});

test("wire: writes an install manifest recording every artifact (files hashed, both docs as blocks)", () => {
  const { home, srcDir, ws } = scaffold();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const m = readManifest(ws);
  assert.ok(m, "manifest written");
  const files = m.artifacts.filter((a) => a.kind === "file");
  const blocks = m.artifacts.filter((a) => a.kind === "block");
  assert.ok(files.length >= 8, "every pointer recorded as a file artifact");
  assert.deepEqual(
    blocks.map((b) => b.path).sort(),
    ["AGENTS.md", "CLAUDE.md"],
    "both docs recorded as block artifacts",
  );
  const f = files.find((a) => a.path.endsWith("llm-wiki-memory-consolidate.md"));
  assert.ok(f, "a known pointer is recorded");
  assert.equal(
    f.sha256,
    sha256(read(path.join(ws, f.path))),
    "the recorded hash matches the on-disk body",
  );
});

test("wire: both AGENTS.md and CLAUDE.md, when ABSENT, are CREATED with the include block", () => {
  const { home, srcDir, ws } = scaffold();
  assert.ok(
    !fs.existsSync(path.join(ws, "AGENTS.md")) && !fs.existsSync(path.join(ws, "CLAUDE.md")),
    "both docs absent to start",
  );
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
    const body = read(path.join(ws, doc));
    assert.match(body, /BEGIN llm-wiki-memory/, `${doc} created with the block`);
    assert.match(body, /@~\/.*agents-memory-instructions\.md/, `${doc} includes the instructions`);
  }
});

test("wire: migration removes OUR old copy (canonical content or symlink) but PRESERVES a user's same-named file", () => {
  const { home, srcDir, ws } = scaffold();
  fs.mkdirSync(path.join(ws, ".claude/skills"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".claude/rules"), { recursive: true });
  // An OLD hard copy = byte-identical to the shipped canonical → removed.
  fs.copyFileSync(
    path.join(srcDir, "templates/skills/consolidate.md"),
    path.join(ws, ".claude/skills", "consolidate.md"),
  );
  // An OLD symlink (the pre-D .claude/.cursor wiring) → removed.
  fs.symlinkSync(
    "../../.agents/rules/plan-capture.md",
    path.join(ws, ".claude/skills", "plan-capture.md"),
  );
  // A user's OWN file at a shipped basename, DIFFERENT content → PRESERVED.
  fs.writeFileSync(path.join(ws, ".claude/rules", "priority.md"), "# MY own priority rule\n");
  // A user's unrelated file → PRESERVED.
  fs.writeFileSync(path.join(ws, ".claude/rules", "my-own-rule.md"), "# keep me\n");

  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });

  assert.ok(
    !fs.existsSync(path.join(ws, ".claude/skills", "consolidate.md")),
    "our old hard copy (canonical content) removed",
  );
  assert.ok(
    !fs.existsSync(path.join(ws, ".claude/skills", "plan-capture.md")),
    "our old symlink removed",
  );
  assert.ok(
    fs.existsSync(path.join(ws, ".claude/skills", "llm-wiki-memory-consolidate.md")),
    "replaced by the prefixed pointer",
  );
  assert.equal(
    fs.readFileSync(path.join(ws, ".claude/rules", "priority.md"), "utf8"),
    "# MY own priority rule\n",
    "a user's DIFFERENT-content file at a shipped basename is PRESERVED, not blind-deleted",
  );
  assert.ok(
    fs.existsSync(path.join(ws, ".claude/rules", "my-own-rule.md")),
    "user's unrelated file untouched",
  );
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wireMemorySurfaces } from "../scripts/wire-memory-surfaces.mjs";
import { readManifest, manifestPath, sha256 } from "../scripts/lib/install-manifest.mjs";
import { POINTER_FALLBACK_NOTE } from "../scripts/lib/memory-surface-constants.mjs";

/** A realistic @-pointer body (matches wire's pointerBody). */
const ptr = (/** @type {string} */ ref) => `@${ref}\n\n${POINTER_FALLBACK_NOTE}\n${ref}\n`;

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

test("wire: a user's FENCED example of our markers survives wireInclude (R4-2 F1 end-to-end)", () => {
  const { home, srcDir, ws } = scaffold();
  const fenced =
    "# Doc\n\nExample of what it injects:\n```\n" +
    "<!-- BEGIN llm-wiki-memory -->\n@~/example-only\n<!-- END llm-wiki-memory -->\n" +
    "```\n\nmore user prose\n";
  fs.writeFileSync(path.join(ws, "AGENTS.md"), fenced);
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const agents = read(path.join(ws, "AGENTS.md"));
  assert.match(agents, /Example of what it injects/, "user prose kept");
  assert.match(agents, /@~\/example-only/, "the FENCED example's interior survives (not stripped)");
  assert.match(agents, /more user prose/, "trailing user prose kept");
  assert.equal(
    (agents.match(/BEGIN llm-wiki-memory/g) || []).length,
    2,
    "the preserved fenced example + exactly one real appended block",
  );
  const once = read(path.join(ws, "AGENTS.md"));
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  assert.equal(
    read(path.join(ws, "AGENTS.md")),
    once,
    "byte-stable — the fenced example is never consumed",
  );
});

test("wire: an UNCLOSED code fence in AGENTS.md stays byte-stable across two wires (no accumulation, R5)", () => {
  const { home, srcDir, ws } = scaffold();
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Doc\n\n```bash\necho hi (unclosed fence)\n");
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const run1 = read(path.join(ws, "AGENTS.md"));
  assert.equal((run1.match(/BEGIN llm-wiki-memory/g) || []).length, 1, "one block after run 1");
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const run2 = read(path.join(ws, "AGENTS.md"));
  assert.equal(
    run2,
    run1,
    "byte-stable — an unclosed fence never hides our block, so no duplicate accumulates",
  );
  assert.equal((run2.match(/BEGIN llm-wiki-memory/g) || []).length, 1, "still exactly one block");
});

test("wire: a shipped basename in BOTH skills and rules warns (deterministic last-wins, GAP6)", () => {
  const { home, srcDir, ws } = scaffold();
  fs.writeFileSync(path.join(srcDir, "templates/skills", "dup.md"), "# skill dup\n");
  fs.writeFileSync(path.join(srcDir, "templates/rules", "dup.md"), "# rule dup\n");
  /** @type {string[]} */ const errs = [];
  const orig = console.error;
  console.error = (/** @type {unknown[]} */ ...a) => errs.push(a.join(" "));
  try {
    wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  } finally {
    console.error = orig;
  }
  assert.ok(
    errs.some((e) => /collision/.test(e) && /dup\.md/.test(e)),
    "a shipped basename collision across groups is warned",
  );
  // Deterministic: the pointer is present on the shared surfaces + byte-stable on re-run.
  const shared = path.join(ws, ".agents/rules", "llm-wiki-memory-dup.md");
  assert.ok(fs.existsSync(shared), "the colliding pointer is written (last-wins, deterministic)");
  const before = read(shared);
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  assert.equal(read(shared), before, "byte-stable across a re-wire");
});

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

test("wire: TWO pre-existing @-include blocks in a doc are COLLAPSED to one (M2 install side)", () => {
  const { home, srcDir, ws } = scaffold();
  fs.writeFileSync(
    path.join(ws, "AGENTS.md"),
    "# User doc\n\n<!-- BEGIN llm-wiki-memory -->\nstale one\n<!-- END llm-wiki-memory -->\n\n" +
      "middle user text\n\n<!-- BEGIN llm-wiki-memory -->\nstale two\n<!-- END llm-wiki-memory -->\n",
  );
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const agents = read(path.join(ws, "AGENTS.md"));
  assert.equal(
    (agents.match(/BEGIN llm-wiki-memory/g) || []).length,
    1,
    "duplicate blocks collapse to exactly one",
  );
  assert.doesNotMatch(agents, /stale one|stale two/, "the stale block bodies are gone");
  assert.match(agents, /# User doc/, "user content preserved");
  assert.match(agents, /middle user text/, "interior user content preserved");
  // and byte-stable on a second run
  const once = read(path.join(ws, "AGENTS.md"));
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  assert.equal(read(path.join(ws, "AGENTS.md")), once, "byte-stable after collapse");
});

test("wire: an orphan prefixed pointer NOT in the desired set is PRUNED on install (a2-B1 install side)", () => {
  const { home, srcDir, ws } = scaffold();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  // Simulate a rule that USED to ship: a prefixed pointer with no canonical target.
  const orphan = path.join(ws, ".claude/skills", "llm-wiki-memory-removed-rule.md");
  fs.writeFileSync(orphan, ptr("~/.llm-wiki-memory/src/templates/skills/removed-rule.md"));
  assert.ok(fs.existsSync(orphan));

  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  assert.ok(!fs.existsSync(orphan), "the orphan prefixed pointer is pruned on re-wire");
  assert.ok(
    fs.existsSync(path.join(ws, ".claude/skills", "llm-wiki-memory-consolidate.md")),
    "a still-shipped pointer stays",
  );
});

test("wire: a USER file at a reserved prefix (real content, not a pointer) is NEVER pruned", () => {
  const { home, srcDir, ws } = scaffold();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const userFile = path.join(ws, ".claude/skills", "llm-wiki-memory-my-notes.md");
  fs.writeFileSync(userFile, "# my own notes, not a pointer\nlots of real content\n");

  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  assert.ok(
    fs.existsSync(userFile),
    "a prefixed file whose body is real content (not our @-include) is preserved",
  );
  assert.equal(
    read(userFile),
    "# my own notes, not a pointer\nlots of real content\n",
    "and its content is untouched",
  );
});

test("wire: an orphan @-include block (START, END hand-deleted) never deletes user prose across runs (M2/F1)", () => {
  const { home, srcDir, ws } = scaffold();
  fs.writeFileSync(
    path.join(ws, "AGENTS.md"),
    "# Doc\n\n<!-- BEGIN llm-wiki-memory -->\n\nIMPORTANT USER PROSE THAT MUST SURVIVE\n\n" +
      "more user prose\n",
  );
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const run1 = read(path.join(ws, "AGENTS.md"));
  assert.match(run1, /IMPORTANT USER PROSE THAT MUST SURVIVE/, "user prose survives run 1");
  assert.equal(
    (run1.match(/BEGIN llm-wiki-memory/g) || []).length,
    1,
    "exactly one block after run 1",
  );

  wireMemorySurfaces({ srcDir, workspaceDir: ws, home, selfObsEnabled: false });
  const run2 = read(path.join(ws, "AGENTS.md"));
  assert.match(run2, /IMPORTANT USER PROSE THAT MUST SURVIVE/, "user prose STILL survives run 2");
  assert.equal(run2, run1, "byte-stable across runs (converged — no cross-block deletion)");
});

/** Turn a scaffold workspace into a SHARED (ownership: repo) mount. */
function makeShared(/** @type {string} */ ws) {
  const layout = path.join(ws, ".llm-wiki-memory", "wiki", ".layout");
  fs.mkdirSync(layout, { recursive: true });
  fs.writeFileSync(
    path.join(layout, "layout.yaml"),
    "layout:\n  - path: knowledge\n    ownership: repo\n",
  );
}

const RULE_DIRS = [".agents/rules", ".claude/skills", ".claude/rules", ".cursor/rules"];
const ourPointers = (/** @type {string} */ dir) =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((e) => e.startsWith("llm-wiki-memory-")) : [];

test("SHARED mount (O): NO ~/ pointers; only a machine-independent remote-read block", () => {
  const { srcDir, home, ws } = scaffold();
  makeShared(ws);
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home });
  for (const s of RULE_DIRS) {
    assert.deepEqual(ourPointers(path.join(ws, s)), [], `${s}: no machine-dependent pointers`);
  }
  const agents = read(path.join(ws, "AGENTS.md"));
  assert.match(
    agents,
    /raw\.githubusercontent\.com\/ctxr-dev\/llm-wiki-memory\/main\/templates\/agents-memory-instructions\.md/,
  );
  assert.ok(!agents.includes("~/"), "no machine-dependent ~/ path in a shared repo");
  assert.ok(!agents.includes("@~/"), "no @-include ~ pointer in a shared repo");
});

test("SHARED mount (O): converting a private install to shared STRIPS the prior ~/ pointers", () => {
  const { srcDir, home, ws } = scaffold();
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home }); // private install → writes pointers
  assert.ok(
    ourPointers(path.join(ws, ".agents/rules")).length > 0,
    "private install wrote pointers",
  );
  makeShared(ws);
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home }); // now shared
  for (const s of RULE_DIRS) {
    assert.deepEqual(ourPointers(path.join(ws, s)), [], `${s}: pointers stripped on conversion`);
  }
  assert.match(read(path.join(ws, "AGENTS.md")), /raw\.githubusercontent\.com/);
});

test("SHARED mount (O): idempotent (a second wire is byte-stable)", () => {
  const { srcDir, home, ws } = scaffold();
  makeShared(ws);
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home });
  const a = read(path.join(ws, "AGENTS.md"));
  const c = read(path.join(ws, "CLAUDE.md"));
  wireMemorySurfaces({ srcDir, workspaceDir: ws, home });
  assert.equal(read(path.join(ws, "AGENTS.md")), a);
  assert.equal(read(path.join(ws, "CLAUDE.md")), c);
});

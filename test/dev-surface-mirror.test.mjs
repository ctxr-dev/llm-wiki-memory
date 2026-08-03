// GATE: this repo's own dev rules and skills must exist on every client surface.
//
// Canonical text lives once in .agents/rules|skills; Claude Code and Cursor each read
// their own directory, so each canonical file needs pointer shadows. A missing shadow
// is SILENT — the rule simply does not apply in that client and nothing reports it.
// That is not hypothetical: Cursor was found missing five of eight shadows (including
// self-observability and every skill) while still carrying a pointer to a rule that had
// been renamed, so a Cursor session was following a strictly weaker rule set than a
// Claude Code session on the same repo.
//
// Every assertion here is READ-ONLY — it compares what is on disk against what the
// generator would produce. That also proves idempotency: if all files already match,
// running the generator writes nothing. Repair with:
//   node scripts/wire-dev-surfaces.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  expectedShadows,
  surfaceInventory,
  findOrphans,
  RULES_DIR,
  SKILLS_DIR,
} from "../scripts/wire-dev-surfaces.mjs";
import {
  deriveDescription,
  frontmatterOf,
  pointerTarget,
} from "../scripts/lib/dev-surface-pointers.mjs";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPAIR = "run `node scripts/wire-dev-surfaces.mjs` to repair";

/** @returns {Array<[string, string[]]>} */
function canonicalGroups() {
  const { rules, skills } = surfaceInventory();
  return [
    [RULES_DIR, rules],
    [SKILLS_DIR, skills],
  ];
}

test("every canonical rule and skill has all of its client shadows", () => {
  const missing = [...expectedShadows().keys()].filter(
    (rel) => !fs.existsSync(path.join(SRC_DIR, rel)),
  );
  assert.deepEqual(missing, [], `missing client shadows (${REPAIR})`);
});

test("every shadow's bytes match what the generator produces", () => {
  /** @type {string[]} */
  const drifted = [];
  for (const [rel, content] of expectedShadows()) {
    const abs = path.join(SRC_DIR, rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.readFileSync(abs, "utf8") !== content) drifted.push(rel);
  }
  assert.deepEqual(drifted, [], `hand-edited or stale shadows (${REPAIR})`);
});

test("no orphan shadow points at a canonical file that no longer exists", () => {
  // A renamed rule leaves its old pointer behind, and the client then loads a dangling
  // reference instead of reporting an error.
  assert.deepEqual(findOrphans(surfaceInventory().expected), [], `orphan shadows (${REPAIR})`);
});

test("every shadow's pointer RESOLVES to its canonical file from its own location", () => {
  // Depth is the whole point and the gate used to ignore it: the old check let
  // `(\.{2}\/)*` swallow any number of `../` and only verified that SOME .agents file
  // existed. A generator emitting one `../` too few therefore passed while every client
  // silently loaded nothing — exactly the failure this mechanism exists to prevent.
  /** @type {string[]} */
  const wrong = [];
  for (const rel of expectedShadows().keys()) {
    const abs = path.join(SRC_DIR, rel);
    const target = pointerTarget(fs.readFileSync(abs, "utf8"));
    assert.ok(target, `${rel} carries no canonical pointer`);
    // Two emitted forms: `../…` is relative to the shadow's own directory (Claude Code),
    // a bare `.agents/…` is workspace-root relative (Cursor).
    const resolved = target.startsWith("..")
      ? path.resolve(path.dirname(abs), target)
      : path.resolve(SRC_DIR, target);
    if (!fs.existsSync(resolved)) wrong.push(`${rel} -> ${target} (resolved ${resolved})`);
  }
  assert.deepEqual(wrong, [], "a pointer that does not resolve means the client loads nothing");
});

test("every shadow's frontmatter is PARSEABLE and carries a description", () => {
  // A derived description beginning "Skill: …" is a YAML plain scalar containing ": ",
  // which made four shipped shadows unparseable — so both new skills were invisible to
  // Claude Code and Cursor while the byte-equality assertion stayed green.
  /** @type {string[]} */
  const broken = [];
  for (const rel of expectedShadows().keys()) {
    if (rel.endsWith(".md") && rel.startsWith(".claude/rules")) continue; // pointer only, no frontmatter
    const body = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
    const block = frontmatterOf(body);
    if (!block) {
      broken.push(`${rel}: no frontmatter`);
      continue;
    }
    try {
      const parsed = parseYaml(block);
      if (typeof parsed?.description !== "string" || !parsed.description.trim()) {
        broken.push(`${rel}: description missing or not a string`);
      }
      if (rel.endsWith("SKILL.md") && typeof parsed?.name !== "string") {
        broken.push(`${rel}: SKILL.md needs a name`);
      }
    } catch (err) {
      broken.push(`${rel}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }
  assert.deepEqual(broken, [], "a client cannot load a shadow whose frontmatter does not parse");
});

test("a Cursor rule shadow always applies; a skill shadow does not", () => {
  // Rules are standing policy, so Cursor must load them every turn. Skills are
  // procedures invoked on demand — alwaysApply would burn context on every turn.
  const { rules, skills } = surfaceInventory();
  for (const name of rules) {
    const body = fs.readFileSync(path.join(SRC_DIR, ".cursor/rules", `${name}.mdc`), "utf8");
    assert.match(body, /^alwaysApply: true$/m, `${name} is a rule and must always apply`);
  }
  for (const name of skills) {
    const body = fs.readFileSync(path.join(SRC_DIR, ".cursor/rules", `${name}.mdc`), "utf8");
    assert.match(body, /^alwaysApply: false$/m, `${name} is a skill and is invoked on demand`);
  }
});

test("canonical rules and skills are non-trivial and self-describing", () => {
  // A shadow can only be as useful as the description it carries, and the description
  // is derived from the canonical file's H1 + opening sentence when none was authored.
  const { rules, skills } = surfaceInventory();
  assert.ok(rules.length > 0 && skills.length > 0, "the canonical directories are populated");

  for (const [dir, names] of canonicalGroups()) {
    for (const name of names) {
      const body = fs.readFileSync(path.join(SRC_DIR, dir, `${name}.md`), "utf8");
      assert.match(body, /^# .+/m, `${dir}/${name}.md needs an H1`);
      const description = deriveDescription(body, `${dir}/${name}.md`);
      assert.ok(
        description.length > `Canonical file is ${dir}/${name}.md.`.length + 20,
        `${dir}/${name}.md needs an opening sentence — its derived description is empty`,
      );
    }
  }
});

test("no canonical file is empty or a stub", () => {
  for (const [dir, names] of canonicalGroups()) {
    for (const name of names) {
      const lines = fs
        .readFileSync(path.join(SRC_DIR, dir, `${name}.md`), "utf8")
        .trim()
        .split("\n");
      assert.ok(lines.length >= 5, `${dir}/${name}.md is a stub (${lines.length} lines)`);
    }
  }
});

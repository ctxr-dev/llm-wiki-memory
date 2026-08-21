// Gates on the SHIPPED migrations tree. These are the machine-enforced half of
// the discipline: brevity and shape are checked here rather than hoped for in a
// rule, because the cost of a sprawling README is paid by whoever is 100 versions
// behind and has to read all of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SRC } from "./harness.mjs";
import { loadRegistry, PHASES } from "../scripts/lib/migration-registry.mjs";

const MIGRATIONS = path.join(SRC, "scripts", "migrations");

/** Every README.md anywhere under the migrations tree. */
function readmes(dir = MIGRATIONS, out = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) readmes(abs, out);
    else if (e.name === "README.md") out.push(abs);
  }
  return out;
}

const MAX_README_LINES = 8;

test("the shipped registry loads, and every entry resolves + declares a known phase", () => {
  const entries = loadRegistry(MIGRATIONS);
  assert.ok(entries.length > 0, "at least one migration is registered");
  for (const e of entries) {
    assert.ok(fs.existsSync(e.file), `${e.id} resolves to a file`);
    assert.ok(PHASES.includes(e.phase), `${e.id} declares a known phase`);
  }
});

test("every registered migration exports the full contract", async () => {
  for (const e of loadRegistry(MIGRATIONS)) {
    const mod = await import(pathToFileURL(e.file).href);
    assert.equal(typeof mod.detect, "function", `${e.id} exports detect()`);
    assert.equal(typeof mod.apply, "function", `${e.id} exports apply()`);
    assert.equal(typeof mod.id, "string", `${e.id} exports its id`);
    assert.equal(mod.id, e.id, `${e.id} id matches its registry entry`);
    assert.ok(typeof mod.title === "string" && mod.title.trim(), `${e.id} exports a human title`);
    if (mod.decision !== undefined) {
      assert.equal(typeof mod.decision, "string", `${e.id} decision is a one-line string`);
      assert.ok(!mod.decision.includes("\n"), `${e.id} decision stays one line`);
    }
  }
});

test("every migration file lives under the date path its id declares", () => {
  for (const e of loadRegistry(MIGRATIONS)) {
    assert.match(
      e.id,
      /^\d{4}\/\d{2}\/\d{2}\/\d{3}-[a-z0-9-]+$/,
      `${e.id} follows yyyy/mm/dd/NNN-slug`,
    );
  }
});

test(`a migration README is capped at ${MAX_README_LINES} lines`, () => {
  // The cap is the whole point: an install 100 versions behind reads at most
  // 100 x 8 lines, and only for the migrations that actually needed a decision.
  for (const file of readmes()) {
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n").length;
    assert.ok(
      lines <= MAX_README_LINES,
      `${path.relative(SRC, file)} is ${lines} lines; cap is ${MAX_README_LINES}. A README exists ONLY for a decision code cannot make — move the explanation into the migration's own comments.`,
    );
  }
});

test("a README only ever sits beside a REGISTERED migration", () => {
  const dirs = new Set(
    loadRegistry(MIGRATIONS).map((e) => path.dirname(path.join(MIGRATIONS, e.id))),
  );
  for (const file of readmes()) {
    assert.ok(
      dirs.has(path.dirname(file)),
      `${path.relative(SRC, file)} has no registered migration beside it — an orphan nobody will read`,
    );
  }
});

test("migrations.json documents that this structure is llm-wiki-memory's own", () => {
  // The old release rule leaked into consuming projects ("or any project that
  // consumes this rule"), telling agents to create docs/releases/** in the
  // USER's repos. The scope note keeps that from recurring here.
  const raw = fs.readFileSync(path.join(MIGRATIONS, "migrations.json"), "utf8");
  assert.match(raw, /no other project/i, "carries the engine-internal scope note");
});

test("the CLI resolves the SAME migrations dir the gates check", async () => {
  // Regression: MIGRATIONS_DIR was computed one level too high, so every gate
  // here passed while the real `cli.mjs migrations` crashed on a missing
  // manifest. Pin the two to each other.
  const { MIGRATIONS_DIR } = await import("../scripts/cli-migrations.mjs");
  assert.equal(MIGRATIONS_DIR, MIGRATIONS);
  assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, "migrations.json")));
});

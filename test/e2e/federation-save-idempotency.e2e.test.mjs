// §4/C24 e2e — the save-idempotency rows the plan claimed done but asserted
// NOWHERE (found by the determinism audit): an IDENTICAL re-save must be
// byte-stable AND mint ZERO new commits (the empty-commit skip in
// wiki-commit.mjs), while a DIFFERING re-save updates in place (+1 commit, one
// leaf). Drives a real git wiki with autoCommit ON and a pinned timestamp, and
// uses the assertIdempotent helper (previously dead code). Lexical, realpath'd /tmp.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SRC } from "./federation-helpers.mjs";
import { assertIdempotent } from "./federation-asserts-fs.mjs";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lwm-saveidem-")));
const dataDir = path.join(home, ".llm-wiki-memory");
process.env.MEMORY_DATA_DIR = dataDir;
process.env.MEMORY_DEFAULT_PROJECT_MODULE = "saveidem";
process.env.LLM_WIKI_FIXED_TIMESTAMP = process.env.LLM_WIKI_FIXED_TIMESTAMP || "1700000000";
process.env.LLM_WIKI_NO_PROMPT = "1";
process.env.LLM_WIKI_SKILL_CLI = path.join(
  SRC,
  "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
);

fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, "settings", "settings.yaml"),
  "embed:\n  backend: lexical\nwiki:\n  autoCommit: true\nconsolidate:\n  enabled: false\n",
);
const init = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
  env: { ...process.env, MEMORY_DATA_DIR: dataDir },
  encoding: "utf8",
});
if (init.status !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);

const wiki = path.join(dataDir, "wiki");
/** @param {string[]} args */
const git = (args) => spawnSync("git", ["-C", wiki, ...args], { encoding: "utf8" });
git(["init", "-q"]);
git(["config", "user.email", "t@t.local"]);
git(["config", "user.name", "tester"]);

const store = await import("../../scripts/lib/wiki-store.mjs");
const { withWikiCommit } = await import("../../scripts/lib/wiki-commit.mjs");
after(() => fs.rmSync(home, { recursive: true, force: true }));

function commitCount() {
  return Number(git(["rev-list", "--count", "HEAD"]).stdout.trim() || "0");
}
/** @param {string} name @param {string} text @returns {{ created: { document: { id: string } } }} */
function save(name, text) {
  return /** @type {{ created: { document: { id: string } } }} */ (
    withWikiCommit({ op: "save-idem", actor: "test" }, () =>
      store.saveDocument({
        name,
        text,
        datasetId: "knowledge",
        metadata: { atom_type: "reference", area: "infra", subject: ["general"] },
      }),
    )
  );
}

test("save idempotency: an IDENTICAL re-save is byte-stable AND mints ZERO new commits (§4/C24)", async () => {
  const text = "# Note\n\nidentical body across saves.\n";
  const rel = save("idem.md", text).created.document.id;
  const abs = path.join(wiki, rel.split("/").join(path.sep));
  assert.ok(fs.existsSync(abs), "leaf materialised");
  const baseline = commitCount();
  assert.ok(baseline >= 1, "the first save committed to the wiki's own git");

  await assertIdempotent(
    () => save("idem.md", text),
    () => ({ bytes: fs.readFileSync(abs, "utf8"), commits: commitCount() }),
  );
  assert.equal(commitCount(), baseline, "no identical re-save ever advanced HEAD");
});

test("save idempotency: a DIFFERING re-save updates in place — one leaf, body = last write, +1 commit", () => {
  const rel = save("diff.md", "# Diff\n\nfirst body.\n").created.document.id;
  const abs = path.join(wiki, rel.split("/").join(path.sep));
  const before = commitCount();
  const rel2 = save("diff.md", "# Diff\n\nSECOND body, changed.\n").created.document.id;
  assert.equal(rel2, rel, "same leaf id (upsert — no duplicate leaf)");
  assert.match(fs.readFileSync(abs, "utf8"), /SECOND body/, "body is the last write");
  assert.equal(commitCount(), before + 1, "a real content change advances HEAD by exactly one");
});

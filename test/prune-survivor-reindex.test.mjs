import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

// Regression: a relocate/delete that prunes the source subtree must rebuild the
// SURVIVING ancestor's index (so it drops the dead child ref) AND commit that
// rebuild — not leave it dangling in the working tree (the recall-touch cousin).

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

const store = await import("../scripts/lib/wiki-store.mjs");
const wc = await import("../scripts/lib/wiki-commit.mjs");
const { doctor } = await import("../scripts/lib/doctor.mjs");

// curated "Notes" (consolidate:none, flat) so move/delete are allowed (facet /
// topology refuse a free move).
const layoutPath = path.join(wiki, ".layout", "layout.yaml");
fs.writeFileSync(
  layoutPath,
  `${fs.readFileSync(layoutPath, "utf8")}
  - path: Notes
    consolidate: none
    placement_facets: []
    allow_entry_types: [primary]
`,
);
store._resetLayoutCacheForTests();

function git(...args) {
  return spawnSync("git", ["-C", wiki, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}
// Live the auto-commit path: a git repo at the wiki root + a clean baseline.
assert.equal(git("init", "-q").status, 0);
assert.equal(git("add", "-A").status, 0);
assert.equal(git("commit", "-q", "-m", "baseline").status, 0);
wc._resetGitProbeCache();

const idxOf = (rel) => fs.readFileSync(path.join(wiki, rel), "utf8");
function seed(name, dir) {
  const r = store.saveDocument({
    name,
    text: `# ${name}\n\nbody marker ${name}, long enough to pass content checks.`,
    datasetId: "Notes",
    placementOverride: dir,
    metadata: { atom_type: "reference", area: "x" },
  });
  assert.ok(r.ok, `seed ${name}: ${JSON.stringify(r)}`);
  return r.created.document.id;
}

test("moveDocument out of a subdir rebuilds the survivor index (no stale ref)", () => {
  const id = seed("Mover.md", "Notes/SubMove"); // Notes/SubMove/Mover.md
  const res = store.moveDocument({ fromPath: id, toPath: "Notes/Mover.md" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!fs.existsSync(path.join(wiki, "Notes/SubMove")), "emptied source subdir pruned");
  // The structural ref to the pruned child dir is gone (a stale leaf `focus`
  // string carrying the old path is a separate moveDocument cosmetic, not a ref).
  assert.doesNotMatch(idxOf("Notes/index.md"), /SubMove\/index\.md/, "survivor index drops the pruned child ref");
  assert.equal(doctor(wiki).summary.brokenRefs, 0, "no broken refs after move");
});

test("deleteDocument that empties a subdir rebuilds AND commits the survivor", () => {
  const id = seed("Doomed.md", "Notes/Gone"); // Notes/Gone/Doomed.md (auto-committed)
  assert.ok(fs.existsSync(path.join(wiki, "Notes/Gone/Doomed.md")));
  const res = store.deleteDocument({ documentId: id });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!fs.existsSync(path.join(wiki, "Notes/Gone")), "emptied subdir pruned");
  assert.doesNotMatch(idxOf("Notes/index.md"), /Gone\/index\.md/, "survivor index drops the pruned child ref");
  assert.equal(doctor(wiki).summary.brokenRefs, 0, "no broken refs after delete");
  // The rebuild must be COMMITTED, not left dangling in the working tree.
  assert.doesNotMatch(git("show", "HEAD:Notes/index.md").stdout, /Gone\/index\.md/, "survivor rebuild is in HEAD");
  assert.equal(
    git("status", "--porcelain", "Notes/index.md").stdout.trim(),
    "",
    "survivor index has no uncommitted delta",
  );
});

test("saveDocument facet relocation (re-save with a changed area) rebuilds the old-area survivor", () => {
  const a = store.saveDocument({
    name: "Sd.md",
    text: "# Sd\n\nbody marker Sd, long enough to pass content checks.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "gamma" },
  });
  assert.ok(a.ok, JSON.stringify(a));
  assert.match(a.created.document.id, /knowledge\/gamma\//, `seeded under gamma; got ${a.created.document.id}`);
  const b = store.saveDocument({
    name: "Sd.md",
    text: "# Sd\n\nbody marker Sd, long enough to pass content checks.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "delta" },
  });
  assert.ok(b.ok, JSON.stringify(b));
  assert.ok(b.relocatedFrom, `re-save relocated; got ${JSON.stringify(b)}`);
  assert.ok(!fs.existsSync(path.join(wiki, "knowledge/gamma")), "old area subtree pruned");
  assert.equal(doctor(wiki).summary.brokenRefs, 0, "no broken refs after saveDocument relocation");
});

test("CLI doctor --fix repairs out-of-band drift AND commits the repair", () => {
  // A manual rm / cloud-sync scramble: remove a committed subdir directly,
  // leaving Notes/index.md with a stale child ref no relocate path revisits.
  seed("Stray.md", "Notes/Orphan"); // auto-committed (git live)
  fs.rmSync(path.join(wiki, "Notes/Orphan"), { recursive: true, force: true });
  assert.match(idxOf("Notes/index.md"), /Orphan\/index\.md/, "stale ref present after out-of-band rm");
  const r = runScript("scripts/cli.mjs", ["doctor", "--fix"]);
  assert.equal(r.status, 0, `doctor --fix cleared → exit 0; got ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(idxOf("Notes/index.md"), /Orphan\/index\.md/, "repaired index drops the stale child");
  // The repair is COMMITTED, not left dangling in the working tree.
  assert.doesNotMatch(git("show", "HEAD:Notes/index.md").stdout, /Orphan\/index\.md/, "repair is in HEAD");
  assert.equal(
    git("status", "--porcelain", "Notes/index.md").stdout.trim(),
    "",
    "no uncommitted delta for the repaired index",
  );
});

test("updateDocMetadata facet relocation rebuilds the old-area survivor", () => {
  const k = store.writeMemory({
    name: "Fact.md",
    text: "# Fact\n\nbody marker Fact, long enough to pass content checks.",
    datasetId: "knowledge",
    metadata: { atom_type: "reference", area: "alpha" },
  });
  assert.ok(k.ok, JSON.stringify(k));
  const fromId = k.created.document.id;
  assert.match(fromId, /knowledge\/alpha\//, `seeded under alpha; got ${fromId}`);
  const res = store.updateDocMetadata({
    datasetId: "knowledge",
    documentId: fromId,
    metadata: { area: "beta" },
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.relocated, `relocated; got ${JSON.stringify(res)}`);
  assert.ok(!fs.existsSync(path.join(wiki, "knowledge/alpha")), "old area subtree pruned");
  assert.equal(doctor(wiki).summary.brokenRefs, 0, "no broken refs after metadata relocation");
});

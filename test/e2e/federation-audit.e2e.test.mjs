// Workstream J17 round-7 (Finding 2) — audit_memory's missing-metadata walk over
// the SHARED `knowledge` category must span the scope chain, not the brain only.
// A shared repo's `bug-root-cause` leaf with missing area/project_module is
// human-fixable and must not be invisible just because it lives in the repo wiki.
// (self_improvement stays brain-only by design — personal + write-gated.)
// Drives dispatchAudit through the real impl under the SAME withToolScopes frame
// the audit_memory tool uses. buildFakeHome runs BEFORE the engine import so
// HOME/MEMORY_DATA_DIR are frozen to the fake. Lexical, C14-safe.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildFakeHome, git, seedLeafFile, rmAll } from "./federation-helpers.mjs";

const fake = await buildFakeHome({
  prefix: "j17-audit",
  brainTemplate: "default",
  mounts: [{ rel: "svc", template: "repo" }], // knowledge-only, ownership: repo
});
const svc = fake.mounts[0];
git(svc.dir, ["init", "-q"]);
git(svc.dir, ["config", "user.email", "t@t.local"]);
git(svc.dir, ["config", "user.name", "tester"]);
git(svc.dir, ["remote", "add", "origin", "git@github.com:acme/svc.git"]);

const { withToolScopes } = await import("../../mcp-server/mcp-scopes.mjs");
const { withBrainContextSafe } = await import("../../scripts/lib/wiki-context.mjs");
const { dispatchAudit } = await import("../../mcp-server/mcp-audit-dispatch.mjs");
const { loadImpl } = await import("../../mcp-server/mcp-reload.mjs");
await loadImpl();

// A SHARED repo knowledge leaf with NO area / project_module → should be flagged.
seedLeafFile(
  svc.wikiRoot,
  "knowledge/orphan-brc.md",
  `---\nmemory:\n  atom_type: bug-root-cause\n  status: active\n---\n\nA repo bug-root-cause with no area or project_module.\n`,
);
// A well-formed BRAIN knowledge leaf (control: carries area → never flagged).
seedLeafFile(
  fake.brainWiki,
  "knowledge/ok-brc.md",
  `---\nmemory:\n  atom_type: bug-root-cause\n  area: billing\n  status: active\n---\n\nA complete brain bug-root-cause.\n`,
);

after(() => {
  fake.restore();
  rmAll([fake.home]);
});

test("audit_memory spans the scope chain: a SHARED REPO's knowledge leaf with missing metadata is flagged, tagged with its root", async () => {
  const res = await withToolScopes({ scopes: [svc.dir] }, async () =>
    dispatchAudit(["missing-metadata"]),
  );
  assert.equal(res.ok, true);
  const repoFinding = res.findings.find(
    (f) => f.class === "missing-metadata" && f.documentId === "knowledge/orphan-brc.md",
  );
  assert.ok(repoFinding, `the repo's incomplete leaf is flagged: ${JSON.stringify(res.findings)}`);
  assert.equal(
    repoFinding.root,
    svc.wikiRoot,
    "the finding names the REPO root so the user knows which tree to fix",
  );
  assert.ok(
    !res.findings.some((f) => f.documentId === "knowledge/ok-brc.md"),
    "the well-formed brain leaf is not flagged",
  );
});

test("contrast: a brain-only audit misses the shared repo's incomplete leaf (fix is load-bearing)", async () => {
  const res = await withBrainContextSafe(async () => dispatchAudit(["missing-metadata"]));
  assert.ok(
    !res.findings.some((f) => f.documentId === "knowledge/orphan-brc.md"),
    "brain-only (the pre-fix behavior) never reaches the repo's knowledge tree",
  );
});

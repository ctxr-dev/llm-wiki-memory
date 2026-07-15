// F3c — the TOPOLOGY write-door to a NON-BRAIN (tracker-issues) level, driven
// through the full registered save_to_dataset chain (withToolScopes →
// parseWriteRequest → dispatchWrite → saveDocument with placementOverride),
// exactly as tools-write.mjs does. Prior coverage proves the bucket math +
// round-trip in isolation (topology-runtime / cmd-init-template); this proves the
// federated write LANDS at the exact topology dir in the MOUNT tree (not the
// brain), and that a no-path topology write is REFUSED.
//
// Fixture BEFORE imports (withToolScopes reads the engine's frozen HOME/MEMORY_DATA_DIR).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildFakeHome, rmAll } from "./federation-helpers.mjs";

const fake = await buildFakeHome({
  prefix: "f3c-topo",
  projectModule: "brainmod",
  mounts: [{ rel: "trk", template: "tracker-issues" }],
});
const trk = fake.mounts[0];

const { withToolScopes } = await import("../../mcp-server/mcp-scopes.mjs");
const { dispatchWrite } = await import("../../mcp-server/mcp-write-dispatch.mjs");
const { parseWriteRequest, WRITE_KIND } = await import("../../scripts/lib/context/write.mjs");
const { getActiveWikiContext } = await import("../../scripts/lib/wiki-context.mjs");
const { MCP_OPS } = await import("../../scripts/lib/context/enums.mjs");
const { loadImpl } = await import("../../mcp-server/mcp-reload.mjs");
const store = await import("../../scripts/lib/wiki-store.mjs");

await loadImpl();
after(() => {
  fake.restore();
  rmAll([fake.home]);
});

/** Drive the full save_to_dataset chain for a TOPOLOGY (issues) write to a target.
 * @param {{ name: string, path?: string, metadata: Record<string, unknown>, target: string }} o */
function saveIssue({ name, path: relPath, metadata, target }) {
  return withToolScopes({ scopes: [trk.dir] }, async () => {
    const req = parseWriteRequest(getActiveWikiContext(), {
      kind: WRITE_KIND.DOCUMENT,
      dataset: "issues",
      name,
      text: `# ${name}\n\ntopology write-door body.`,
      path: relPath,
      metadata,
      target,
    });
    return dispatchWrite(
      req,
      (placed) =>
        store.saveDocument({
          name,
          text: req.text,
          datasetId: "issues",
          metadata: placed,
          placementOverride: relPath,
        }),
      { tool: "save_to_dataset", op: MCP_OPS.SAVE, okFromCreated: true },
    );
  });
}

const payloadOf = (res) => JSON.parse(res.content[0].text);
const exists = (root, rel) => fs.existsSync(path.join(root, rel.split("/").join(path.sep)));

test("F3c: an issues KNOWLEDGE write lands at the exact topology dir in the MOUNT tree (129957 → 129/95/7)", async () => {
  const p = payloadOf(
    await saveIssue({
      name: "DEV-129957.md",
      path: "issues/JIRA/DEV/129/95/7",
      metadata: { atom_type: "reference" },
      target: trk.wikiRoot,
    }),
  );
  const rel = p.created.document.id;
  assert.equal(rel, "issues/JIRA/DEV/129/95/7/DEV-129957.md", "computed topology path");
  assert.ok(exists(trk.wikiRoot, rel), "leaf is in the tracker-issues MOUNT tree");
  assert.ok(!exists(fake.brainWiki, rel), "leaf is NOT in the brain tree");
});

test("F3c: an issues PLAN write lands under its lifecycle dir (42 → 0/4/2/in-progress, .plan.md)", async () => {
  const p = payloadOf(
    await saveIssue({
      name: "DEV-42-fix-retry.plan.md",
      path: "issues/JIRA/DEV/0/4/2/in-progress",
      metadata: { atom_type: "plan" },
      target: trk.wikiRoot,
    }),
  );
  const rel = p.created.document.id;
  assert.equal(rel, "issues/JIRA/DEV/0/4/2/in-progress/DEV-42-fix-retry.plan.md");
  assert.ok(exists(trk.wikiRoot, rel), "plan leaf in the mount tree under its lifecycle dir");
});

test("F3c: a NO-PATH write to the topology category is REFUSED (never a flat-root landing)", async () => {
  await assert.rejects(
    () =>
      saveIssue({
        name: "DEV-7.md",
        metadata: { atom_type: "reference" },
        target: trk.wikiRoot,
      }),
    /path|topology/i,
    "a topology write without an explicit path throws",
  );
});

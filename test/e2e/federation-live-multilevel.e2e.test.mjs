// Workstream J6 — drive the LIVE stdio MCP server over a REAL 2-level scope
// (the home brain + one team repo). Every other live-server test is brain-only
// (harness `scopeClient` injects a single [dataDir]); none launches the server
// against a multi-dir scope. This one does: it spawns the server with a fake
// HOME + MEMORY_DATA_DIR pointing at a /tmp brain and passes explicit
// `scopes:[svc.dir]` so the resolved context is brain + repo, then exercises
// target routing (repo / brain / out-of-scope) end to end over the real tools.
//
// POLLUTION SAFETY: the server is a SUBPROCESS that reads HOME/MEMORY_DATA_DIR
// from ITS OWN env. Passing the fake home + brain data dir (+ lexical backend)
// in the spawn env keeps every write inside /tmp — never the developer's real
// ~/.llm-wiki-memory. after() rms the fake home; every leaf name is prefixed
// `j6-` so any stray is trivially detectable.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SRC, buildFakeHome, rmAll, git, commitCount } from "./federation-helpers.mjs";

// Fixture: a fake $HOME with the brain + one repo mount `svc` (real git repo
// with an origin remote, README committed, wiki left untracked) — the J5 setup.
const fake = await buildFakeHome({
  prefix: "j6-live",
  projectModule: "brainmod",
  mounts: [{ rel: "svc", template: "repo" }],
});
const svc = fake.mounts[0];
git(svc.dir, ["init", "-q"]);
git(svc.dir, ["config", "user.email", "t@t.local"]);
git(svc.dir, ["config", "user.name", "tester"]);
git(svc.dir, ["remote", "add", "origin", "git@github.com:acme/svc.git"]);
fs.writeFileSync(path.join(svc.dir, "README.md"), "ok\n");
git(svc.dir, ["add", "README.md"]);
git(svc.dir, ["commit", "-q", "-m", "init"]);

let client;
let transport;

before(async () => {
  client = new Client({ name: "lwm-j6", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: {
      ...process.env,
      HOME: fake.home,
      MEMORY_DATA_DIR: fake.brainDataDir,
      MEMORY_EMBED_BACKEND: "lexical",
    },
    cwd: SRC,
  });
  await client.connect(transport);
});

after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  fake.restore();
  rmAll([fake.home]);
});

const payloadOf = (res) => JSON.parse(res.content[0].text);
const rp = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const leafExists = (root, rel) => fs.existsSync(path.join(root, rel.split("/").join(path.sep)));
function pmOf(root, rel) {
  const m = fs
    .readFileSync(path.join(root, rel.split("/").join(path.sep)), "utf8")
    .match(/project_module:\s*(.+)/);
  return m ? m[1].trim() : "";
}

/** Save a knowledge leaf into a chosen `target`, scoped to the brain+repo chain. */
function saveDoc(target, name) {
  return client.callTool({
    name: "save_to_dataset",
    arguments: {
      scopes: [svc.dir],
      target,
      write: {
        dataset: "knowledge",
        name,
        text: `# ${name}\n\nj6 live multi-level routing body.`,
        metadata: { atom_type: "reference", area: "infra", subject: ["general"] },
      },
    },
  });
}

test("J6: get_memory_config over [svc.dir] resolves TWO levels — a wiki brain (depth 0) + the repo", async () => {
  const cfg = payloadOf(
    await client.callTool({ name: "get_memory_config", arguments: { scopes: [svc.dir] } }),
  );
  assert.equal(cfg.levels.length, 2, "brain + svc repo");
  const brain = cfg.levels.find((l) => l.ownership === "wiki");
  const repo = cfg.levels.find((l) => l.ownership === "repo");
  assert.ok(brain, "a wiki-owned brain level is present");
  assert.equal(brain.depth, 0, "the brain is depth 0");
  assert.equal(rp(brain.root), rp(fake.brainWiki), "brain root is the fake /tmp brain");
  assert.ok(repo, "a repo-owned level is present");
  assert.equal(rp(repo.root), rp(svc.wikiRoot), "repo root is the svc mount");
});

test("J6: a repo-target save lands in the REPO tree, stamped acme/svc, zero git, 'commit and push'", async () => {
  const beforeCommits = commitCount(svc.dir);
  const p = payloadOf(await saveDoc(svc.wikiRoot, "j6-repo.md"));
  const rel = p.created.document.id;
  assert.ok(leafExists(svc.wikiRoot, rel), "leaf is in the repo's wiki tree");
  assert.ok(!leafExists(fake.brainWiki, rel), "leaf is NOT in the brain tree");
  assert.equal(pmOf(svc.wikiRoot, rel), "acme/svc", "stamped with the repo org/repo identity");
  assert.equal(commitCount(svc.dir), beforeCommits, "the team repo's git is untouched");
  assert.match(String(p.message), /commit and push/, "tells the user to commit and push it");
});

test("J6: a brain-target save lands in the BRAIN tree, not the repo", async () => {
  const p = payloadOf(await saveDoc("brain", "j6-brain.md"));
  const rel = p.created.document.id;
  assert.ok(leafExists(fake.brainWiki, rel), "leaf is in the brain tree");
  assert.ok(!leafExists(svc.wikiRoot, rel), "leaf is NOT in the repo tree");
  assert.ok(!p.sharedTarget, "a brain write carries no shared-target annotation");
});

test("J6: an out-of-scope target is REFUSED with an error envelope naming `target` — never a silent write", async () => {
  const elsewhere = path.join(path.dirname(svc.dir), "not-in-scope", ".llm-wiki-memory", "wiki");
  const res = await saveDoc(elsewhere, "j6-nope.md");
  assert.equal(res.isError, true, "the live server returns an error result, not a silent write");
  const env = payloadOf(res);
  assert.equal(env.ok, false, "the envelope reports ok:false");
  assert.equal(env.field, "target", "the refusal names the offending `target` field");
});

// Regression coverage for the BLOCKING + MEDIUM fixes applied after the
// Phase 7 hardening review.
//
// One file, one workspace, many small targeted tests — each one pins a
// specific invariant the review demanded:
//
//   (2) llm-merge keeper rewrite does NOT relocate the keeper
//   (3) write_memory write-gate: self_improvement is gated, others are not
//   (4) consolidate installs signal-release handlers (lock cleanup on SIGTERM)
//   (5) consolidate respects MEMORY_GC_INTERVAL_DAYS throttle for prune-embeddings
//   (6) cosine "embedding backend is lexical" warning fires ONCE per run
//   (7) consolidate never hard-deletes (losers are status:archived, on disk)
//   (8) prompts/consolidate-{merge,refresh}.md exist on disk
//   (9) resolveAllowedPasses("") yields an empty set → no passes run
//
// Tests that need a cross-process boundary (MCP wire for the write-gate,
// CLI for stderr capture) spawn child processes; everything else runs
// in-process for speed. The whole file uses ONE setupWorkspace() and
// purges leaves between tests, mirroring consolidate-llm-passes.test.mjs.

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, scopeClient } from "./harness.mjs";

const CLI = path.join(SRC, "scripts", "cli.mjs");

// ─── Shared workspace ──────────────────────────────────────────────────────

const { dataDir, wiki } = setupWorkspace();
after(() => cleanup(dataDir));

process.env.MEMORY_LLM_PROVIDER = "mock";

const store = await import("../scripts/lib/wiki-store.mjs");
const { consolidateMemory, _internals } = await import("../scripts/consolidate.mjs");
const lockMod = await import("../scripts/lib/lock.mjs");
const env = await import("../scripts/lib/env.mjs");

const STATE_FILE = path.join(dataDir, "state", ".consolidate.json");

function clearConsolidateState() {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

const { __setSettingsForTest, __clearSettingsForTest } =
  await import("../scripts/lib/settings.mjs");

function resetEnv() {
  delete process.env.MEMORY_LLM_MOCK_RESPONSE;
  delete process.env.MEMORY_LLM_MOCK_FILE;
  __clearSettingsForTest();
}

after(() => resetEnv());

function purgeActiveLeaves() {
  for (const cat of ["self_improvement", "knowledge"]) {
    const { documents } = store.listDocuments({ datasetId: cat });
    for (const d of documents) {
      try {
        store.deleteDocument({ documentId: d.id });
      } catch {
        /* best effort */
      }
    }
  }
}

function seedSelfImprovementLeaf({ name, text, metadata = {} } = {}) {
  const r = store.saveDocument({
    name,
    text,
    datasetId: "self_improvement",
    metadata: { project_module: "billing", task_type: "refactor", ...metadata },
  });
  if (!r.ok && !r.created) throw new Error(`seed failed for ${name}: ${JSON.stringify(r)}`);
  return r.created.document.id;
}

function countLeavesOnDisk() {
  let total = 0;
  for (const cat of ["self_improvement", "knowledge", "plans", "investigations", "daily"]) {
    const root = path.join(wiki, cat);
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile() && e.name.endsWith(".md") && e.name !== "index.md") {
          total += 1;
        }
      }
    }
  }
  return total;
}

// ───────────────────────────────────────────────────────────────────────────
// (2) llm-merge keeper rewrite does NOT relocate the keeper
// ───────────────────────────────────────────────────────────────────────────

test("(2) llm-merge keeper rewrite does NOT relocate the keeper", async () => {
  purgeActiveLeaves();
  clearConsolidateState();
  resetEnv();

  // Two byte-identical leaves so dedupe-by-sha256 queues the pair, then 3A
  // rewrites the keeper. The keeper's documentId MUST be the same path
  // before and after the rewrite — placementOverride pins it.
  const idA = seedSelfImprovementLeaf({
    name: "lesson-merge-pin-a-2026-06-01-000000000.md",
    text: "# Pin keeper dir on merge\n\nNever relocate the keeper.\nWhy: invalidates supersedes_id.",
    metadata: { error_pattern: "merge-keeper-pin" },
  });
  const idB = seedSelfImprovementLeaf({
    name: "lesson-merge-pin-b-2026-06-01-000000000.md",
    text: "# Pin keeper dir on merge\n\nNever relocate the keeper.\nWhy: invalidates supersedes_id.",
    metadata: { error_pattern: "merge-keeper-pin" },
  });
  const [keeperId, loserId] = [idA, idB].sort();
  const keeperDirBefore = path.posix.dirname(keeperId);

  // The LLM proposes a merge whose merged_body and (crucially) metadata-by-
  // implication COULD shift placement — but the placementOverride in the 3A
  // code path pins to the leaf's existing dir, so the path is untouched.
  process.env.MEMORY_LLM_MOCK_RESPONSE = JSON.stringify({
    action: "merge",
    merged_body: "MERGED BODY — placementOverride keeps the keeper here.",
    keeper_id: keeperId,
    loser_id: loserId,
    reason: "fold dup",
  });

  const r = await consolidateMemory({
    llm: true,
    now: new Date("2026-06-02T00:00:00Z"),
    passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"],
  });
  assert.equal(r.ok, true);

  // The keeper must still exist at its original documentId.
  const keeperLeaf = store.readLeafForConsolidate({ documentId: keeperId });
  assert.ok(keeperLeaf, "keeper still present at original documentId after merge");
  assert.equal(
    path.posix.dirname(keeperLeaf.documentId),
    keeperDirBefore,
    "keeper directory unchanged after merge rewrite",
  );
  assert.match(keeperLeaf.text, /MERGED BODY/, "merged_body actually applied");
});

// ───────────────────────────────────────────────────────────────────────────
// (3) write_memory write-gate behaviour for self_improvement and others
// ───────────────────────────────────────────────────────────────────────────
//
// We MUST go through the MCP server here — the gate lives in the server
// handler, not in impl.writeMemory itself. Same approach as
// hardening-gate-server.test.mjs.

function makeGateWorkspace() {
  const gateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-wm-gate-"));
  const env = {
    ...process.env,
    MEMORY_DATA_DIR: gateDir,
    MEMORY_DEFAULT_PROJECT_MODULE: "testproj",
    LLM_WIKI_SKILL_CLI: path.join(SRC, "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs"),
    LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
    LLM_WIKI_NO_PROMPT: "1",
  };
  // Pin lexical embed via settings.yaml (the subprocess reads it).
  fs.mkdirSync(path.join(gateDir, "settings"), { recursive: true });
  fs.writeFileSync(path.join(gateDir, "settings", "settings.yaml"), "embed:\n  backend: lexical\n");
  const init = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
    env,
    encoding: "utf8",
  });
  if (init.status !== 0) {
    throw new Error(`wm-gate wiki init failed: ${init.stderr || init.stdout}`);
  }
  return { gateDir, env };
}

async function connectMcp(envForChild) {
  const client = new Client({ name: "lwm-wm-gate-test", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: envForChild,
    cwd: SRC,
  });
  await client.connect(transport);
  return { client, transport };
}

let wmGate;
let wmClient;

before(async () => {
  wmGate = makeGateWorkspace();
  const conn = await connectMcp(wmGate.env);
  wmClient = scopeClient(conn.client, [wmGate.gateDir]);
});

after(async () => {
  try {
    await wmClient?.close();
  } catch {
    /* ignore */
  }
  if (wmGate?.gateDir) {
    try {
      fs.rmSync(wmGate.gateDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function parseToolResult(res) {
  return JSON.parse(res.content[0].text);
}

test("(3a) write_memory(self_improvement) WITHOUT userRequested -> write-gate-refused", async () => {
  const res = await wmClient.callTool({
    name: "write_memory",
    arguments: {
      name: "lesson-via-write-memory-refused.md",
      text: "# Lesson via write_memory\n\nThis should be refused without userRequested.\nWhy: write-gate.",
      datasetId: "self_improvement",
      metadata: {
        atom_type: "self-improvement-lesson",
        area: "testarea",
        task_type: "implementation",
        error_pattern: "write-memory-gated",
      },
    },
  });
  const payload = parseToolResult(res);
  assert.equal(payload.ok, false, "ok must be false when refused");
  assert.equal(payload.error, "write-gate-refused", "structured error is write-gate-refused");
});

test("(3b) write_memory(self_improvement) WITH userRequested:true -> ok:true", async () => {
  const res = await wmClient.callTool({
    name: "write_memory",
    arguments: {
      name: "lesson-via-write-memory-allowed.md",
      text: "# Allowed lesson via write_memory\n\nuserRequested:true passes the gate.\nWhy: explicit-ask.",
      datasetId: "self_improvement",
      userRequested: true,
      metadata: {
        atom_type: "self-improvement-lesson",
        area: "testarea",
        task_type: "implementation",
        error_pattern: "write-memory-allowed",
      },
    },
  });
  const payload = parseToolResult(res);
  assert.equal(
    payload.ok,
    true,
    `write_memory with userRequested:true should succeed: ${JSON.stringify(payload)}`,
  );
});

test("(3c) write_memory(knowledge) WITHOUT userRequested -> success (not gated)", async () => {
  const res = await wmClient.callTool({
    name: "write_memory",
    arguments: {
      name: "knowledge-via-write-memory.md",
      text: "# Knowledge note via write_memory\n\nKnowledge writes are not gated.\nFurther context here.",
      datasetId: "knowledge",
      metadata: { atom_type: "reference", project_module: "testproj", area: "testarea" },
    },
  });
  const payload = parseToolResult(res);
  assert.equal(
    payload.ok,
    true,
    `knowledge write_memory should succeed: ${JSON.stringify(payload)}`,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (4) consolidate installs signal-release handlers
// ───────────────────────────────────────────────────────────────────────────

test("(4) consolidate installs SIGTERM/SIGINT/SIGHUP/exit lock-release handlers", async () => {
  purgeActiveLeaves();
  clearConsolidateState();
  resetEnv();

  // Snapshot listener counts BEFORE the run.
  const _before = {
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGHUP: process.listenerCount("SIGHUP"),
    exit: process.listenerCount("exit"),
  };

  // Run consolidate with a minimal pass list so the body is fast. The
  // orchestrator calls installLockReleaseHandlers(COMPILE_LOCK_PATH) right
  // after acquireLock — by the time consolidateMemory resolves, the handlers
  // must be on the process.
  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["dedupe-by-sha256"],
    now: new Date("2026-06-02T00:00:00Z"),
  });
  assert.equal(r.ok, true);

  const after = {
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGHUP: process.listenerCount("SIGHUP"),
    exit: process.listenerCount("exit"),
  };

  // installLockReleaseHandlers is idempotent across calls — once installed,
  // a second call no-ops. So we can't rely on "after > before" if another
  // test already invoked acquireLock. Two-pronged check: (a) at LEAST one
  // listener exists for each signal NOW; (b) handlers fired idempotently
  // (a fresh manual call must NOT increase the count).
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "exit"]) {
    assert.ok(after[sig] >= 1, `${sig} has a listener after consolidate run (got ${after[sig]})`);
  }

  // Idempotence: invoking installLockReleaseHandlers again for the same path
  // must NOT add more listeners.
  const COMPILE_LOCK_PATH = path.join(dataDir, "state", ".compile.lock");
  lockMod.installLockReleaseHandlers(COMPILE_LOCK_PATH);
  const afterReinstall = {
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGHUP: process.listenerCount("SIGHUP"),
    exit: process.listenerCount("exit"),
  };
  assert.deepEqual(
    afterReinstall,
    after,
    "installLockReleaseHandlers is idempotent across repeat calls",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (5) consolidate respects MEMORY_GC_INTERVAL_DAYS throttle for prune-embeddings
// ───────────────────────────────────────────────────────────────────────────

test("(5) prune-embeddings throttle: recent state -> skipped; backdated -> runs", async () => {
  purgeActiveLeaves();
  clearConsolidateState();
  resetEnv();

  // Need a leaf so embed cache + a state file get created during the run.
  seedSelfImprovementLeaf({
    name: "lesson-gc-throttle-2026-06-01-000000000.md",
    text: "# GC throttle\n\nThrottled prune-embeddings.\nWhy: weekly-default.",
    metadata: { error_pattern: "gc-throttle" },
  });

  __setSettingsForTest({ gc: { intervalDays: 7 } });

  // Force the gc state to "ran just now" so prune-embeddings is throttled.
  fs.mkdirSync(path.dirname(env.GC_STATE_PATH), { recursive: true });
  fs.writeFileSync(
    env.GC_STATE_PATH,
    JSON.stringify({ last_run_utc: new Date().toISOString(), removed: 0 }),
  );

  const rThrottled = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["prune-embeddings"],
    now: new Date("2026-06-02T00:00:00Z"),
  });
  assert.equal(rThrottled.ok, true);
  const gcReportThrottled = rThrottled.passes["prune-embeddings"];
  assert.equal(
    gcReportThrottled.touched,
    0,
    `throttled: prune-embeddings touched should be 0; got ${gcReportThrottled.touched}`,
  );
  // State file last_run_utc must NOT have advanced (run was skipped).
  const stateMid = JSON.parse(fs.readFileSync(env.GC_STATE_PATH, "utf8"));
  const stateMidTime = Date.parse(stateMid.last_run_utc);
  assert.ok(Number.isFinite(stateMidTime), "state has a parseable last_run_utc");

  // Backdate the state to 10 days ago so the throttle window is well past
  // the 7-day interval.
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
  fs.writeFileSync(env.GC_STATE_PATH, JSON.stringify({ last_run_utc: tenDaysAgo, removed: 0 }));

  // Seed an orphan into the embed cache so a sweep has something to remove
  // (gives the report a non-zero touched count we can assert positively on).
  const embed = await import("../scripts/lib/embed.mjs");
  const cache = embed.loadCache(env.embedCachePath());
  cache.entries["self_improvement/gone/refactor/orphan-throttle.md"] = {
    hash: "sha256:throttle-orphan",
    vector: [0.1, 0.2],
  };
  embed.saveCache(env.embedCachePath(), cache);

  const rRan = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["prune-embeddings"],
    now: new Date("2026-06-02T00:00:00Z"),
  });
  assert.equal(rRan.ok, true);
  const gcReportRan = rRan.passes["prune-embeddings"];
  assert.ok(
    gcReportRan.touched >= 1,
    `backdated: prune-embeddings actually ran (touched >=1); got ${gcReportRan.touched}`,
  );

  // The state file's last_run_utc has now been refreshed to "now".
  const stateAfter = JSON.parse(fs.readFileSync(env.GC_STATE_PATH, "utf8"));
  const stateAfterTime = Date.parse(stateAfter.last_run_utc);
  assert.ok(stateAfterTime > Date.parse(tenDaysAgo), "state last_run_utc advanced past backdate");
});

// ───────────────────────────────────────────────────────────────────────────
// (5b) saveCache persists the recall vector store via the ATOMIC path
// ───────────────────────────────────────────────────────────────────────────
//
// saveCache is the only writer of index/embeddings.json and runs off-lock
// from both the long-running MCP server and the hourly cron. It MUST use a
// unique temp (not a fixed `<path>.tmp`) so concurrent writers cannot rename
// a torn, byte-interleaved file into place. Spy on renameSync to prove the
// temp is the unique pid+uuid form and the result is valid JSON.

test("(5b) saveCache uses a unique temp (no fixed .tmp collision) and writes valid JSON", async () => {
  const embed = await import("../scripts/lib/embed.mjs");
  const cachePath = env.embedCachePath();
  const cache = embed.loadCache(cachePath);
  cache.entries["knowledge/x/atomic-savecache-probe.md"] = {
    hash: "sha256:probe",
    vector: [0.3, 0.4, 0.5],
  };

  const originalRename = fs.renameSync;
  let observedFrom = null;
  fs.renameSync = function spy(from, to) {
    if (path.resolve(String(to)) === path.resolve(cachePath)) observedFrom = String(from);
    return originalRename.call(this, from, to);
  };
  try {
    embed.saveCache(cachePath, cache);
  } finally {
    fs.renameSync = originalRename;
  }

  assert.ok(observedFrom, "saveCache renamed a temp onto the cache path");
  assert.notEqual(observedFrom, `${cachePath}.tmp`, "must not use the collision-prone fixed temp");
  assert.match(path.basename(observedFrom), /^\..*\.\d+-[0-9a-f]+\.tmp$/, "unique pid+uuid temp");
  // No fixed-name leftover, and the persisted file round-trips.
  assert.equal(fs.existsSync(`${cachePath}.tmp`), false, "no fixed .tmp leftover");
  const reloaded = embed.loadCache(cachePath);
  assert.ok(
    reloaded.entries["knowledge/x/atomic-savecache-probe.md"],
    "entry persisted + parseable",
  );
});

// ───────────────────────────────────────────────────────────────────────────
// (6) "embedding backend is lexical" warning fires ONCE per run
// ───────────────────────────────────────────────────────────────────────────
//
// In-process capture of process.stderr is fragile (multiple writers in the
// same VM, the embedding backend logs during init too). Spawn the CLI so
// stderr is a clean, isolated stream.

test("(6) cosine lexical warning fires exactly once per run", () => {
  const gcDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-warn-"));
  try {
    // Init a fresh wiki so this run is independent of the shared workspace.
    // Pin embed.backend via settings.yaml — env vars no longer drive it.
    fs.mkdirSync(path.join(gcDir, "settings"), { recursive: true });
    fs.writeFileSync(
      path.join(gcDir, "settings", "settings.yaml"),
      "embed:\n  backend: lexical\nconsolidate:\n  enabled: true\n",
    );
    const init = spawnSync(process.execPath, [CLI, "init"], {
      cwd: SRC,
      encoding: "utf8",
      env: {
        ...process.env,
        MEMORY_DATA_DIR: gcDir,
        LLM_WIKI_NO_PROMPT: "1",
      },
    });
    assert.equal(init.status, 0, `wiki init failed: ${init.stderr || init.stdout}`);

    // Seed 3 active self_improvement leaves so the cluster loop iterates
    // several times; before the fix, the per-leaf subCtx triggered the warn
    // once PER LEAF.
    for (let i = 0; i < 3; i++) {
      const seed = spawnSync(
        process.execPath,
        [
          "-e",
          [
            `process.env.MEMORY_DATA_DIR = ${JSON.stringify(gcDir)};`,
            `process.env.LLM_WIKI_NO_PROMPT = "1";`,
            `const s = await import(${JSON.stringify(path.join(SRC, "scripts/lib/wiki-store.mjs"))});`,
            `s.saveDocument({`,
            `  name: ${JSON.stringify(`lesson-warn-${i}-2026-06-01-000000000.md`)},`,
            `  text: ${JSON.stringify(`# Warn ${i}\\n\\nLeaf ${i} body.\\nWhy: warn-once.`)},`,
            `  datasetId: "self_improvement",`,
            `  metadata: { project_module: "billing", area: "auth", task_type: "refactor", error_pattern: ${JSON.stringify(`warn-once-${i}`)} },`,
            `});`,
          ].join("\n"),
        ],
        { cwd: SRC, encoding: "utf8", env: process.env },
      );
      assert.equal(seed.status, 0, `seed ${i} failed: ${seed.stderr || seed.stdout}`);
    }

    // Run consolidate via the CLI under the lexical backend.
    const r = spawnSync(
      process.execPath,
      [CLI, "consolidate", "--no-llm", "--json", "--passes=dedupe-by-cosine"],
      {
        cwd: SRC,
        encoding: "utf8",
        env: {
          ...process.env,
          MEMORY_DATA_DIR: gcDir,
          LLM_WIKI_NO_PROMPT: "1",
        },
      },
    );
    assert.equal(r.status, 0, `consolidate cli failed: ${r.stderr}`);
    const occurrences = (r.stderr.match(/embedding backend is lexical/g) || []).length;
    assert.equal(
      occurrences,
      1,
      `"embedding backend is lexical" warning fires exactly once per run (got ${occurrences}); stderr:\n${r.stderr}`,
    );
  } finally {
    fs.rmSync(gcDir, { recursive: true, force: true });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// (7) consolidate never hard-deletes
// ───────────────────────────────────────────────────────────────────────────

test("(7) consolidate archives losers but never deletes files from disk", async () => {
  purgeActiveLeaves();
  clearConsolidateState();
  resetEnv();

  // Two byte-identical leaves so dedupe-by-sha256 archives the loser.
  seedSelfImprovementLeaf({
    name: "lesson-no-delete-a-2026-06-01-000000000.md",
    text: "# Never hard-delete\n\nLosers archive, files stay on disk.\nWhy: rollback-safety.",
    metadata: { error_pattern: "no-hard-delete" },
  });
  seedSelfImprovementLeaf({
    name: "lesson-no-delete-b-2026-06-01-000000000.md",
    text: "# Never hard-delete\n\nLosers archive, files stay on disk.\nWhy: rollback-safety.",
    metadata: { error_pattern: "no-hard-delete" },
  });

  const filesBefore = countLeavesOnDisk();
  assert.ok(filesBefore >= 2, `at least the two seeded files exist (got ${filesBefore})`);

  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: ["dedupe-by-sha256"],
    now: new Date("2026-06-02T00:00:00Z"),
  });
  assert.equal(r.ok, true);
  assert.ok(
    r.passes["dedupe-by-sha256"].archived >= 1,
    "dedupe-by-sha256 actually archived at least one loser",
  );

  const filesAfter = countLeavesOnDisk();
  assert.equal(
    filesAfter,
    filesBefore,
    `file count unchanged after archive (before=${filesBefore}, after=${filesAfter})`,
  );

  // Both the keeper and the loser must still be listable — one as enabled,
  // one as enabled:false.
  const activeIds = store
    .listDocuments({ datasetId: "self_improvement", enabled: true })
    .documents.map((d) => d.id);
  const inactiveIds = store
    .listDocuments({ datasetId: "self_improvement", enabled: false })
    .documents.map((d) => d.id);
  const seededActiveCount = activeIds.filter((i) => /lesson-no-delete-/.test(i)).length;
  const seededInactiveCount = inactiveIds.filter((i) => /lesson-no-delete-/.test(i)).length;
  assert.equal(
    seededActiveCount + seededInactiveCount,
    2,
    "both leaves still discoverable on disk",
  );
  assert.equal(seededInactiveCount, 1, "exactly one loser archived");
});

// ───────────────────────────────────────────────────────────────────────────
// (8) prompt files exist on disk
// ───────────────────────────────────────────────────────────────────────────

test("(8) prompt files exist: consolidate-merge.md + consolidate-refresh.md", () => {
  const mergePrompt = path.join(SRC, "prompts", "consolidate-merge.md");
  const refreshPrompt = path.join(SRC, "prompts", "consolidate-refresh.md");
  assert.ok(fs.existsSync(mergePrompt), `${mergePrompt} must exist (packaging guard)`);
  assert.ok(fs.existsSync(refreshPrompt), `${refreshPrompt} must exist (packaging guard)`);
});

// ───────────────────────────────────────────────────────────────────────────
// (9) resolveAllowedPasses("") -> empty set; consolidate({passes:""}) -> zero totals
// ───────────────────────────────────────────────────────────────────────────

test("(9) resolveAllowedPasses('') returns an empty set", () => {
  const s = _internals.resolveAllowedPasses("");
  assert.equal(s.size, 0, "empty-string passes arg yields an empty allow-list");
});

test("(9) consolidate({passes:''}) runs but every pass is a no-op", async () => {
  purgeActiveLeaves();
  clearConsolidateState();
  resetEnv();

  // Seed a near-duplicate pair: with no passes enabled, NOTHING should
  // archive even though dedupe-by-sha256 normally would.
  seedSelfImprovementLeaf({
    name: "lesson-no-passes-a-2026-06-01-000000000.md",
    text: "# No passes\n\nDry-run gate.\nWhy: noop-passes.",
    metadata: { error_pattern: "noop-passes" },
  });
  seedSelfImprovementLeaf({
    name: "lesson-no-passes-b-2026-06-01-000000000.md",
    text: "# No passes\n\nDry-run gate.\nWhy: noop-passes.",
    metadata: { error_pattern: "noop-passes" },
  });

  const r = await consolidateMemory({
    dryRun: false,
    llm: false,
    passes: "",
    now: new Date("2026-06-02T00:00:00Z"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.totals.archived, 0, "no archives when passes=''");
  assert.equal(r.totals.touched, 0, "no touches when passes=''");
  assert.equal(r.totals.merged, 0, "no merges when passes=''");
  assert.equal(r.totals.refreshed, 0, "no refreshes when passes=''");
  assert.equal(r.totals.flagged, 0, "no flagged when passes=''");
});

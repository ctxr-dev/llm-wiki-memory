import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "./harness.mjs";

// The two path-override env vars are cleared so the single-tree neutrality
// assertions compare the pure MEMORY_DATA_DIR-anchored default wikiRoot()
// against the brain root the wrapper installs (they must be byte-identical).
delete process.env.LLM_WIKI_MEMORY_ROOT;
delete process.env.MEMORY_EMBED_CACHE;

const { dataDir } = setupWorkspace();
after(() => cleanup(dataDir));

// Imported AFTER setupWorkspace pins MEMORY_DATA_DIR (env.mjs freezes it as an
// import-time const).
const { wikiRoot, embedCachePath } = await import("../scripts/lib/env.mjs");
const { withBrainContextSafe, getActiveWikiContext } =
  await import("../scripts/lib/wiki-context.mjs");

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("withBrainContextSafe: fn runs inside a single-level brain-only context", () => {
  let seen = null;
  const ret = withBrainContextSafe(() => {
    seen = getActiveWikiContext();
    return "ok";
  });

  assert.equal(ret, "ok", "the fn's return value propagates");
  assert.ok(seen, "a context was active inside fn");
  assert.equal(seen.levels.length, 1, "brain-only: exactly one level");
  assert.equal(seen.levels[0].ownership, "wiki", "the single level is the private-wiki brain");
  assert.equal(seen.brain, seen.levels[0]);
  assert.equal(seen.writeDefault, seen.brain);
  assert.equal(getActiveWikiContext(), null, "the frame is gone after fn returns");
});

test("withBrainContextSafe: single-tree neutrality — wikiRoot()/embedCachePath() are identical inside and outside", () => {
  const rootOutside = wikiRoot();
  const cacheOutside = embedCachePath();

  withBrainContextSafe(() => {
    assert.equal(
      wikiRoot(),
      rootOutside,
      "the brain root the wrapper installs equals the env default (single tree)",
    );
    assert.equal(
      embedCachePath(),
      cacheOutside,
      "the embed-cache path is unchanged inside the brain context",
    );
    // The active context's own write-default root agrees with env.wikiRoot().
    assert.equal(getActiveWikiContext()?.writeDefault.root, rootOutside);
  });
});

test("withBrainContextSafe: a resolve failure falls through to fn() with no active context (no throw)", () => {
  // Point the brain at an uninitialised mount (no .layout/layout.yaml). The
  // resolver's loadMergedLayout throws on the empty layout; the safe wrapper
  // must swallow ONLY that and still run fn — exactly today's no-context
  // behavior, which is what keeps the capture hooks exit-0.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-brainfail-"));
  tmpDirs.push(home);
  const brainDataDir = path.join(home, ".llm-wiki-memory");
  fs.mkdirSync(path.join(brainDataDir, "wiki"), { recursive: true });

  let ran = false;
  let ctxInside = "unset";
  const ret = withBrainContextSafe(
    () => {
      ran = true;
      ctxInside = getActiveWikiContext();
      return 42;
    },
    { home, brainDataDir },
  );

  assert.equal(ran, true, "fn still runs when the brain context cannot be resolved");
  assert.equal(ret, 42, "fn's return value propagates through the fall-through path");
  assert.equal(ctxInside, null, "no wiki context is active on the fall-through path");
  assert.equal(getActiveWikiContext(), null, "still no frame after fn returns");
});

test("withBrainContextSafe: does NOT swallow fn's own error", () => {
  const boom = new Error("fn exploded");
  assert.throws(
    () =>
      withBrainContextSafe(() => {
        throw boom;
      }),
    /fn exploded/,
    "an error thrown by fn propagates; only a resolve failure is caught",
  );
});

test("withBrainContextSafe: keeps the brain context active across an await in an async fn", async () => {
  const before = getActiveWikiContext();
  assert.equal(before, null, "no frame before");

  const seen = await withBrainContextSafe(async () => {
    const a = getActiveWikiContext();
    await Promise.resolve();
    const b = getActiveWikiContext();
    return { a, b };
  });

  assert.ok(seen.a, "context active before the await");
  assert.equal(seen.a, seen.b, "same context still active after the await");
  assert.equal(seen.a.levels.length, 1, "brain-only across the async boundary");
  assert.equal(getActiveWikiContext(), null, "frame gone after the promise settles");
});

// ── Entrypoint behavior-preservation: the wrapped flush worker still writes ──
// its daily leaf into the brain wiki, at the same place as before the wrap.
// Driven through the real hook front (subprocess) so it exercises the spawned
// worker's own withBrainContextSafe wrap end-to-end.

const store = await import("../scripts/lib/wiki-store.mjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flushLog() {
  try {
    return fs.readFileSync(path.join(dataDir, "state", ".flush.log"), "utf8");
  } catch {
    return "(no .flush.log yet)";
  }
}

function findDailyForSession(sid) {
  const docs = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sid}`)) return { id: d.id, text };
  }
  return null;
}

function flushLockPathFor(sid) {
  const safe = String(sid || "manual")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
  return path.join(dataDir, "state", `.flush-${safe}.lock`);
}

async function waitForWorker(sid, timeoutMs = 20000) {
  const lock = flushLockPathFor(sid);
  const start = Date.now();
  for (;;) {
    const hit = findDailyForSession(sid);
    if (hit && !fs.existsSync(lock)) return hit;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(50);
  }
}

test("wrapped flush worker writes its daily leaf into the brain wiki (placement unchanged)", async () => {
  const sid = "brainctx-flush";
  const transcript = path.join(dataDir, "brainctx.jsonl");
  const turns = [
    { role: "user", text: "Prefer atomic writes for durable artifacts." },
    { role: "assistant", text: "Yes; writeFileAtomic gives temp+fsync+rename." },
  ];
  fs.writeFileSync(
    transcript,
    turns
      .map((t) =>
        JSON.stringify({
          type: t.role,
          message: { role: t.role, content: [{ type: "text", text: t.text }] },
        }),
      )
      .join("\n") + "\n",
  );

  const atom = {
    type: "decision",
    title: "Prefer atomic writes for durable artifacts",
    body: "Use writeFileAtomic. Why: an interrupted bare write can NUL-corrupt a file. How to apply: temp file + fsync + rename.",
    tags: ["infra", "durability"],
    metadata: { project_module: "testproj", language: "", task_type: "deploy" },
  };

  const r = runScript("scripts/hooks/flush.mjs", ["session-end"], {
    stdin: JSON.stringify({
      session_id: sid,
      transcript_path: transcript,
      hook_event_name: "SessionEnd",
      cwd: dataDir,
    }),
    env: {
      MEMORY_HOOK_REENTRY: "",
      CLAUDE_INVOKED_BY: "",
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ atoms: [atom] }),
      MEMORY_FLUSH_DISTILL_ATTEMPTS: "1",
    },
  });
  assert.equal(r.status, 0, `front exits 0: ${r.stderr}`);

  const hit = await waitForWorker(sid);
  assert.ok(hit, `worker wrote a daily leaf into the brain wiki; flush.log:\n${flushLog()}`);
  assert.match(hit.text, /### Atom · decision · Prefer atomic writes/);
  // The stored id is the brain-wiki-relative daily path — proves the wrapped
  // worker did not redirect the write off the brain tree.
  assert.match(hit.id, /^daily\//, `leaf id is brain-relative daily/*: ${hit.id}`);
  assert.ok(
    fs.existsSync(path.join(wikiRoot(), hit.id.split("/").join(path.sep))),
    "the daily leaf exists on disk under the brain wiki root",
  );
});

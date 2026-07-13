// Phase B7 e2e — digestion isolation. compile runs brain-only (withBrainContext),
// so a co-located repo MOUNT must receive ZERO compile writes while the brain
// promotes its daily atoms into self_improvement/knowledge; a recompile is a clean
// no-op. Real seams: the REAL flush + compile scripts, LLM stubbed via mock.
// Lexical backend, realpath'd /tmp. (Brain-only promotion mechanics are covered by
// lifecycle.e2e tests 5/5b/8 — not rebuilt; this adds the mount-isolation guarantee.)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setupWorkspace, cleanup, runScript } from "../harness.mjs";
import { realTmp, rmAll, mkdirp, writeMountLayout } from "./federation-helpers.mjs";

const { dataDir } = setupWorkspace();
const store = await import("../../scripts/lib/wiki-store.mjs");

/** @type {string[]} */
const tmps = [];
after(() => {
  cleanup(dataDir);
  rmAll(tmps);
});

const LESSON_ATOM = {
  type: "self-improvement-lesson",
  title: "Always await async db calls",
  body: "Always await async database calls before reading the result set.",
  tags: ["async", "database"],
  metadata: {
    project_module: "testproj",
    language: "typescript",
    task_type: "implementation",
    error_pattern: "missing-await-async",
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} name @param {{ role: string, text: string }[]} turns @returns {string} */
function writeTranscript(name, turns) {
  const file = path.join(dataDir, name);
  const lines = turns.map((t) =>
    JSON.stringify({
      type: t.role,
      message: { role: t.role, content: [{ type: "text", text: t.text }] },
    }),
  );
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** @param {string} transcriptPath @param {object[]} atoms @param {string} sid */
function runFlush(transcriptPath, atoms, sid) {
  return runScript("scripts/hooks/flush.mjs", ["session-end"], {
    stdin: JSON.stringify({
      session_id: sid,
      transcript_path: transcriptPath,
      hook_event_name: "SessionEnd",
      cwd: dataDir,
    }),
    env: {
      MEMORY_HOOK_REENTRY: "",
      CLAUDE_INVOKED_BY: "",
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ atoms }),
      MEMORY_FLUSH_DISTILL_ATTEMPTS: "1",
    },
  });
}

function runCompile() {
  return runScript("scripts/compile.mjs", [], {
    env: {
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: JSON.stringify({ action: "create", reason: "e2e" }),
    },
  });
}

/** @param {string} sid @returns {{ id: string } | null} */
function findDailyForSession(sid) {
  const docs = store.listDocuments({
    prefix: "daily-",
    enabled: "true",
    datasetId: "daily",
  }).documents;
  for (const d of docs) {
    const { text } = store.readDocument({ documentId: d.id, datasetId: "daily" });
    if (text.includes(`session_id: ${sid}`)) return { id: d.id };
  }
  return null;
}

/** @param {string} sid */
function flushLockPathFor(sid) {
  const safe = String(sid || "manual")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 80);
  return path.join(dataDir, "state", `.flush-${safe}.lock`);
}

/** @param {string} sid @param {number} [timeoutMs] */
async function waitForDaily(sid, timeoutMs = 20000) {
  const lock = flushLockPathFor(sid);
  const start = Date.now();
  for (;;) {
    if (findDailyForSession(sid) && !fs.existsSync(lock)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(50);
  }
}

/** Recursive relpath→content snapshot of a tree. @param {string} dir @returns {Record<string,string>} */
function snapshot(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} d @param {string} base */
  const walk = (d, base) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else out[rel] = fs.readFileSync(abs, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

function siCount() {
  return store.listDocuments({ datasetId: "self_improvement", enabled: "true" }).documents.length;
}

test("digest: compile promotes a brain daily atom while a co-located MOUNT receives ZERO writes", async () => {
  const home = realTmp("digest-iso");
  tmps.push(home);
  const mountWiki = writeMountLayout(
    mkdirp(home, "svc"),
    "layout:\n  - path: knowledge\n  - path: daily\n",
  );
  const leafDir = path.join(mountWiki, "knowledge");
  fs.mkdirSync(leafDir, { recursive: true });
  fs.writeFileSync(
    path.join(leafDir, "mountfact.md"),
    "---\nmemory:\n  atom_type: reference\n  project_module: svc\n---\n\nquietmount body.\n",
  );
  const before = snapshot(mountWiki);

  const t = writeTranscript("digest.jsonl", [
    { role: "assistant", text: "Always await async db calls before reading results." },
  ]);
  assert.equal(runFlush(t, [LESSON_ATOM], "d1").status, 0, "flush exit 0");
  assert.ok(await waitForDaily("d1"), "worker wrote the brain daily for d1");

  const siBefore = siCount();
  assert.equal(runCompile().status, 0, "compile exit 0");
  assert.ok(siCount() > siBefore, "compile promoted a lesson into the BRAIN self_improvement");

  assert.deepEqual(
    snapshot(mountWiki),
    before,
    "the mount tree is byte-identical — compile wrote nothing to it",
  );
});

test("digest: a recompile is a clean no-op and the mount stays untouched", async () => {
  const home = realTmp("digest-idem");
  tmps.push(home);
  const mountWiki = writeMountLayout(
    mkdirp(home, "svc2"),
    "layout:\n  - path: knowledge\n  - path: daily\n",
  );
  const before = snapshot(mountWiki);

  const siAfterFirst = siCount();
  assert.equal(runCompile().status, 0, "recompile exit 0");
  assert.equal(siCount(), siAfterFirst, "recompile promotes nothing new (idempotent)");
  assert.deepEqual(snapshot(mountWiki), before, "mount still untouched on recompile");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTRUCTIONS } from "../scripts/lib/discipline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..");

test("INSTRUCTIONS contains the new write-gate invariant vocabulary", () => {
  assert.ok(INSTRUCTIONS.includes("WRITE-GATED"), "mentions WRITE-GATED");
  assert.ok(INSTRUCTIONS.includes("userRequested:true"), "mentions userRequested:true");
  assert.ok(/propose/i.test(INSTRUCTIONS), "mentions propose");
  assert.ok(INSTRUCTIONS.includes("explicit yes"), "mentions explicit yes");
});

test("INSTRUCTIONS does NOT contain the old autonomous-save phrasing", () => {
  assert.ok(
    !INSTRUCTIONS.includes("call save_lesson BEFORE replying"),
    "old autonomous-save phrasing must be gone",
  );
});

test("INSTRUCTIONS contains rule 8 (consolidate_memory) wording", () => {
  assert.ok(INSTRUCTIONS.includes("consolidate_memory"), "mentions consolidate_memory");
  assert.ok(INSTRUCTIONS.includes("system-maintenance"), "mentions system-maintenance");
});

test("INSTRUCTIONS still mentions other rules and concepts", () => {
  assert.ok(INSTRUCTIONS.includes("recall_lessons"), "mentions recall_lessons");
  assert.ok(INSTRUCTIONS.includes("save_to_dataset"), "mentions save_to_dataset");
  assert.ok(INSTRUCTIONS.includes("UNTRUSTED"), "mentions UNTRUSTED fences");
  assert.ok(
    INSTRUCTIONS.includes("health check IS the attempt"),
    "mentions the health-check-is-the-attempt phrase",
  );
  assert.ok(INSTRUCTIONS.includes("search_memory"), "mentions search_memory");
});

test("templates/skills/self-improvement.md mirror contains the write-gate vocabulary", () => {
  const p = path.join(SRC, "templates/skills/self-improvement.md");
  const raw = fs.readFileSync(p, "utf8");
  assert.ok(raw.includes("WRITE-GATED"), "self-improvement.md mirrors WRITE-GATED");
  assert.ok(raw.includes("userRequested"), "self-improvement.md mirrors userRequested");
  assert.ok(/propose/i.test(raw), "self-improvement.md mirrors propose");
});

test("templates/rules/memory-write-gate.md exists and contains the propose-then-confirm rule", () => {
  const p = path.join(SRC, "templates/rules/memory-write-gate.md");
  assert.ok(fs.existsSync(p), "memory-write-gate.md exists");
  const raw = fs.readFileSync(p, "utf8");
  assert.ok(raw.includes("write-gated") || raw.includes("WRITE-GATED") || raw.includes("write-gate"),
    "memory-write-gate.md mentions the write-gate concept");
  assert.ok(/propose/i.test(raw), "memory-write-gate.md mentions propose");
  assert.ok(raw.includes("userRequested"), "memory-write-gate.md mentions userRequested");
  assert.ok(
    raw.includes("explicit") || raw.includes("yes"),
    "memory-write-gate.md mentions explicit confirmation",
  );
});

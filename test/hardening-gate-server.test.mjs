import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SRC } from "./harness.mjs";
import { withSystemMaintenance, isSystemMaintenance } from "../scripts/lib/maintenance-tag.mjs";

// The MCP server child process MUST be spawned with the env vars it should see;
// the harness's setupWorkspace() mutates THIS process's env (which the parent
// then forwards to children), so the child sees the same MEMORY_DATA_DIR we
// configure here. We deliberately do not re-use the shared harness setup because
// two scenarios in this file need a different gate state (default vs disabled via
// settings.yaml `gate.selfImprovementEnabled: false`), so each scenario brings up
// its own isolated workspace + server.

function makeWorkspace({ writeGate } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lwm-gate-"));
  const env = {
    ...process.env,
    MEMORY_DATA_DIR: dataDir,
    MEMORY_DEFAULT_PROJECT_MODULE: "testproj",
    LLM_WIKI_SKILL_CLI: path.join(
      SRC,
      "node_modules/@ctxr/skill-llm-wiki/scripts/cli.mjs",
    ),
    LLM_WIKI_FIXED_TIMESTAMP: "1700000000",
    LLM_WIKI_NO_PROMPT: "1",
  };
  // Pin settings via the YAML — embed backend always lexical for tests, and
  // the write-gate toggled per scenario.
  fs.mkdirSync(path.join(dataDir, "settings"), { recursive: true });
  const settingsYaml =
    "embed:\n  backend: lexical\n" +
    (writeGate === "off" ? "gate:\n  selfImprovementEnabled: false\n" : "");
  fs.writeFileSync(path.join(dataDir, "settings", "settings.yaml"), settingsYaml);
  const init = spawnSync(process.execPath, [path.join(SRC, "scripts/cli.mjs"), "init"], {
    env,
    encoding: "utf8",
  });
  if (init.status !== 0) {
    throw new Error(`wiki init failed: ${init.stderr || init.stdout}`);
  }
  return { dataDir, env };
}

async function connectClient(env) {
  const client = new Client({ name: "lwm-gate-test", version: "0.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env,
    cwd: SRC,
  });
  await client.connect(transport);
  return { client, transport };
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

function readAuditLog(dir) {
  const p = path.join(dir, "state", ".save-gate-audit.log");
  try {
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ─── Scenario A: write gate ON (default) ─────────────────────────────────────

const gateOn = makeWorkspace();
let gateOnClient;
let gateOnTransport;

before(async () => {
  const { client, transport } = await connectClient(gateOn.env);
  gateOnClient = client;
  gateOnTransport = transport;
});

after(async () => {
  try {
    await gateOnClient?.close();
  } catch {
    /* ignore */
  }
  rmDir(gateOn.dataDir);
});

test("save_lesson WITHOUT userRequested -> refused by write-gate", async () => {
  // The Zod schema declares `userRequested` as required (no `.optional()`), so
  // omitting it surfaces as a validation error from the MCP server BEFORE the
  // handler runs. We accept either shape: a thrown error from the SDK (schema
  // rejection) OR the structured refusal envelope from the handler, since both
  // outcomes prove the call is blocked when the flag is absent.
  let refused = false;
  try {
    const res = await gateOnClient.callTool({
      name: "save_lesson",
      arguments: {
        title: "Should be refused",
        body: "This lesson should not be saved without userRequested.",
        metadata: {
          area: "testarea",
          task_type: "implementation",
          error_pattern: "should-be-refused",
        },
      },
    });
    if (res.isError) {
      refused = true;
    } else {
      const payload = parse(res);
      if (payload.ok === false && payload.error === "write-gate-refused") {
        refused = true;
      }
    }
  } catch {
    refused = true;
  }
  assert.equal(refused, true, "save_lesson without userRequested is refused");
});

test("save_lesson with userRequested:false -> refused by write-gate", async () => {
  const res = await gateOnClient.callTool({
    name: "save_lesson",
    arguments: {
      title: "Should also be refused",
      body: "userRequested:false should still be refused.",
      userRequested: false,
      metadata: {
        area: "testarea",
        task_type: "implementation",
        error_pattern: "false-flag-refused",
      },
    },
  });
  const payload = parse(res);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "write-gate-refused");
});

test("save_lesson with userRequested:true -> success", async () => {
  const res = await gateOnClient.callTool({
    name: "save_lesson",
    arguments: {
      title: "Permitted lesson with explicit user request",
      body: "userRequested:true should pass the gate.",
      userRequested: true,
      metadata: {
        area: "testarea",
        task_type: "implementation",
        error_pattern: "explicit-ask-allowed",
      },
    },
  });
  const payload = parse(res);
  assert.equal(payload.ok, true, `save_lesson should succeed: ${JSON.stringify(payload)}`);
});

test("audit trail records L3 decisions (refused + accepted/consent) and skips non-gated writes", async () => {
  const auditPath = path.join(gateOn.dataDir, "state", ".save-gate-audit.log");
  const readRecs = () => {
    let raw = "";
    try {
      raw = fs.readFileSync(auditPath, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };

  // (1) A refused save_lesson (explicit false reaches the handler) is audited.
  await gateOnClient.callTool({
    name: "save_lesson",
    arguments: {
      title: "AUDIT refused probe",
      body: "no real flag; should be refused and audited.",
      userRequested: false,
      metadata: { area: "auditarea", task_type: "implementation", error_pattern: "audit-refused" },
    },
  });
  const refused = readRecs().find((r) => r.title === "AUDIT refused probe");
  assert.ok(refused, "refused save_lesson is audited");
  assert.equal(refused.layer, "L3");
  assert.equal(refused.tool, "save_lesson");
  assert.equal(refused.status, "refused");
  assert.equal(refused.consent, undefined, "a refusal records no consent");
  assert.equal(refused.userRequested, false, "the rejected false flag is recorded as-is");

  // (2) An accepted save_lesson records status:accepted + consent:user-flag.
  await gateOnClient.callTool({
    name: "save_lesson",
    arguments: {
      title: "AUDIT accepted probe",
      body: "explicit flag; should be accepted and audited.",
      userRequested: true,
      metadata: { area: "auditarea", task_type: "implementation", error_pattern: "audit-accepted" },
    },
  });
  const accepted = readRecs().find((r) => r.title === "AUDIT accepted probe");
  assert.ok(accepted, "accepted save_lesson is audited");
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.consent, "user-flag");
  assert.equal(accepted.userRequested, true);
  assert.equal(accepted.area, "auditarea");
  assert.equal(accepted.error_pattern, "audit-accepted");

  // (3) A non-gated knowledge write is NOT audited.
  await gateOnClient.callTool({
    name: "save_to_dataset",
    arguments: {
      dataset: "knowledge",
      name: "AUDIT-knowledge-probe.md",
      text: "# Knowledge probe\n\na fact body that must not be gated or audited.",
      metadata: { atom_type: "reference", area: "auditarea", task_type: "docs" },
    },
  });
  assert.ok(
    !readRecs().some((r) => r.title === "AUDIT-knowledge-probe.md"),
    "non-gated knowledge writes leave no audit record",
  );
});

test("save_to_dataset(dataset=\"self_improvement\") WITHOUT userRequested -> refused", async () => {
  const res = await gateOnClient.callTool({
    name: "save_to_dataset",
    arguments: {
      dataset: "self_improvement",
      name: "lesson-via-dataset.md",
      text: "# Should be refused\n\n- type: self-improvement-lesson\n- area: testarea\n- task_type: implementation\n- error_pattern: refused\n\nbody",
      metadata: {
        atom_type: "self-improvement-lesson",
        area: "testarea",
        task_type: "implementation",
        error_pattern: "refused",
      },
    },
  });
  const payload = parse(res);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "write-gate-refused");
});

test("save_to_dataset(dataset=\"knowledge\") WITHOUT userRequested -> success (not gated)", async () => {
  const res = await gateOnClient.callTool({
    name: "save_to_dataset",
    arguments: {
      dataset: "knowledge",
      name: "knowledge-not-gated.md",
      text: "# Knowledge note\n\nKnowledge writes are not gated.",
      metadata: { atom_type: "reference", project_module: "testproj", area: "testarea" },
    },
  });
  const payload = parse(res);
  assert.equal(payload.ok, true, `knowledge save should succeed: ${JSON.stringify(payload)}`);
});

test("save_to_dataset(dataset=\"plans\") WITHOUT userRequested -> success (not gated)", async () => {
  const res = await gateOnClient.callTool({
    name: "save_to_dataset",
    arguments: {
      dataset: "plans",
      name: "plan-not-gated.plan.md",
      text: "# Plan\n\nPlans are not gated.",
      metadata: { atom_type: "reference", project_module: "testproj", area: "testarea" },
    },
  });
  const payload = parse(res);
  assert.equal(payload.ok, true, `plans save should succeed: ${JSON.stringify(payload)}`);
});

test("save_to_dataset(dataset=\"self_improvement\") with userRequested:true -> success", async () => {
  const res = await gateOnClient.callTool({
    name: "save_to_dataset",
    arguments: {
      dataset: "self_improvement",
      name: "lesson-via-dataset-allowed.md",
      text: "# Allowed lesson\n\n- type: self-improvement-lesson\n- area: testarea\n- task_type: implementation\n- error_pattern: allowed\n\nbody",
      userRequested: true,
      metadata: {
        atom_type: "self-improvement-lesson",
        area: "testarea",
        task_type: "implementation",
        error_pattern: "allowed",
      },
    },
  });
  const payload = parse(res);
  assert.equal(payload.ok, true, `gated save_to_dataset with flag should succeed: ${JSON.stringify(payload)}`);
});

test("audit covers the save_to_dataset + write_memory accept paths (consent: user-flag)", async () => {
  await gateOnClient.callTool({
    name: "save_to_dataset",
    arguments: {
      dataset: "self_improvement",
      name: "AUDIT-dataset-probe.md",
      text: "# Dataset probe\n\n- type: self-improvement-lesson\n- area: auditarea\n- task_type: implementation\n- error_pattern: ds-audit\n\nbody for the dataset audit probe.",
      userRequested: true,
      metadata: { atom_type: "self-improvement-lesson", area: "auditarea", task_type: "implementation", error_pattern: "ds-audit" },
    },
  });
  await gateOnClient.callTool({
    name: "write_memory",
    arguments: {
      name: "AUDIT-writemem-probe.md",
      text: "# Write-memory probe\n\nA write_memory probe body long enough to satisfy the 20-char minimum.",
      datasetId: "self_improvement",
      userRequested: true,
      metadata: { atom_type: "self-improvement-lesson", area: "auditarea", task_type: "implementation", error_pattern: "wm-audit" },
    },
  });
  const recs = readAuditLog(gateOn.dataDir);
  const ds = recs.find((r) => r.tool === "save_to_dataset" && r.title === "AUDIT-dataset-probe.md");
  assert.ok(ds, "save_to_dataset(self_improvement) accept is audited");
  assert.equal(ds.status, "accepted");
  assert.equal(ds.consent, "user-flag");
  const wm = recs.find((r) => r.tool === "write_memory" && r.title === "AUDIT-writemem-probe.md");
  assert.ok(wm, "write_memory(self_improvement) accept is audited");
  assert.equal(wm.status, "accepted");
  assert.equal(wm.consent, "user-flag");
});

test("audit covers the path-into-self_improvement bypass (dataset:knowledge + path)", async () => {
  // The security-relevant branch: a write whose dataset claims "knowledge" but
  // whose path lands in self_improvement must STILL be gated AND audited. The
  // load-bearing proof is that an audit record EXISTS for a dataset:"knowledge"
  // call — which only happens if the path-bypass gating fired.
  const res = await gateOnClient.callTool({
    name: "save_to_dataset",
    arguments: {
      dataset: "knowledge",
      name: "AUDIT-pathbypass-probe.md",
      text: "# Path bypass probe\n\nrouted into self_improvement via a path override.",
      path: "self_improvement/auditable",
      userRequested: true,
      metadata: { atom_type: "self-improvement-lesson", area: "auditarea", task_type: "implementation", error_pattern: "path-audit" },
    },
  });
  assert.equal(parse(res).ok, true, `path-routed write should succeed: ${JSON.stringify(parse(res))}`);
  const rec = readAuditLog(gateOn.dataDir).find((r) => r.title === "AUDIT-pathbypass-probe.md");
  assert.ok(rec, "a knowledge-dataset write smuggled into self_improvement via path is audited");
  assert.equal(rec.tool, "save_to_dataset");
  assert.equal(rec.status, "accepted");
  assert.equal(rec.consent, "user-flag");
});

// ─── Scenario B: write gate OFF via env -─────────────────────────────────────

const gateOff = makeWorkspace({ writeGate: "off" });
let gateOffClient;
let gateOffTransport;

before(async () => {
  const { client, transport } = await connectClient(gateOff.env);
  gateOffClient = client;
  gateOffTransport = transport;
});

after(async () => {
  try {
    await gateOffClient?.close();
  } catch {
    /* ignore */
  }
  rmDir(gateOff.dataDir);
});

test("gate.selfImprovementEnabled=false (YAML): save_lesson without userRequested -> success", async () => {
  // Schema still requires userRequested (z.boolean()), so we satisfy the SCHEMA
  // by passing false — but with the gate disabled in settings.yaml the handler
  // should NOT refuse on `userRequested:false`. This proves the operator escape
  // hatch (settings.yaml `gate.selfImprovementEnabled: false`).
  const res = await gateOffClient.callTool({
    name: "save_lesson",
    arguments: {
      title: "Gate disabled — should save",
      body: "With the write-gate env knob off, the refusal must be bypassed.",
      userRequested: false,
      metadata: {
        area: "testarea",
        task_type: "implementation",
        error_pattern: "gate-disabled-allowed",
      },
    },
  });
  const payload = parse(res);
  assert.equal(payload.ok, true, `gate-off save should succeed: ${JSON.stringify(payload)}`);
  // The accepted write is audited with consent "gate-disabled" (gate off, no
  // userRequested flag, no maintenance frame) — the consentBasis(false,false) path.
  const rec = readAuditLog(gateOff.dataDir).find((r) => r.title === "Gate disabled — should save");
  assert.ok(rec, "the gate-off save is audited");
  assert.equal(rec.status, "accepted");
  assert.equal(rec.consent, "gate-disabled");
});

// ─── Scenario C: source-level maintenance-tag exemption ──────────────────────

// SKIP: end-to-end exemption via withSystemMaintenance() across the MCP wire is
// not testable here. The L3 gate's `isSystemMaintenance()` check reads
// AsyncLocalStorage scoped to the ORCHESTRATOR's async frame; an MCP client
// call arrives in the server child's own fresh async frame, so there is no
// way to project the maintenance flag across the JSON-RPC boundary. Calling
// `impl.saveLesson` inside `withSystemMaintenance` does not exercise the gate
// either (the gate lives only in the MCP handler, not in the impl). The full
// integration is covered by the consolidate workflow, which spawns its writes
// inside its OWN process and observes the flag in the same frame.
//
// What we CAN verify in-process: the building block — that the
// `userRequested !== true && !isSystemMaintenance()` predicate flips to "do
// not refuse" when wrapped in `withSystemMaintenance`. This is a unit-level
// guard against the gate code accidentally evaluating the flag eagerly.
test("maintenance-tag building block: predicate yields no-refuse inside withSystemMaintenance", () => {
  const userRequested = false;
  // Outside the frame: refuse condition is true.
  assert.equal(userRequested !== true && !isSystemMaintenance(), true);
  // Inside the frame: refuse condition is false (exempted).
  withSystemMaintenance(() => {
    assert.equal(userRequested !== true && !isSystemMaintenance(), false);
  });
  // After the frame: refuse condition is true again.
  assert.equal(userRequested !== true && !isSystemMaintenance(), true);
});

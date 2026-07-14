import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, scopeClient, brainTargetClient } from "./harness.mjs";

const { dataDir } = setupWorkspace();

let client;
let transport;
// The pre-scopes callTool handle, captured before scopeClient injects `scopes`,
// so the hard-fail test can send a call with NO `scopes` at all.
let callToolRaw;

before(async () => {
  client = new Client({ name: "lwm-test", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env },
    cwd: SRC,
  });
  await client.connect(transport);
  callToolRaw = client.callTool.bind(client);
  scopeClient(client, [dataDir]);
  brainTargetClient(client);
});

after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  cleanup(dataDir);
});

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("claude-code mcp template uses ${HOME} and no OTHER ${...} tokens", () => {
  const raw = fs.readFileSync(path.join(SRC, "templates/mcp.json"), "utf8");
  // D-f: the server path is home-based via ${HOME} (Claude Code interpolates it);
  // any OTHER ${...} would be an accidental unexpanded token.
  assert.match(raw, /\$\{HOME\}\/\.llm-wiki-memory\/src\/mcp-server\/index\.mjs/);
  assert.ok(!/\$\{(?!HOME[}:])/.test(raw), "template must not contain a ${...} other than ${HOME}");
  const cfg = JSON.parse(raw);
  const server = cfg.mcpServers["llm-wiki-memory"];
  assert.ok(server, "llm-wiki-memory server present");
  // No MEMORY_DATA_DIR override: the server self-locates via env.mjs WORKSPACE_DIR.
  assert.ok(!(server.env && "MEMORY_DATA_DIR" in server.env), "no MEMORY_DATA_DIR override");
});

test("server boots and registers the expected tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    "get_memory_config",
    "list_datasets",
    "search_memory",
    "recall_lessons",
    "save_lesson",
    "save_to_dataset",
    "write_memory",
    "disable_document",
    "enable_document",
    "delete_document",
    "audit_memory",
    "validate_layout",
    "validate_topology",
    "reload_layout",
  ]) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }
});

test("reload_layout clears the caches and reports what it reloaded", async () => {
  const r = parse(await client.callTool({ name: "reload_layout", arguments: {} }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.reloaded, ["layout", "topology"]);
});

test("validate_layout validates the wiki's contract and never crashes the server", async () => {
  // Default (env-resolved wiki): the test wiki has a valid .layout/layout.yaml.
  const ok = parse(await client.callTool({ name: "validate_layout", arguments: {} }));
  assert.equal(ok.ok, true, `default wiki layout valid: ${JSON.stringify(ok)}`);

  // A missing layout path returns a structured failure, not a thrown crash.
  const missing = parse(
    await client.callTool({
      name: "validate_layout",
      arguments: { path: "/nonexistent/does-not-exist.yaml" },
    }),
  );
  assert.equal(missing.ok, false, "missing layout reports ok:false");
});

test("get_memory_config reports the wiki + categories + resolved levels", async () => {
  const cfg = parse(await client.callTool({ name: "get_memory_config", arguments: {} }));
  assert.ok(cfg.wikiRoot.includes(".llm-wiki-memory") || cfg.wikiRoot.includes("wiki"));
  assert.deepEqual(cfg.categories, [
    "knowledge",
    "self_improvement",
    "plans",
    "investigations",
    "daily",
  ]);
  // G2: the resolved scope chain is exposed so a caller can pick an explicit
  // target by path (the ONLY way to distinguish two same-identity siblings).
  assert.ok(Array.isArray(cfg.levels) && cfg.levels.length >= 1, "levels array present");
  const brain = cfg.levels.find((l) => l.ownership === "wiki");
  assert.ok(brain, "the wiki-owned brain level is listed");
  assert.equal(brain.depth, 0, "the brain is depth 0");
  for (const l of cfg.levels) {
    for (const k of ["root", "mountDir", "projectModule", "ownership", "depth"]) {
      assert.ok(k in l, `each level carries ${k}`);
    }
  }
});

test("save_lesson then recall_lessons round-trips through the server", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_lesson",
      arguments: {
        // gate.userRequested attests the user explicitly asked (the L3 write-gate
        // refuses a self_improvement write without it); simulated here.
        write: {
          title: "Prefer index-rebuild-one over full rebuild on hot paths",
          body: "On hot paths, call index-rebuild-one per touched dir rather than a full rebuild.",
          metadata: {
            project_module: "testproj",
            task_type: "implementation",
            error_pattern: "full-rebuild-hot-path",
          },
          tags: ["performance"],
        },
        gate: { userRequested: true },
      },
    }),
  );
  assert.equal(saved.ok, true, "save_lesson ok");

  const recalled = parse(
    await client.callTool({
      name: "recall_lessons",
      arguments: { query: "rebuild hot path index", filters: { project_module: "testproj" } },
    }),
  );
  assert.ok(recalled.lessonHits >= 1, "recall finds the lesson");
});

test("save_to_dataset upserts and search_memory finds it", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-mcp-note.md",
          text: "# MCP note\n\nThe stdio server is registered in .mcp.json.",
          metadata: { atom_type: "reference", project_module: "testproj" },
        },
      },
    }),
  );
  assert.equal(saved.ok, true);

  const found = parse(
    await client.callTool({
      name: "search_memory",
      arguments: {
        query: "stdio server registered mcp.json",
        filters: { project_module: "testproj" },
      },
    }),
  );
  assert.ok(
    found.records.some((r) => r.documentName === "knowledge-mcp-note.md"),
    "search finds the note",
  );
});

test("save_to_dataset rejects an off-vocabulary task_type with an actionable envelope", async () => {
  const res = await client.callTool({
    name: "save_to_dataset",
    arguments: {
      write: {
        dataset: "knowledge",
        name: "knowledge-bad-tasktype.md",
        text: "# bad\n\noff-vocab task_type",
        metadata: { task_type: "frobnicate" },
      },
    },
  });
  assert.equal(res.isError, true, "off-vocab task_type is rejected");
  const env = parse(res);
  assert.equal(env.ok, false);
  assert.equal(env.field, "task_type");
  assert.ok(
    Array.isArray(env.allowed) && env.allowed.includes("debugging"),
    "envelope lists allowed",
  );
});

test("save_to_dataset rejects an undeclared dataset with an actionable envelope", async () => {
  const res = await client.callTool({
    name: "save_to_dataset",
    arguments: { write: { dataset: "no_such_category", name: "x.md", text: "# x\n\nbody" } },
  });
  assert.equal(res.isError, true, "undeclared dataset is rejected");
  const env = parse(res);
  assert.equal(env.field, "dataset");
  assert.ok(env.allowed.includes("knowledge"), "envelope lists the declared categories");
});

test("a gated no-consent write is refused GATE-FIRST, even with an off-vocab enum", async () => {
  // self_improvement + no userRequested + an off-vocab task_type: the gate refusal
  // must win over (and precede) the enum validation, so the refused-audit still
  // fires and no input detail leaks to an un-consented caller.
  const res = await client.callTool({
    name: "save_to_dataset",
    arguments: {
      write: {
        dataset: "self_improvement",
        name: "si-note.md",
        text: "# si\n\nbody",
        metadata: { area: "a", task_type: "frobnicate", error_pattern: "e" },
      },
    },
  });
  const env = parse(res);
  assert.equal(env.ok, false);
  assert.equal(env.error, "write-gate-refused", "gate refusal precedes the enum validation");
});

test("move_document is registered", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.map((t) => t.name).includes("move_document"), "move_document registered");
});

test("move_document refuses a facet-category free-path move (structured, no crash)", async () => {
  // The default test layout has only facet/daily categories — none curated. A
  // facet leaf relocates by metadata, so a raw-path move must be refused with a
  // structured reason, not throw and kill the server.
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-move-victim.md",
          text: "# Move victim\n\nA facet leaf relocates by metadata, never a raw path.",
          metadata: { atom_type: "reference", project_module: "testproj" },
        },
      },
    }),
  );
  assert.equal(saved.ok, true);
  const id = saved.created.document.id;
  const res = parse(
    await client.callTool({
      name: "move_document",
      arguments: {
        select: { documentId: id, toPath: "knowledge/elsewhere/knowledge-move-victim.md" },
      },
    }),
  );
  assert.equal(res.ok, false, "facet move refused, not thrown");
  assert.match(res.reason, /facet/, `structured refusal reason: ${JSON.stringify(res)}`);
});

test("audit_memory groups two same-key lessons into a duplicate-error-pattern finding (dispatchAudit)", async () => {
  // Seed two DISTINCT-title self_improvement lessons that share area+error_pattern,
  // so dispatchAudit's byErrorPattern grouping + the ids.length>1 check fire. A
  // unique error_pattern isolates this finding from other lessons in the wiki.
  const lesson = (title) => ({
    write: {
      title,
      body: `Audit probe ${title}: same area+error_pattern so the duplicate class groups them.`,
      metadata: { area: "auditprobe", task_type: "debugging", error_pattern: "audit-dup-ep-probe" },
    },
    gate: { userRequested: true },
  });
  for (const title of ["Audit probe A", "Audit probe B"]) {
    const saved = parse(await client.callTool({ name: "save_lesson", arguments: lesson(title) }));
    assert.equal(saved.ok, true, `seeded ${title}`);
  }
  const res = parse(
    await client.callTool({
      name: "audit_memory",
      arguments: { audit: { classes: ["duplicate-error-pattern"] } },
    }),
  );
  assert.equal(res.ok, true);
  const dup = res.findings.find(
    (f) => f.class === "duplicate-error-pattern" && f.key === "auditprobe:audit-dup-ep-probe",
  );
  assert.ok(dup, `duplicate-error-pattern finding present: ${JSON.stringify(res.findings)}`);
  assert.equal(dup.documentIds.length, 2, "both same-error_pattern lessons grouped");
});

test("search_memory excerpts oversized hit bodies at the MCP boundary; fullContent opts out", async () => {
  const marker = "zqxoverflowmarker";
  const huge = `# Huge note\n\n${`${marker} padding sentence number. `.repeat(400)}`;
  assert.ok(huge.length > 5000, "body is genuinely large");
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "knowledge-huge-body.md",
          text: huge,
          metadata: { atom_type: "reference", project_module: "testproj" },
        },
      },
    }),
  );
  assert.equal(saved.ok, true);

  const clipped = parse(
    await client.callTool({
      name: "search_memory",
      arguments: { query: `${marker} padding sentence`, filters: { project_module: "testproj" } },
    }),
  );
  const hit = clipped.records.find((r) => r.documentName === "knowledge-huge-body.md");
  assert.ok(hit, "huge note found");
  assert.ok(hit.content.length < 1000, `body excerpted, got ${hit.content.length}`);
  assert.equal(hit.truncated, true);
  assert.ok(hit.fullChars > hit.content.length, "fullChars records the original length");

  const full = parse(
    await client.callTool({
      name: "search_memory",
      arguments: {
        query: `${marker} padding sentence`,
        filters: { project_module: "testproj" },
        fullContent: true,
      },
    }),
  );
  const fullHit = full.records.find((r) => r.documentName === "knowledge-huge-body.md");
  assert.ok(fullHit.content.length > 1000, "fullContent returns the whole body");
  assert.equal(fullHit.truncated, undefined, "no truncation flag when full");
});

test("HARD FAIL: a tool call with missing or empty `scopes` is schema-rejected", async () => {
  // Phase C 5c contract: `scopes` is a REQUIRED, non-empty array on every tool.
  // The zod field shape (min(1) array, NOT .optional()) makes the SDK emit
  // required + minItems:1, so both a MISSING and an EMPTY `scopes` fail the
  // server-side input-schema validation before any handler runs. This SDK
  // surfaces that failure as a resolved `{ isError: true }` envelope (not a
  // thrown promise), same as the write-gate schema tests. We use the pre-scopes
  // raw handle so the harness's scopeClient does not backfill scopes.

  // (a) scopes entirely absent -> input-validation error.
  const missing = await callToolRaw({ name: "search_memory", arguments: { query: "anything" } });
  assert.equal(missing.isError, true, "missing scopes must be rejected");
  assert.match(missing.content[0].text, /scopes|Invalid arguments|Input validation/i);

  // (b) scopes present but empty -> input-validation error (min(1) on the array).
  const empty = await callToolRaw({
    name: "search_memory",
    arguments: { query: "anything", scopes: [] },
  });
  assert.equal(empty.isError, true, "empty scopes must be rejected");
  assert.match(empty.content[0].text, /scopes|Invalid arguments|Input validation/i);

  // Control: the SAME query with a valid scope is accepted (proves the failure
  // above is the scopes contract, not an unrelated error).
  const ok = await client.callTool({ name: "search_memory", arguments: { query: "anything" } });
  assert.notEqual(ok.isError, true, "a scoped search_memory call succeeds");
});

test("A6 hard-cut: a LEGACY FLAT save_to_dataset call is rejected (no nested `write`)", async () => {
  const res = await client.callTool({
    name: "save_to_dataset",
    arguments: { dataset: "knowledge", name: "flat.md", text: "# flat\n\nbody" },
  });
  assert.equal(res.isError, true, "flat payload rejected by the strict nested schema");
});

test("G1: a write with NO `target` is rejected at the wire; the same write with `target:'brain'` succeeds", async () => {
  // Raw handle so neither scopeClient nor brainTargetClient backfills anything —
  // scopes are supplied so the ONLY missing field is the now-required `target`.
  const base = {
    scopes: [dataDir],
    write: {
      dataset: "knowledge",
      name: "needs-target.md",
      text: "# needs target\n\nbody long enough to pass validation",
      metadata: { atom_type: "reference", project_module: "testproj" },
    },
  };
  const missing = await callToolRaw({ name: "save_to_dataset", arguments: base });
  assert.equal(
    missing.isError,
    true,
    "an omitted target is rejected by the required-target schema",
  );
  assert.match(missing.content[0].text, /target|Invalid arguments|Input validation/i);
  const ok = parse(
    await callToolRaw({ name: "save_to_dataset", arguments: { ...base, target: "brain" } }),
  );
  assert.equal(ok.ok, true, "the same write with an explicit brain target is accepted");
});

test("G1: a MUTATE with NO `target` is rejected at the wire (same required-target contract)", async () => {
  // Raw handle so brainTargetClient doesn't backfill target; scopes supplied so
  // the ONLY missing field is the now-required `target`.
  const res = await callToolRaw({
    name: "disable_document",
    arguments: { scopes: [dataDir], select: { dataset: "knowledge", documentId: "k/whatever.md" } },
  });
  assert.equal(
    res.isError,
    true,
    "an omitted target on a mutate is rejected by the required schema",
  );
  assert.match(res.content[0].text, /target|Invalid arguments|Input validation/i);
});

test("A6 strict wire: an unknown TOP-LEVEL key (typo'd target) is rejected, never dropped to brain", async () => {
  // Raw client so brainTargetClient can't backfill `target`; supply a VALID
  // target so the ONLY problem is the unknown key. A non-strict schema would
  // DROP `targett` and write to the brain (isError:false) — that must not happen.
  const res = await callToolRaw({
    name: "save_to_dataset",
    arguments: {
      scopes: [dataDir],
      target: "brain",
      write: { dataset: "knowledge", name: "typo-top.md", text: "# x\n\nbody" },
      targett: "/somewhere",
    },
  });
  assert.equal(res.isError, true, "a typo'd top-level key is rejected by the strict object");
});

test("A6 strict wire: an unknown NESTED key (write.typo) is rejected", async () => {
  const res = await client.callTool({
    name: "save_to_dataset",
    arguments: {
      write: { dataset: "knowledge", name: "typo-nested.md", text: "# x\n\nbody", typo: 1 },
    },
  });
  assert.equal(res.isError, true, "a typo'd nested key is rejected by the strict sub-object");
});

test("A6 nested wire: a valid nested save_to_dataset + nested mutate round-trips", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "a6-nested-ok.md",
          text: "# nested\n\nA valid nested write over the A6 wire.",
          metadata: { atom_type: "reference", project_module: "testproj" },
        },
      },
    }),
  );
  assert.equal(saved.ok, true, "valid nested write accepted");
  const id = saved.created.document.id;
  const disabled = parse(
    await client.callTool({
      name: "disable_document",
      arguments: { select: { dataset: "knowledge", documentId: id } },
    }),
  );
  assert.equal(disabled.ok, true, "valid nested mutate (select) accepted");
});

test("A6 nested wire: save_to_dataset accepts the layout `subject` placement facet", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "a6-subject.md",
          text: "# subject\n\nA nested write carrying the subject placement facet.",
          metadata: {
            atom_type: "reference",
            area: "observability",
            subject: ["observability", "kamon"],
          },
        },
      },
    }),
  );
  assert.equal(saved.ok, true, "subject-carrying metadata is admitted by the strict schema");
});

test("A6 nested wire: write_memory supersede round-trips through the nested `write`", async () => {
  const first = parse(
    await client.callTool({
      name: "write_memory",
      arguments: {
        write: {
          datasetId: "knowledge",
          name: "a6-super-old.md",
          text: "# old\n\nThis leaf is superseded by the next nested write.",
          metadata: { atom_type: "reference", project_module: "testproj" },
        },
      },
    }),
  );
  assert.ok(first.created, "first leaf created via nested write_memory");
  const superseded = parse(
    await client.callTool({
      name: "write_memory",
      arguments: {
        write: {
          datasetId: "knowledge",
          name: "a6-super-new.md",
          text: "# new\n\nSupersedes the old leaf via the nested wire (supersedes/supersedesAction).",
          supersedes: first.created.document.id,
          supersedesAction: "disable",
          metadata: { atom_type: "reference", project_module: "testproj" },
        },
      },
    }),
  );
  assert.ok(
    superseded.created,
    "superseding leaf created; supersedes/supersedesAction reached the impl",
  );
});

test("A6 nested wire: enable_document + delete_document accept the nested `select`", async () => {
  const saved = parse(
    await client.callTool({
      name: "save_to_dataset",
      arguments: {
        write: {
          dataset: "knowledge",
          name: "a6-lifecycle.md",
          text: "# life\n\nNested-select lifecycle probe for enable + delete.",
          metadata: { atom_type: "reference", project_module: "testproj" },
        },
      },
    }),
  );
  const id = saved.created.document.id;
  const dis = parse(
    await client.callTool({
      name: "disable_document",
      arguments: { select: { dataset: "knowledge", documentId: id } },
    }),
  );
  assert.equal(dis.ok, true, "disable via nested select");
  const en = parse(
    await client.callTool({
      name: "enable_document",
      arguments: { select: { dataset: "knowledge", documentId: id } },
    }),
  );
  assert.equal(en.ok, true, "enable via nested select");
  const del = parse(
    await client.callTool({
      name: "delete_document",
      arguments: { select: { dataset: "knowledge", documentId: id } },
    }),
  );
  assert.equal(del.ok, true, "delete via nested select");
});

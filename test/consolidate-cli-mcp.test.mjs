import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setupWorkspace, cleanup, SRC, runScript, scopeClient } from "./harness.mjs";

const CLI = path.join(SRC, "scripts", "cli.mjs");
const BOOTSTRAP = path.join(SRC, "bootstrap.sh");

function freshDataDir(label) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lwm-${label}-`));
  // Pin lexical embed via settings.yaml — env vars no longer drive it. Enable
  // consolidation (product default is opt-in/off) so these CLI/MCP tests run it.
  fs.mkdirSync(path.join(d, "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(d, "settings", "settings.yaml"),
    "embed:\n  backend: lexical\nconsolidate:\n  enabled: true\n",
  );
  return d;
}

function runConsolidateCli(args, dataDir) {
  return spawnSync(process.execPath, [CLI, "consolidate", ...args], {
    cwd: SRC,
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_DATA_DIR: dataDir,
      MEMORY_LLM_PROVIDER: "mock",
      MEMORY_LLM_MOCK_RESPONSE: '{"ok":true}',
      LLM_WIKI_NO_PROMPT: "1",
    },
  });
}

function ensureWikiInit(dataDir) {
  const r = spawnSync(process.execPath, [CLI, "init"], {
    cwd: SRC,
    encoding: "utf8",
    env: {
      ...process.env,
      MEMORY_DATA_DIR: dataDir,
      LLM_WIKI_NO_PROMPT: "1",
    },
  });
  if (r.status !== 0) {
    throw new Error(`wiki init failed: ${r.stderr || r.stdout}`);
  }
}

test("CLI: consolidate --dry-run --json --no-llm exits 0 with ok+dryRun in JSON", () => {
  const dataDir = freshDataDir("consolidate-cli-dry");
  try {
    ensureWikiInit(dataDir);
    const r = runConsolidateCli(["--dry-run", "--json", "--no-llm"], dataDir);
    assert.equal(r.status, 0, `cli exited non-zero; stderr=${r.stderr}; stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true, "result.ok === true");
    assert.equal(parsed.dryRun, true, "result.dryRun === true");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CLI: --passes=dedupe-by-sha256 succeeds (single known pass)", () => {
  const dataDir = freshDataDir("consolidate-cli-known");
  try {
    ensureWikiInit(dataDir);
    const r = runConsolidateCli(
      ["--dry-run", "--json", "--no-llm", "--passes=dedupe-by-sha256"],
      dataDir,
    );
    assert.equal(r.status, 0, `cli exited non-zero; stderr=${r.stderr}; stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.dryRun, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CLI: --passes=unknown_pass still succeeds (unknown name → no passes run, but ok)", () => {
  const dataDir = freshDataDir("consolidate-cli-unknown");
  try {
    ensureWikiInit(dataDir);
    const r = runConsolidateCli(
      ["--dry-run", "--json", "--no-llm", "--passes=unknown_pass"],
      dataDir,
    );
    assert.equal(r.status, 0, `cli exited non-zero; stderr=${r.stderr}; stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, true, "unknown pass name does not cause a failure");
    assert.equal(parsed.dryRun, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("CLI: --target=<shared> is refused with the brain-only deferral error", () => {
  const dataDir = freshDataDir("consolidate-cli-target");
  try {
    ensureWikiInit(dataDir);
    const r = runConsolidateCli(["--json", "--no-llm", "--target=/not/the/brain"], dataDir);
    assert.equal(r.status, 0, `cli exited non-zero; stderr=${r.stderr}; stdout=${r.stdout}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false, "a shared target is refused");
    assert.equal(parsed.error, "shared-target-consolidate-unsupported");
    assert.match(parsed.message, /brain-only/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

const { dataDir: mcpDataDir } = setupWorkspace();
let client;
let transport;

before(async () => {
  client = new Client({ name: "lwm-consolidate-test", version: "0.0.0" }, { capabilities: {} });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(SRC, "mcp-server/index.mjs")],
    env: { ...process.env },
    cwd: SRC,
  });
  await client.connect(transport);
  scopeClient(client, [mcpDataDir]);
});

after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  cleanup(mcpDataDir);
});

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test("MCP: consolidate_memory is registered as a tool", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("consolidate_memory"), "consolidate_memory tool registered");
});

test("MCP: consolidate_memory call succeeds WITHOUT userRequested (not write-gated)", async () => {
  const res = parse(
    await client.callTool({
      name: "consolidate_memory",
      arguments: { dryRun: true, llm: false },
    }),
  );
  assert.equal(res.ok, true, `consolidate_memory ok; raw=${JSON.stringify(res)}`);
  assert.equal(res.dryRun, true, "MCP dry-run flag honoured");
});

test("MCP: consolidate_memory with a shared/non-brain target is refused (deferred to v1.1)", async () => {
  const res = parse(
    await client.callTool({
      name: "consolidate_memory",
      arguments: { dryRun: true, llm: false, target: "/not/the/brain" },
    }),
  );
  assert.equal(res.ok, false, `shared target refused; raw=${JSON.stringify(res)}`);
  assert.equal(res.error, "shared-target-consolidate-unsupported");
  assert.match(res.message, /brain-only/);
});

test("bootstrap.sh schedule_job invokes the cron-job CLI subcommand", () => {
  const raw = fs.readFileSync(BOOTSTRAP, "utf8");
  const startIdx = raw.indexOf("schedule_job()");
  assert.ok(startIdx >= 0, "schedule_job function present in bootstrap.sh");
  // Slice exactly to the function's closing brace so a later top-level
  // addition (e.g. a /bin/sh call after schedule_job) cannot false-fail
  // the doesNotMatch below.
  const endIdx = raw.indexOf("\n}", startIdx);
  assert.ok(endIdx > startIdx, "schedule_job closing brace found");
  const body = raw.slice(startIdx, endIdx + 2);
  // The cron-job subcommand chains compile + consolidate --if-due internally
  // (see scripts/cron-job.mjs) and writes the attempt log. It is invoked from
  // the crontab wrapper (`exec "$node_bin" ".../cli.mjs" cron-job` — absolute
  // node: cron's minimal PATH may not resolve a bare `node` under nvm) AND,
  // on macOS, as a launchd ProgramArguments element (<string>cron-job</string>).
  assert.match(
    body,
    /exec "\$node_bin" "\$SRC_DIR\/scripts\/cli\.mjs" cron-job/,
    "wrapper invokes cron-job via the absolute node",
  );
  assert.match(body, /<string>cron-job<\/string>/, "launchd ProgramArguments invokes cron-job");
  // The launchd job must NOT route through `/bin/sh -c "<string>"` — that
  // mis-parses an install path containing a literal double-quote. It passes
  // node + the cli path as discrete ProgramArguments elements instead.
  assert.doesNotMatch(
    body,
    /<string>\/bin\/sh<\/string>/,
    "no /bin/sh -c indirection in the plist",
  );
});

test("bootstrap.sh crontab idempotency filter is prefix-collision-safe (awk suffix match, not grep -vF)", () => {
  const raw = fs.readFileSync(BOOTSTRAP, "utf8");
  const startIdx = raw.indexOf("schedule_job()");
  const body = raw.slice(startIdx, startIdx + 6000);
  // Guard against a regression to `grep -vF "$tag"`, whose unanchored substring
  // match wipes a sibling workspace whose path is a prefix of this one.
  assert.doesNotMatch(
    body,
    /crontab -l[^\n]*grep -vF "\$tag"/,
    "must NOT use unanchored grep -vF on the tag",
  );
  assert.match(
    body,
    /awk -v t="\$tag"[^\n]*substr\(\$0[^\n]*length\(t\)/,
    "uses an awk suffix-match filter keyed on the tag",
  );

  // Execute the EXACT awk expression bootstrap uses and prove it drops only the
  // exact-suffix line, keeping a prefix-sibling and unrelated lines.
  const exprMatch = body.match(/awk -v t="\$tag" '([^']*)'/);
  assert.ok(exprMatch, "extracted the awk program text");
  const awkProg = exprMatch[1];
  const tag = "# llm-wiki-memory:/a/proj";
  const input =
    [
      `0 * * * * "/a/proj/.llm/state/cron-daily.sh" ${tag}`,
      `0 * * * * "/a/proj2/.llm/state/cron-daily.sh" # llm-wiki-memory:/a/proj2`,
      "0 2 * * * /usr/bin/backup  # unrelated",
    ].join("\n") + "\n";
  const r = spawnSync("awk", ["-v", `t=${tag}`, awkProg], { input, encoding: "utf8" });
  assert.equal(r.status, 0, `awk ran; stderr=${r.stderr}`);
  const kept = r.stdout.trimEnd().split("\n");
  assert.ok(
    kept.some((l) => l.includes("/a/proj2")),
    "sibling prefix workspace line is KEPT",
  );
  assert.ok(
    kept.some((l) => l.includes("/usr/bin/backup")),
    "unrelated cron line is KEPT",
  );
  assert.ok(!kept.some((l) => l.endsWith(tag)), "this workspace's exact line is dropped");
});

test("bootstrap.sh installs cron at hourly cadence (0 * * * *)", () => {
  const raw = fs.readFileSync(BOOTSTRAP, "utf8");
  // The Linux cron line is interpolated with $wrapper / $tag, so we match
  // the literal "0 * * * *" prefix.
  assert.match(raw, /local line="0 \* \* \* \*/, "cron entry uses hourly cadence (0 * * * *)");
});

test("consolidate CLI: bare value-taking flags and invalid values abort loudly (exit 2)", () => {
  const bare = runScript("scripts/cli.mjs", [
    "consolidate",
    "--dry-run",
    "--cosine-threshold",
    "0.9",
  ]);
  assert.equal(bare.status, 2, "bare --cosine-threshold must not silently run at defaults");
  assert.match(bare.stderr, /requires the equals form/);

  const garbage = runScript("scripts/cli.mjs", [
    "consolidate",
    "--dry-run",
    "--cosine-threshold=abc",
  ]);
  assert.equal(garbage.status, 2, "invalid value must not silently run at defaults");
  assert.match(garbage.stderr, /invalid --cosine-threshold value/);
});

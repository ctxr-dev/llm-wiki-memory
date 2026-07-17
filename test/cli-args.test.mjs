import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFirstArg, formatHelp, docsUrl, REPO_RAW_BASE } from "../scripts/lib/cli-args.mjs";

test("classifyFirstArg: --help / -h → help", () => {
  assert.equal(classifyFirstArg("--help"), "help");
  assert.equal(classifyFirstArg("-h"), "help");
});

test("classifyFirstArg: any OTHER leading-dash arg → bad-flag (never treated as a path)", () => {
  assert.equal(classifyFirstArg("--bogus"), "bad-flag");
  assert.equal(classifyFirstArg("-x"), "bad-flag");
  assert.equal(classifyFirstArg("--dry-run"), "bad-flag");
});

test("classifyFirstArg: a real path / value / absent → null (proceed normally)", () => {
  assert.equal(classifyFirstArg("/repo/dir"), null);
  assert.equal(classifyFirstArg("mock"), null);
  assert.equal(classifyFirstArg(""), null);
  assert.equal(classifyFirstArg(undefined), null);
});

test("formatHelp: a real help block — summary, usage, docs pointer, AND a cross-OS install note", () => {
  const h = formatHelp({
    name: "x",
    summary: "does the x thing",
    usage: "x <a>",
    docs: docsUrl("docs/x.md"),
  });
  assert.match(h, /^x — does the x thing/m);
  assert.match(h, /^Usage: x <a>$/m);
  assert.match(h, /^Docs: .+docs\/x\.md$/m, "help always points at where to read more");
  assert.ok(h.endsWith("\n"));
});

test("formatHelp: names the install location on BOTH macOS/Linux and Windows (never a bare ~/ that Windows can't resolve)", () => {
  const h = formatHelp({ name: "x", summary: "s", usage: "u" });
  assert.match(h, /~\/\.llm-wiki-memory\/src/, "POSIX home path shown");
  assert.match(h, /%USERPROFILE%\\\.llm-wiki-memory\\src/, "Windows home path shown");
});

test("docsUrl: a raw-GitHub URL (WebFetch-able on any OS, not a local path)", () => {
  const u = docsUrl("AI-INSTALL-PROMPT.md");
  assert.equal(u, `${REPO_RAW_BASE}/AI-INSTALL-PROMPT.md`);
  assert.match(u, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.doesNotMatch(u, /^~|%USERPROFILE%/, "never a machine-local home path");
});

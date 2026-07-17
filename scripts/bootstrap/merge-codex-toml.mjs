#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomic } from "../lib/atomic-write.mjs";
import { SERVER_NAME, SERVER_INDEX_REL, codexTomlBlock } from "./mcp-clients.mjs";
import { helpGuard, refuseFlagAsPath, formatHelp, docsUrl } from "../lib/cli-args.mjs";

// Upsert our `[mcp_servers.<name>]` table into ~/.codex/config.toml, preserving
// every other table and a user-customized (mandated-wrapper) command. The block
// boundary mirrors uninstall's stripCodexServer so install/uninstall round-trip.

const HEADER = `[mcp_servers.${SERVER_NAME}]`;
const CHILD_PREFIX = `[mcp_servers.${SERVER_NAME}.`;

/**
 * @param {string[]} lines
 * @returns {{ start: number, end: number } | null}
 */
function findBlock(lines) {
  const start = lines.findIndex((l) => l.trim() === HEADER);
  if (start === -1) return null;
  let end = start + 1;
  for (; end < lines.length; end += 1) {
    const t = lines[end].trim();
    if (/^\[/.test(t) && !t.startsWith(CHILD_PREFIX)) break;
  }
  return { start, end };
}

/**
 * @param {string[]} blockLines
 * @returns {boolean}
 */
function commandIsCustomized(blockLines) {
  const cmd = blockLines.find((l) => /^\s*command\s*=/.test(l));
  return !!cmd && !/^\s*command\s*=\s*"node"\s*$/.test(cmd);
}

/**
 * @param {string} file
 * @param {string} [indexArg]
 * @returns {{ action: string, changed: boolean }}
 */
export function mergeCodexToml(file, indexArg = SERVER_INDEX_REL) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== "ENOENT") throw err;
  }
  const lines = raw === "" ? [] : raw.split("\n");
  const found = findBlock(lines);
  if (found && commandIsCustomized(lines.slice(found.start, found.end))) {
    return { action: "preserved-customized", changed: false };
  }
  const block = codexTomlBlock(indexArg);
  const kept = found ? [...lines.slice(0, found.start), ...lines.slice(found.end)] : lines;
  const body = kept.join("\n").replace(/\n*$/, "");
  const next = body === "" ? block : `${body}\n\n${block}`;
  if (next === raw) return { action: "unchanged", changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, next);
  return { action: found ? "replaced" : raw === "" ? "created" : "appended", changed: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = process.argv.slice(2);
  const HELP = formatHelp({
    name: "merge-codex-toml",
    summary:
      "merge the llm-wiki-memory server into a Codex config.toml (idempotent, preserves a wrapped command)",
    usage: "node scripts/bootstrap/merge-codex-toml.mjs <configFile> <indexArg>",
    docs: docsUrl("AI-INSTALL-PROMPT.md"),
  });
  helpGuard(args, HELP);
  refuseFlagAsPath(args[0], HELP);
  const [file, indexArg] = process.argv.slice(2);
  if (!file) {
    console.error("usage: merge-codex-toml.mjs <config.toml> [indexArg]");
    process.exit(1);
  }
  const r = mergeCodexToml(file, indexArg);
  console.error(`codex mcp: ${r.action} ${file}`);
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { envValue } from "../scripts/lib/env.mjs";
import { INSTRUCTIONS } from "../scripts/lib/discipline.mjs";
import { loadImpl, watchForReload } from "./mcp-reload.mjs";
import { registerConfigTools } from "./tools-config.mjs";
import { registerSearchTools } from "./tools-search.mjs";
import { registerWriteTools } from "./tools-write.mjs";
import { registerDocumentTools } from "./tools-documents.mjs";
import { registerMaintenanceTools } from "./tools-maintenance.mjs";

async function main() {
  // Fold wiki-store.mjs + recall.mjs into the reloadable `impl` before the first
  // tool call. Registration below never touches impl (handlers read it lazily via
  // getImpl at call time), but a broken module must surface here at startup.
  await loadImpl();

  const server = new McpServer(
    {
      name: envValue("MEMORY_MCP_SERVER_NAME") || "llm-wiki-memory",
      version: "0.1.0",
    },
    // `instructions` is returned on initialize, so every MCP client receives the
    // memory discipline on connect (the cross-client carrier hooks cannot provide).
    { instructions: INSTRUCTIONS, capabilities: {} },
  );

  registerConfigTools(server);
  registerSearchTools(server);
  registerWriteTools(server);
  registerDocumentTools(server);
  registerMaintenanceTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Module-level binding keeps the FSWatcher handles reachable for the process
  // lifetime (an unreferenced watcher can be GC'd, stopping hot reload).
  const activeWatchers = watchForReload();
  void activeWatchers;
}

// Run main() only when invoked as a script (the `mcp` npm script / a test that
// spawns this file), not when imported for its exports. Mirrors the hardened
// isMainModule idiom in scripts/compile.mjs:
//   - `!process.argv[1]` guards REPL / piped stdin where argv[1] is undefined.
//   - `path.resolve(process.argv[1])` normalises a relative argv[1] to an
//     absolute path before comparison with the absolute `import.meta.url`.
//   - try/catch fails closed (no main()) on an exotic argv[1] shape.
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  await main();
}

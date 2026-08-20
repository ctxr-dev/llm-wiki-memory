import { refuseBelowNodeFloor } from "../scripts/lib/node-floor.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { envValue } from "../scripts/lib/env.mjs";
import { INSTRUCTIONS } from "../scripts/lib/discipline.mjs";
import { loadImpl, watchForReload } from "./mcp-reload.mjs";
import { registerConfigTools } from "./tools-config.mjs";
import { registerSearchTools } from "./tools-search.mjs";
import { registerWriteTools } from "./tools-write.mjs";
import { registerDocumentTools } from "./tools-documents.mjs";
import { registerMaintenanceTools } from "./tools-maintenance.mjs";
import { installFatalGuard } from "../scripts/lib/fatal-guard.mjs";

refuseBelowNodeFloor();

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

// Run main() only when invoked as a script — the `mcp` npm script, or a test that spawns this
// file (every test does spawn it; this module has no exports). The guard is what keeps a plain
// import inert, which is what makes the server safe to reference from a test at all.
if (import.meta.main) {
  // Before main(), so a rejection during startup is reported rather than being a bare stack
  // on a stream the client is not reading.
  installFatalGuard("mcp-server");
  await main();
}

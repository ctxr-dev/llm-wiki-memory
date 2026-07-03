// System-maintenance tag for the L3 write-gate (memory-write hardening).
//
// The L3 server-side guard refuses `save_lesson` / `save_to_dataset(dataset=
// "self_improvement", ...)` calls that lack `userRequested:true` — to enforce
// the propose-then-confirm rule. But the wiki ALSO has a legitimate internal
// writer (the consolidate orchestrator) that needs to mutate leaves without
// being user-initiated. We exempt it via this tag.
//
// AsyncLocalStorage is the right primitive: an env-var or process-global flag
// (a) would NOT propagate cleanly through async/await chains, (b) would race
// across concurrent maintenance windows, and (c) could be set by anything
// running in the same process. ALS scopes the flag to one async frame and its
// descendants — so the orchestrator's body sees it but the MCP tool handler
// (which runs in its OWN frame dispatched from the JSON-RPC layer) does NOT,
// unless that handler was itself invoked from inside the orchestrator's frame.
//
// Crucially: the model has NO way to enter this frame from outside the
// orchestrator process. Every tool call from a client arrives via the MCP
// stdio transport in a fresh async frame; if it tries to pass `_systemMaintenance:
// true` in the args, the gate handler ignores the arg entirely (the flag lives
// in the runtime store, not in the request body).

import { AsyncLocalStorage } from "node:async_hooks";

const STORE = new AsyncLocalStorage();

// Run `fn` (sync or async) with the system-maintenance flag set. Every write
// performed transitively inside `fn` will observe `isSystemMaintenance() ===
// true` via `getMaintenanceContext()`. Returns whatever `fn` returns. Errors
// propagate.
export function withSystemMaintenance(fn) {
  return STORE.run({ maintenance: true }, fn);
}

// True iff the current async frame is nested inside a `withSystemMaintenance`
// call. The L3 gate allow-lists writes when this returns true.
export function isSystemMaintenance() {
  const ctx = STORE.getStore();
  return Boolean(ctx && ctx.maintenance === true);
}

// Returns the current maintenance context (or undefined). Reserved for future
// reasons-tagging (e.g. attaching `_maintenanceReason: "consolidate-3A"` so
// logs can attribute internal writes to a specific pass).
export function getMaintenanceContext() {
  return STORE.getStore();
}

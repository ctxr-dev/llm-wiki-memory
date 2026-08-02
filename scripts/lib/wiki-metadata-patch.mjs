import { normalisePriority } from "./datasets.mjs";
import { normaliseMeta, preserveIdentityOnResave } from "./wiki-identity.mjs";

/** @typedef {import("./types.mjs").MetadataInput} MetadataInput */
/** @typedef {import("./types.mjs").MemoryMetadata} MemoryMetadata */

// Pure merge semantics for a metadata patch onto a leaf's existing `memory`
// block. Extracted from updateDocMetadata so the same merge (and its three
// clobber guards) can be reasoned about and tested without touching the
// filesystem, the index, or git.
//
// No lock: this is one half of a read-modify-write that every write door in the
// engine performs unlocked. Concurrent patches are last-writer-wins on whole
// fields (writeFileAtomic rules out a torn file); a stale lock blocking a tool
// call is worse than a lost facet key, and the stdio MCP transport serialises
// requests per client anyway.

/**
 * Status is owned by disableDocument/enableDocument, which also carry its cache
 * side effects. A metadata patch that tried to CHANGE it used to be silently
 * dropped by `normaliseMeta(..., { status: existingMem.status })`. Refuse loudly
 * instead — but only when the requested value DIVERGES: a maintenance re-stamp
 * (migrate-identity) legitimately echoes the leaf's own status back.
 * @param {MetadataInput} metadata
 * @param {string} current
 * @returns {string | null}
 */
function divergentStatus(metadata, current) {
  const raw = /** @type {Record<string, unknown>} */ (metadata).status;
  const wanted = typeof raw === "string" ? raw.trim() : "";
  if (!wanted || wanted === current) return null;
  return wanted;
}

/**
 * @param {MemoryMetadata | Record<string, unknown>} existingMem
 * @param {MetadataInput} metadata
 * @returns {{ ok: true, merged: Record<string, unknown> } | { ok: false, reason: string, field: string, allowed: string[] }}
 */
export function mergeLeafMetadata(existingMem, metadata) {
  const currentStatus = String(existingMem.status || "active");
  const wanted = divergentStatus(metadata, currentStatus);
  if (wanted) {
    return {
      ok: false,
      field: "status",
      allowed: ["disable_document", "enable_document"],
      reason: `status is not patchable via metadata (leaf is "${currentStatus}", requested "${wanted}"); use disable_document / enable_document, which also update the embedding cache`,
    };
  }
  const incoming = normaliseMeta(preserveIdentityOnResave(metadata, existingMem), {
    status: currentStatus,
  });
  // normaliseMeta always emits atom_type (never stripped); on a PARTIAL update
  // that omits it, that empty string would clobber the leaf's existing
  // atom_type. Drop it so a partial merge keeps the current value. project_module
  // is the OTHER always-emitted field: preserveIdentityOnResave re-supplies the
  // leaf's existing identity as the override above so a re-stamp cannot rewrite a
  // cross-project leaf to defaultProjectModule().
  if (!incoming.atom_type) delete (/** @type {Partial<MemoryMetadata>} */ (incoming).atom_type);
  // priority is the THIRD always-emitted field: normaliseMeta fills the rubric
  // default by atom_type and never strips it, so a partial update that omits
  // priority recomputes it against the guard-dropped (empty) atom_type ->
  // DEFAULT_PRIORITY and would clobber the leaf's existing apply-strength (a
  // P0/P1 leaf silently downgraded to P2 on every consolidate stamp). Drop it
  // unless the caller EXPLICITLY sets a VALID priority, so the merge keeps the
  // current value (backfill-priority, which does pass priority, still updates it).
  // An INVALID priority string counts as "not set" so it preserves the existing
  // value rather than clobbering to DEFAULT_PRIORITY via the empty-atom_type rubric.
  const callerSetsPriority = Boolean(
    metadata &&
    typeof metadata === "object" &&
    normalisePriority(/** @type {Record<string, unknown>} */ (metadata).priority),
  );
  if (!callerSetsPriority) delete (/** @type {Partial<MemoryMetadata>} */ (incoming).priority);
  return { ok: true, merged: { ...existingMem, ...incoming } };
}

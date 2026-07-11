import fs from "node:fs";
import path from "node:path";
import { wikiRoot } from "../lib/env.mjs";
import { flushSlotName } from "../lib/settings.mjs";
import { writeMemory, WikiStoreUnavailable } from "../lib/wiki-store.mjs";

/** @typedef {import("../lib/types.mjs").WriteResult} WriteResult */

export function flushDatasetName() {
  return flushSlotName();
}

// The wiki's equivalent of a bound destination: the hosted wiki must have been
// materialised (its layout contract exists). Unlike the RAG backend there is no
// per-slot binding; the slot is a category directory that writeMemory creates
// on demand. If the wiki is not initialised there is nowhere to write at all,
// not even a fallback record.
export function wikiInitialised() {
  return fs.existsSync(path.join(wikiRoot(), ".layout", "layout.yaml"));
}

// Write a flush doc to the configured slot. A rejected slot (e.g. a misconfigured
// MEMORY_FLUSH_SLOT) is recoverable: the only valid flush destination is the
// daily category, so retry there once. Returns { result, datasetName, rejected? };
// throws the final error if even the daily fallback fails.
/**
 * @param {string} name
 * @param {string} text
 * @param {number} [capturedAt]
 * @returns {Promise<{ result: WriteResult, datasetName: string, rejected?: string }>}
 */
export async function writeFlushDoc(name, text, capturedAt) {
  const datasetName = flushDatasetName();
  // Pin daily date-nesting to capture time so a worker that crosses midnight UTC
  // still nests under the captured day (matching captured_at_utc in the header).
  const date = capturedAt ? new Date(capturedAt) : undefined;
  try {
    return {
      result: /** @type {WriteResult} */ (
        await writeMemory({ name, text, datasetId: datasetName, date })
      ),
      datasetName,
    };
  } catch (err) {
    if (err instanceof WikiStoreUnavailable && datasetName !== "daily") {
      const result = /** @type {WriteResult} */ (
        await writeMemory({ name, text, datasetId: "daily", date })
      );
      return { result, datasetName: "daily", rejected: datasetName };
    }
    throw err;
  }
}

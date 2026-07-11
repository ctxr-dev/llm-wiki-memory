import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { saveDocument, WikiStoreUnavailable } from "../lib/wiki-store.mjs";
import { syncPlanFile } from "../lib/plan-sync.mjs";
import { wikiRoot } from "../lib/env.mjs";
import { withBrainContextSafe } from "../lib/wiki-context.mjs";
import { hookExitPlanModeDisable, hookExitPlanModeMaxBytes } from "../lib/settings.mjs";
import {
  DEFAULT_MAX_PLAN_BYTES,
  extractTitle,
  fencePlanBody,
  planDocSpec,
  resolvePlanBody,
} from "./exit-plan-mode-spec.mjs";

// Pure plan-body resolution + doc-spec building live in ./exit-plan-mode-spec.mjs.
// Re-exported here so the module's public surface is unchanged for importers/tests.
export { extractTitle, fencePlanBody, resolvePlanBody, planDocSpec };

/** @typedef {import("./exit-plan-mode-spec.mjs").HookInput} HookInput */

/**
 * saveDocument's return, widened with the extra optional fields this hook
 * reads defensively (delete/metadata-warning surfaces the wiki-store may add).
 * @typedef {import("../lib/types.mjs").WriteResult & { deleteError?: string, metadataResult?: { ok: boolean, warning?: string } }} PlanSaveResult
 */

// Class signal for "skip cleanly without writing"; mirrors the
// SkipMemory pattern in flush.mjs so the two hooks centralise their
// always-exit-0 contract in the same idiom.
class SkipPlanCapture extends Error {}

function readStdin() {
  // TTY short-circuit so manual debug runs are non-blocking
  // (readFileSync(0) blocks on Ctrl-D otherwise).
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  // Kill switch: users who don't want auto-capture can set
  // MEMORY_HOOK_EXITPLANMODE_DISABLE=true in ./.memory/settings/.env.
  if (hookExitPlanModeDisable()) {
    throw new SkipPlanCapture("disabled via settings.hook.exitPlanModeDisable=true");
  }

  const maxBytes = hookExitPlanModeMaxBytes() || DEFAULT_MAX_PLAN_BYTES;
  const hookInput = /** @type {HookInput} */ (parseJsonMaybe(readStdin()) || {});
  const spec = planDocSpec(hookInput, { maxBytes });
  if (spec.skip) throw new SkipPlanCapture(spec.skip);

  // Refuse cleanly if the wiki hasn't been materialised yet.
  const wiki = wikiRoot();
  if (!fs.existsSync(path.join(wiki, ".layout", "layout.yaml"))) {
    throw new SkipPlanCapture(
      `wiki not initialised at ${wiki}; run ./.llm-wiki-memory/src/bootstrap.sh`,
    );
  }

  try {
    const result = /** @type {PlanSaveResult} */ (
      await saveDocument({
        name: spec.name,
        text: spec.text,
        datasetId: spec.datasetSlot,
        metadata: spec.metadata,
      })
    );
    /** @type {string[]} */
    const notes = [];
    if (result?.metadataError) notes.push(`metadata error: ${result.metadataError}`);
    // metadataResult.warning fires when the dataset has no matching
    // per-doc fields (for example: dataset created before the metadata-
    // schema auto-install existed, or a partial schema-install failure).
    // Surface it so the user knows the doc landed but is unfilterable.
    if (result?.metadataResult?.warning) {
      notes.push(`metadata warning: ${result.metadataResult.warning}`);
    }
    if (result?.deleteError) notes.push(`delete error: ${result.deleteError}`);

    // Seed the plans lifecycle: derive status/progress from the captured plan's
    // checkboxes so a fallback-captured custom plan follows the lifecycle from
    // the moment of capture. Safe: buildUpdatedFrontmatter spreads existing
    // keys (the wiki-store leaf frontmatter is preserved), and plan-frontmatter
    // now stringifies with lineWidth:-1 to match the leaf convention. A plans/
    // leaf is never moved (only issues-tree plans relocate by lifecycle).
    // Best-effort; capture already succeeded so this never fails the hook.
    let lifecycleStatus;
    try {
      const relId = result?.created?.document?.id;
      if (relId) {
        const leafAbs = path.join(wiki, String(relId).split("/").join(path.sep));
        const sync = await syncPlanFile(leafAbs, { wikiRoot: wiki });
        lifecycleStatus = sync?.status;
        if (sync?.error) notes.push(`lifecycle sync: ${sync.error}`);
      }
    } catch (e) {
      notes.push(`lifecycle sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const note = notes.length ? ` (${notes.join("; ")})` : "";
    console.error(
      `exit-plan-mode.mjs: wrote ${spec.name} to ${spec.datasetSlot}` +
        `${lifecycleStatus ? ` [status=${lifecycleStatus}]` : ""}${note}`,
    );
  } catch (err) {
    if (err instanceof WikiStoreUnavailable) {
      throw new SkipPlanCapture(`wiki store unavailable: ${err.message || err}`);
    }
    throw err;
  }
}

// CLI guard: importing the module (e.g. from the test file) MUST NOT
// trigger stdin reads or bridge calls. pathToFileURL handles Windows
// drive letters / UNC paths / percent-encoding correctly.
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    // path.resolve normalises a relative argv[1] (`node scripts/hooks/
    // exit-plan-mode.mjs`) to an absolute path before comparison, so the
    // guard matches the absolute import.meta.url regardless of how the
    // launcher passed the path. Same pattern as scripts/compile.mjs.
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  try {
    // Scope the plan-capture write to the brain wiki. Behavior-neutral in the
    // single-tree case; a resolve failure falls through so main()'s own
    // "wiki not initialised" skip still fires and the hook stays exit-0.
    await withBrainContextSafe(() => main());
  } catch (err) {
    if (err instanceof SkipPlanCapture) {
      console.error(`exit-plan-mode.mjs: skipped (${err.message})`);
      process.exit(0);
    }
    console.error(
      `exit-plan-mode.mjs: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Hooks must NEVER block the agent. Exit 0 even on unexpected
    // errors; the stderr message is the breadcrumb for diagnosis.
    process.exit(0);
  }
}

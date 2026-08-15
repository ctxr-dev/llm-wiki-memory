import { useState } from "react";
import { api } from "./api";

/**
 * Shown when the cold-embed bound cut a search short: leaves with no cached vector were EXCLUDED
 * from the results rather than ranked low, so the list is incomplete and looks exactly like a
 * genuinely small one. Without this the app was the only surface where that stayed silent — the
 * CLI and MCP clients already get the same advisory in their response envelope.
 *
 * The action is not a new capability: this daemon already warms at boot and on a timer, and warms
 * are serialised by state/.embed-warm.lock, so the button starts the same operation the scheduler
 * would. It returns immediately (202); the notice clears on the next search.
 */

export type PartialResults = {
  skippedLeaves: number;
  embeddedTexts: number;
  remedy: string;
};

export function PartialResultsNotice({
  wikiId,
  partial,
}: {
  wikiId: string | null;
  partial?: PartialResults;
}) {
  const [state, setState] = useState<"idle" | "starting" | "started" | "failed">("idle");
  if (!partial || partial.skippedLeaves <= 0) return null;

  const leaves = partial.skippedLeaves;
  const start = async () => {
    if (!wikiId || state === "starting") return;
    setState("starting");
    try {
      const r = await api.warm(wikiId);
      /**
       * `started: false` means a warm is already running — for the user that is the same
       * outcome, so it is not reported as a failure.
       */
      setState(r.started || r.reason === "already-running" ? "started" : "failed");
    } catch {
      setState("failed");
    }
  };

  return (
    <li
      role="status"
      className="mb-1 flex items-center justify-between gap-2 rounded bg-amber-50 p-2 text-sm text-amber-800"
    >
      <span>
        Showing partial results: {leaves} {leaves === 1 ? "note has" : "notes have"} no embedding
        yet and {leaves === 1 ? "was" : "were"} left out.
      </span>
      {state === "started" ? (
        <span className="shrink-0 font-medium">Warming…</span>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={!wikiId || state === "starting"}
          className="shrink-0 cursor-pointer font-medium text-amber-800 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state === "failed" ? "Retry warm" : "Warm now"}
        </button>
      )}
    </li>
  );
}

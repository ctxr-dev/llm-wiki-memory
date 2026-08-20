/**
 * Starting a warm on demand, for the partial-results banner's "Warm now" affordance.
 *
 * Exposing this is not a new capability: this daemon already warms at boot (warmHomeWikiGradually)
 * and on a timer (startWarmTimer). It is the MCP SERVER that must never warm — N connected clients
 * would mean N concurrent warms, each competing with its own requests for the inference threads —
 * and this is one daemon, not N clients.
 *
 * Two guards, at different scopes:
 * - `inFlight` here stops a double-click starting two warms IN THIS PROCESS;
 * - state/.embed-warm.lock (embed-warm.mjs) is the cross-process backstop, so a warm already
 * running under the hourly cron is not duplicated either.
 *
 * The warm is deliberately NOT awaited. A cold corpus takes ~90s of duty-cycled slices, so awaiting
 * would hold the request open and hang the browser; the caller gets 202 and the banner clears on
 * the next search.
 */

let inFlight = false;

/**
 * @param {string} wikiRoot
 * @returns {{ started: boolean, reason?: string }}
 */
export function startWarm(wikiRoot) {
  if (inFlight) return { started: false, reason: "already-running" };
  inFlight = true;
  /**
   * Detached on purpose: see the header. Failures are reported to stderr, never to the caller,
   * because by then the response has gone.
   */
  void (async () => {
    try {
      const { warmWikiEmbeddings } = await import("../../../scripts/lib/embed-warm.mjs");
      const stats = await warmWikiEmbeddings(wikiRoot);
      if (stats.embedded > 0) {
        process.stderr.write(
          `webapp: warmed ${stats.embedded}/${stats.leaves} leaves across ${stats.categories} categories\n`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`webapp: on-demand warm failed (${message})\n`);
    } finally {
      inFlight = false;
    }
  })();
  return { started: true };
}

/** Test seam: the flag is module-level and would otherwise leak between cases. @returns {void} */
export function __resetWarmRunner() {
  inFlight = false;
}

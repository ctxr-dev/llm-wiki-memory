// Turns @huggingface/transformers' `progress_callback` stream into a few legible stderr lines, so
// a first-run model fetch (~219MB across 5 files) is distinguishable from a hung process.
//
// Three properties of the real stream shape this, all observed from an actual cold download rather
// than inferred from the type declarations:
//
//  1. DOUBLE DISPATCH. DefaultProgressCallback wraps a supplied callback and, per `progress` event,
//     invokes it twice — once as a synthesised `progress_total`, once with the raw event. Adding up
//     whatever arrives double-counts every byte. That wrapper is also only installed when an
//     earlier metadata fetch succeeded, so `progress_total` cannot be relied on to arrive at all.
//     Raw `progress` is the one event present on both paths, so this aggregates that and ignores
//     the synthesised one.
//  2. THE TOTAL GROWS. Files are discovered as loading proceeds (config, then tokenizer, then the
//     weights), so a percentage is NOT monotonic — a real run printed 96%, then 93%, then 20%.
//     Clamping it monotonic is no better: it would sit at 93% while 175MB downloaded. So no
//     percentage is reported. Bytes stay honest as the denominator grows, and are what the user
//     actually needs to tell progress from a hang.
//  3. `done` IS PER FILE. Treating the first one as completion announced "ready (1 MB)" after the
//     config file while 219MB was still to come. Completion is therefore derived from
//     loaded >= total, and only for a total LARGER than any already announced.
//  4. A CACHE HIT ALSO EMITS `progress`. There is no event that distinguishes a network fetch from
//     a local read: `download` is dispatched unconditionally, on both sides of the cacheHit branch,
//     and supplying a callback is itself what moves Node off its `arrayBuffer()` shortcut onto the
//     streaming read path — so an already-downloaded model reported a full fake download. Since no
//     event says which it is, DURATION does: nothing is written until the load has been running for
//     `quietMs`, which a local read finishes well inside and a ~219MB fetch does not.
//
// Writes to stderr because stdout is JSON-RPC on the MCP server and a typed envelope in every hook.

const MB = 1_000_000;
// Below this, a "download" is a config or index file — reporting it is pure noise, and it rounds
// to "0 MB" anyway.
const QUIET_UNDER_BYTES = 5 * MB;
// Report every this-many new bytes even inside the time throttle, so a fast link still shows motion.
const STEP_BYTES = 20 * MB;
// Say nothing until the load has run this long. This is what keeps an already-cached model silent:
// reading it from disk completes inside this window, a network fetch does not.
const QUIET_FOR_MS = 1500;

/** @param {number} bytes @returns {string} */
function mb(bytes) {
  return `${Math.round(bytes / MB)} MB`;
}

/**
 * @param {{ label?: string, write?: (s: string) => void, now?: () => number, minIntervalMs?: number, quietMs?: number }} [opts]
 * @returns {(info: unknown) => void}
 */
export function makeDownloadReporter({
  label = "embedding model",
  write = (s) => process.stderr.write(s),
  now = () => Date.now(),
  minIntervalMs = 1500,
  quietMs = QUIET_FOR_MS,
} = {}) {
  /** @type {Map<string, { loaded: number, total: number }>} */
  const files = new Map();
  let lastWriteAt = -Infinity;
  let lastReportedBytes = 0;
  let announcedMaxTotal = 0;
  let startedAt = -Infinity;
  let wroteProgress = false;

  /** @returns {{ loaded: number, total: number }} */
  function totals() {
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    return { loaded, total };
  }

  return function report(info) {
    if (!info || typeof info !== "object") return;
    const status = /** @type {{ status?: unknown }} */ (info).status;
    // Covers bytes the raw `progress` event below already reported.
    if (status === "progress_total" || status !== "progress") return;

    const { file, loaded, total } =
      /** @type {{ file?: unknown, loaded?: unknown, total?: unknown }} */ (info);
    if (typeof file !== "string" || typeof loaded !== "number") return;
    // `loaded` is cumulative per file, so this REPLACES rather than accumulates.
    files.set(file, { loaded, total: typeof total === "number" && total > 0 ? total : 0 });

    const { loaded: gotBytes, total: allBytes } = totals();
    if (allBytes < QUIET_UNDER_BYTES) return;
    if (startedAt === -Infinity) startedAt = now();
    // Still inside the quiet window: this may be a cache read, which must stay silent.
    if (now() - startedAt < quietMs) return;

    if (gotBytes >= allBytes) {
      // Only for a total LARGER than any already announced, so a small early file cannot claim
      // completion while the weights are still pending, and nothing is announced twice.
      if (wroteProgress && allBytes > announcedMaxTotal) {
        announcedMaxTotal = allBytes;
        write(`llm-wiki-memory: ${label} ready (${mb(allBytes)})\n`);
      }
      return;
    }

    const firstReport = lastWriteAt === -Infinity;
    const stepped = gotBytes - lastReportedBytes >= STEP_BYTES;
    if (!firstReport && !stepped && now() - lastWriteAt < minIntervalMs) return;
    lastWriteAt = now();
    lastReportedBytes = gotBytes;
    wroteProgress = true;
    write(
      `llm-wiki-memory: downloading ${label} — ${mb(gotBytes)} of ${mb(allBytes)} (one time)\n`,
    );
  };
}

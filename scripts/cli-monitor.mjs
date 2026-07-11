import { out } from "./cli-io.mjs";

/** @param {string[]} rest */
export async function handleMonitor(rest) {
  // Self-observability: record a redacted forensic capture of an observed
  // llm-wiki-memory anomaly under <data>/monitoring/, or --resolve one as
  // triaged. See lib/monitoring.mjs + the self-observability rule.
  const { writeMonitoringCapture, resolveCapture, relatedEscalation } =
    await import("./lib/monitoring.mjs");
  /** @param {string} name */
  const opt = (name) => {
    const idx = rest.indexOf(`--${name}`);
    if (idx < 0) return null;
    const val = rest[idx + 1];
    return val == null || val.startsWith("--") ? null : val;
  };
  const resolveArg = opt("resolve");
  if (resolveArg) {
    const r = resolveCapture(resolveArg);
    out(r);
    process.exit(r.ok ? 0 : 2);
  }
  const title = opt("title");
  if (!title) {
    process.stderr.write(
      "usage: llm-wiki-memory monitor --title <t> [--severity likely-bug|confirmed-bug] [--surface <s>] [--observed <s>] [--evidence <s>] [--suspected <f,f>] [--cwd <p>] [--branch <b>] [--related <s>] | --resolve <file>\n",
    );
    process.exit(64);
  }
  const evidence = opt("evidence") || "";
  const relatedArg = opt("related");
  let related = relatedArg || "";
  if (!related) {
    const { normalizeErrorSignature } = await import("./lib/error-signature.mjs");
    related = await relatedEscalation(normalizeErrorSignature(title));
  }
  const r = writeMonitoringCapture(
    /** @type {Parameters<typeof writeMonitoringCapture>[0]} */ (
      /** @type {unknown} */ ({
        title,
        severity: opt("severity") || "confirmed-bug",
        surface: opt("surface") || "",
        observed: opt("observed") || "",
        evidence,
        suspectedFiles: (opt("suspected") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        cwd: opt("cwd") || "",
        branch: opt("branch") || "",
        related,
      })
    ),
  );
  out(r);
  process.exit(r.ok ? 0 : 1);
}

export async function handleMonitoringHealth() {
  // Read-only count of unreviewed self-observability captures (status:open).
  // Surfaced at SessionStart (one line) + the session-end-capture skill.
  const { monitoringHealth } = await import("./lib/monitoring.mjs");
  out(monitoringHealth());
  return;
}

/** @param {string[]} rest */
export async function handleGateAudit(rest) {
  // Read-only view of the write-gate audit ledger
  // (state/.save-gate-audit.log): every decision on the gated self_improvement
  // category, newest last: L2 hook allow/ask, L3 server accepted/refused, and
  // compile-distilled lesson promotions (observability only). Inspect how (or
  // whether) each lesson was consented to. Returns [] when nothing recorded yet.
  const { readAudit } = await import("./lib/save-gate-audit.mjs");
  const idx = rest.indexOf("--limit");
  const limRaw = idx >= 0 ? Number(rest[idx + 1]) : NaN;
  const limit = Number.isFinite(limRaw) && limRaw > 0 ? limRaw : 50;
  out(readAudit({ limit }));
  return;
}

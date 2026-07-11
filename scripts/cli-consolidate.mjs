import { out } from "./cli-io.mjs";

/** @param {string[]} rest */
export async function handleConsolidate(rest) {
  // Search-driven AutoDream consolidation. See scripts/consolidate.mjs
  // for the orchestrator + per-pass rules. Flags:
  //   --dry-run, --if-due, --force, --no-llm, --json
  //   --passes=<csv>            (allow-list of pass names)
  //   --cosine-threshold=<n>    (override 0..1)
  const { consolidateMemory } = await import("./consolidate.mjs");
  /** @param {string} name */
  const flag = (name) => rest.includes(`--${name}`);
  /** @param {string} name */
  const opt = (name) => {
    const prefix = `--${name}=`;
    const hit = rest.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  // --cosine-threshold overrides the YAML knob for this CLI process via
  // the process-level settings override. Operators normally edit
  // settings.yaml; this flag is a one-shot override for the current
  // invocation and dies with the process.
  // Space-form flags silently did nothing (the 2026-06-04 one-off run
  // executed at the default threshold twice before anyone noticed).
  // Fail loud on the known value-taking flags when passed without '='.
  for (const valueFlag of ["cosine-threshold", "passes"]) {
    if (rest.includes(`--${valueFlag}`)) {
      process.stderr.write(
        `consolidate: --${valueFlag} requires the equals form (--${valueFlag}=<value>); ignoring the bare flag would silently run with defaults — aborting.\n`,
      );
      process.exit(2);
    }
  }
  const cosineOverride = opt("cosine-threshold");
  if (cosineOverride) {
    const n = Number.parseFloat(cosineOverride);
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      const { __setSettingsOverride } = await import("./lib/settings.mjs");
      __setSettingsOverride({ consolidate: { cosineThreshold: n } });
    } else {
      process.stderr.write(
        `consolidate: invalid --cosine-threshold value '${cosineOverride}' (expected 0..1); refusing to silently run at the default — aborting.\n`,
      );
      process.exit(2);
    }
  }
  const result = await consolidateMemory(
    /** @type {Parameters<typeof consolidateMemory>[0]} */ ({
      dryRun: flag("dry-run"),
      ifDue: flag("if-due"),
      force: flag("force"),
      llm: !flag("no-llm"),
      passes: opt("passes"),
    }),
  );
  if (flag("json")) return out(result);
  // Pretty print: short summary + a one-line-per-pass breakdown.
  out(result);
  return;
}

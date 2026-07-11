import { out } from "./cli-io.mjs";

export async function handleCronJob() {
  // Hourly cron entry point. Runs compile + consolidate --if-due
  // sequentially, appends a structured attempt entry to
  // state/.consolidate-attempts.log (success OR error), and exits
  // 0 (so cron doesn't email failures — the log is the source of
  // truth and SessionStart surfaces unresolved failures to the user).
  const { runCronJob } = await import("./cron-job.mjs");
  const entry = await runCronJob();
  out(entry);
  // Exit 0 unconditionally so cron treats this as success. The log
  // entry's `ok: false` is the persistent signal; SessionStart's
  // cron-health check raises it with the user.
  process.exit(0);
  return;
}

export async function handleCronHealth() {
  const { cronHealth } = await import("./cron-job.mjs");
  out(cronHealth());
  return;
}

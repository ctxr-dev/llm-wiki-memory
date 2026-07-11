const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");
// BSD EX_UNAVAILABLE. Distinguishes "work pending but no LLM/bridge provider
// reachable" (retryable, cron-job keeps running consolidate and counts the
// attempt as failed) from 0 (clean) and other non-zero (hard failure).
const EX_UNAVAILABLE = 69;

export { FORCE, DRY_RUN, EX_UNAVAILABLE };

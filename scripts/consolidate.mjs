// Search-driven AutoDream consolidation orchestrator.
//
// For every active leaf in the layout-declared `consolidate: refine`
// categories, compute its similarity cluster via `searchMemoryFiltered`,
// apply deterministic dedup passes (sha256 / lesson-key / cosine), then a
// sweep of corpus-scoped passes (staleness flag, orphan archive,
// compress-archived, prune-empty-ancestors, gc-embeddings, index-rebuild).
// Eligibility is layout-driven — NO category name is hardcoded in this
// file. Atom-type-based filters (LESSON_KEY_ELIGIBLE_ATOM_TYPES,
// STALENESS_ELIGIBLE_ATOM_TYPES, ORPHAN_EXCLUDE_ATOM_TYPES) decide
// per-leaf behaviour within a refine-eligible category. The whole run is
// wrapped in `withSystemMaintenance(...)` so every internal write is
// exempt from the L3 self_improvement write-gate.
//
// Phase 3 (LLM-merge + LLM-refresh) plugs into the SAME merge-candidates
// indirection used here: each cluster pass marks (keeper, loser) tuples
// in `ctx.mergeCandidates`; the per-leaf `finalizeMergeCandidates` step
// archives the losers. When LLM passes ship, they'll consume the same
// list BEFORE finalize to optionally rewrite the keeper body. No design
// rework needed when that lands.
//
// Determinism contract: with `now` injected (frozen-clock tests) and the
// same wiki state, two runs produce byte-identical post-state across the
// deterministic passes. LLM passes (Phase 3) hit the same contract via
// the mock-LLM plumbing.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CONSOLIDATE_STATE_PATH,
  COMPILE_LOCK_PATH,
  PROMPTS_DIR,
  wikiRoot,
} from "./lib/env.mjs";
import {
  consolidateIntervalDays,
  consolidateCosineThreshold,
  consolidateCosineLexicalThreshold,
  consolidateCosineBandFloor,
  consolidateClusterTopK,
  consolidateClusterScoreThreshold,
  consolidateOrphanTtlDays,
  consolidateStaleAfterMonths,
  consolidateArchiveBodyMax,
  consolidateArchiveAgeDays,
  consolidatePassesEnv,
  consolidateLlmPassesEnabled,
  consolidateLlmMaxRetries,
  consolidateRefreshMaxPerRun,
  atomBodyMaxChars,
  compileLockStaleMs,
} from "./lib/settings.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lib/lock.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { withSystemMaintenance } from "./lib/maintenance-tag.mjs";
import { withWikiCommit } from "./lib/wiki-commit.mjs";
import { redact } from "./lib/redact.mjs";
import { truncateAtWordBoundary } from "./lib/slug.mjs";
import { activeBackend, contentHash } from "./lib/embed.mjs";
import {
  listActiveLeavesForConsolidate,
  readLeafForConsolidate,
  searchMemoryFiltered,
  disableDocument,
  updateDocMetadata,
  truncateArchivedBody,
  pruneEmbeddingCache,
  listDocuments,
  getCategories,
  saveDocument,
  getConsolidateLayout,
} from "./lib/wiki-store.mjs";
import { pruneEmptyAncestors } from "./lib/fs-prune.mjs";
import { ensureIndexes } from "./lib/wiki-cli.mjs";
import { callJSON } from "./lib/llm-callJSON.mjs";
import { health as llmHealth, LLMProviderUnavailable, LLMOutputInvalid } from "./lib/llm.mjs";

// Stamp non-facet bookkeeping (consolidated_at / stale / last_refreshed_at /
// supersedes_id) onto a leaf WITHOUT relocating it. consolidate never changes a
// leaf's placement facets, so the leaf must stay at its current path: an
// unpinned updateDocMetadata recomputes the canonical placement and, for a leaf
// already sitting off-canonical (e.g. a legacy pre-subject-axis path), would
// relocate it as a side effect — silently changing a merge keeper's documentId
// (breaking the supersedes_id we stamp on its loser), making a follow-up
// disableDocument miss, and (on a destination collision) leaving a DUP-ID.
// Pinning to the leaf's own directory keeps the stamp a pure in-place rewrite.
function stampLeafMetadata(documentId, metadata) {
  // Pin to the leaf's own directory. `dirname` returns "." for a bare filename;
  // no real leaf lives at the wiki root, but guard anyway so the override (which
  // rejects "."/empty) never throws — in that (unreachable) case omit the
  // override and let updateDocMetadata place by facets as usual.
  const dir = path.posix.dirname(documentId);
  return updateDocMetadata({
    documentId,
    metadata,
    placementOverride: dir && dir !== "." ? dir : undefined,
  });
}

// The set of categories the consolidate orchestrator walks is now declared
// EXPLICITLY in the layout YAML (per-category `consolidate: refine|none`).
// No defaults — every category must say which side it's on. The orchestrator
// reads the layout at run start and refuses to proceed if any category lacks
// the field. See getConsolidateLayout() in wiki-store.mjs.

const ALL_PASS_NAMES = Object.freeze([
  "dedupe-by-sha256",
  "dedupe-by-lesson-key",
  "dedupe-by-cosine",
  "llm-merge-near-duplicates",
  "staleness-flag",
  "llm-semantic-refresh",
  "prune-orphan-leaves",
  "compress-archived",
  "prune-empty-ancestors",
  "prune-embeddings",
  "index-rebuild",
]);

// Zod schemas for the two LLM passes. Same JSON-output-with-retry contract
// as compile.mjs:333 decideAction — the underlying callJSON helper validates,
// throws LLMOutputInvalid on schema failure, retries up to
// consolidateLlmMaxRetries() with a corrective suffix, then bubbles a
// terminal failure to the caller (which falls back to the deterministic
// archive-without-merge / leave-stale-flag path).
const MERGE_SCHEMA = z
  .object({
    action: z.enum(["merge", "keep-keeper-unchanged", "skip"]),
    merged_body: z.string().min(1).optional(),
    keeper_id: z.string().min(1),
    loser_id: z.string().min(1),
    reason: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.action === "merge" && !v.merged_body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["merged_body"],
        message: "merged_body is required when action='merge'",
      });
    }
  });

const REFRESH_SCHEMA = z
  .object({
    action: z.enum(["keep", "rewrite", "archive"]),
    leaf_id: z.string().min(1),
    rewritten_body: z.string().min(1).optional(),
    archive_reason: z.string().min(1).optional(),
    stale_after: z.boolean(),
    reason: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.action === "rewrite" && !v.rewritten_body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rewritten_body"],
        message: "rewritten_body is required when action='rewrite'",
      });
    }
    if (v.action === "archive" && !v.archive_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archive_reason"],
        message: "archive_reason is required when action='archive'",
      });
    }
  });

// Atom types whose graph reaches outside the wiki (issue trackers, plans,
// long-lived knowledge artefacts). Orphan-detection skips them because their
// "no inbound link" is a property of the external world, not the wiki.
const ORPHAN_EXCLUDE_ATOM_TYPES = new Set([
  "jira_issue",
  "plan",
  "investigation",
  "decision",
  "project-lore",
  "reference",
  // Daily-capture leaves are inputs to compile, not durable knowledge; their
  // lifecycle is owned by compile.mjs (promotes them, archives the source).
  // Exempt them from orphan-archival so a year-old daily that compile hasn't
  // yet promoted isn't silently archived by consolidate.
  "daily-capture",
]);

// Atom types eligible for the staleness pass (and therefore for
// llm-semantic-refresh). This is purely an atom_type semantic filter —
// category eligibility comes from the layout YAML's `consolidate: refine`
// declaration. ANY refine-eligible category whose leaves carry one of
// these atom_types participates uniformly.
//
// Why these (and not others):
//   self-improvement-lesson — canonical self_improvement leaf shape.
//   bug-root-cause / feedback-rule / pattern-gotcha — knowledge atoms that
//   can drift over time (the bug was fixed; the rule was reversed; the
//   gotcha became obsolete after a library upgrade).
//
// Intentionally excluded (durable / canonical records):
//   decision    — architectural decisions are point-in-time records.
//   reference   — canonical pointers (URLs, file paths, conventions).
//   project-lore — historical context that shouldn't be rewritten.
//   plan / investigation / jira_issue — owned by other lifecycles; the
//                                       layout already excludes their
//                                       categories from refine.
const STALENESS_ELIGIBLE_ATOM_TYPES = new Set([
  "self-improvement-lesson",
  "bug-root-cause",
  "feedback-rule",
  "pattern-gotcha",
]);

// Atom_types whose lesson-key (project_module / area / task_type /
// error_pattern) is meaningful for cross-leaf dedup. self-improvement-lesson
// is the canonical case; other categories may carry the same fields, but
// dedup by this key only makes sense where it's idiomatic. Empty atom_type
// skips the pass.
const LESSON_KEY_ELIGIBLE_ATOM_TYPES = new Set([
  "self-improvement-lesson",
]);

// ─── helpers ───────────────────────────────────────────────────────────────

function toIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string" && now) {
    const t = Date.parse(now);
    return Number.isFinite(t) ? t : Date.now();
  }
  return Date.now();
}

function emptyPassReport(name) {
  return {
    name,
    archived: 0,
    touched: 0,
    merged: 0,
    refreshed: 0,
    flagged: 0,
    errors: 0,
    freedBytes: 0,
    ms: 0,
    skipped: false,
    // Per-entity outcomes for the sharded full cron log + entity-level
    // self-healing. `entities` = actions that landed (or were deliberately
    // skipped); `failures` = per-entity errors with a redacted excerpt.
    // Sorted by id at orchestrator return so dry-run twice is byte-identical.
    entities: [],
    failures: [],
  };
}

function entityPairId(keeper, loser) {
  return `pair:${keeper.documentId}|${loser.documentId}`;
}

function entityLeafId(leaf) {
  return `leaf:${leaf.documentId}`;
}

function recordEntity(report, { id, kind, action, ok, reason, error }) {
  const e = { id, kind, action, ok: Boolean(ok) };
  // Success reasons can be LLM-authored (decision.reason / archive_reason)
  // and land in the persisted full cron log — redact like failure excerpts.
  if (reason) e.reason = redact(String(reason)).replace(/[\r\n]+/g, " ").slice(0, 300);
  if (e.ok) {
    report.entities.push(e);
    return;
  }
  e.excerpt = redact(String(error?.message || error || "unknown error"))
    .replace(/\s+/g, " ")
    .slice(0, 500);
  report.failures.push(e);
}

function sortPassEntities(reportMap) {
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const r of reportMap.values()) {
    r.entities.sort(byId);
    r.failures.sort(byId);
  }
}

function stripPassEntities(passes) {
  return Object.fromEntries(
    Object.entries(passes).map(([k, v]) => {
      const { entities, failures, ...counts } = v;
      return [k, counts];
    }),
  );
}

function readState() {
  try {
    const raw = fs.readFileSync(CONSOLIDATE_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(CONSOLIDATE_STATE_PATH), { recursive: true });
    // Atomic (unique temp + fsync + rename) so a crash mid-write can't leave a
    // truncated throttle file in place — readState would then treat it as
    // "never run" and reset the interval. Matches the durable JSON-state
    // writers (compile state, GC state), which all route through writeFileAtomic.
    writeFileAtomic(CONSOLIDATE_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(
      `[consolidate] state write failed: ${err?.message || err}\n`,
    );
  }
}

function resolveAllowedPasses(passesArg) {
  // Resolution order: explicit arg from CLI/MCP > env > "all".
  //
  // Distinguish three cases:
  //   - passesArg === undefined / null  -> consult env (default "all")
  //   - passesArg === [] (empty array)  -> caller explicitly disabled ALL passes
  //     (orchestrator returns immediately with totals zero — useful as a
  //     dry-run / no-op probe)
  //   - passesArg === "" (empty string) -> same as []: no passes
  //   - non-empty CSV / array            -> exactly those passes
  //   - "all" / contains "all"           -> every pass
  if (passesArg == null) {
    const raw = consolidatePassesEnv();
    if (!raw || raw === "all") return new Set(ALL_PASS_NAMES);
    const parts = String(raw)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0 || parts.includes("all")) return new Set(ALL_PASS_NAMES);
    return new Set(parts);
  }
  // Explicit value: array OR string (from CLI --passes=).
  if (Array.isArray(passesArg)) {
    const parts = passesArg.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (parts.includes("all")) return new Set(ALL_PASS_NAMES);
    return new Set(parts);
  }
  const str = String(passesArg).trim();
  if (str === "" ) return new Set();
  if (str === "all") return new Set(ALL_PASS_NAMES);
  const parts = str
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes("all")) return new Set(ALL_PASS_NAMES);
  return new Set(parts);
}

function passEnabled(name, allowed) {
  return allowed.has(name);
}

// Keeper selection: newer `frontmatter.updated` wins. Tiebreak by
// lex-ascending documentId so two runs on the same fixture pick identically.
function pickKeeper(a, b) {
  const au = String(a.frontmatter?.updated || "");
  const bu = String(b.frontmatter?.updated || "");
  if (au > bu) return a;
  if (bu > au) return b;
  return a.documentId < b.documentId ? a : b;
}

function ageInDays(isoOrEpoch, now) {
  if (!isoOrEpoch) return Infinity;
  const t =
    typeof isoOrEpoch === "string" ? Date.parse(isoOrEpoch) : Number(isoOrEpoch);
  if (!Number.isFinite(t)) return Infinity;
  return (nowMs(now) - t) / (1000 * 60 * 60 * 24);
}

function ageInMonths(isoOrEpoch, now) {
  return ageInDays(isoOrEpoch, now) / 30.4375;
}

// ─── cluster passes ────────────────────────────────────────────────────────

// 2B — exact byte-equal duplicates inside the cluster (single category).
function dedupeBySha256({ leaf, clusterLeaves, ctx, now }) {
  const t0 = Date.now();
  const report = ctx.report.get("dedupe-by-sha256");
  const leafHash = contentHash(leaf.text);
  for (const m of clusterLeaves) {
    if (m.documentId === leaf.documentId) continue;
    if (ctx.touchedThisRun.has(m.documentId)) continue;
    if (m.category !== leaf.category) continue; // defensive
    if (contentHash(m.text) !== leafHash) continue;
    const keeper = pickKeeper(leaf, m);
    const loser = keeper.documentId === leaf.documentId ? m : leaf;
    // Pair already queued (same leaf may appear in multiple clusters across
    // the loop)? Skip — first marker wins.
    if (ctx.pairsSeen.has(loserKey(keeper, loser))) continue;
    ctx.pairsSeen.add(loserKey(keeper, loser));
    ctx.mergeCandidates.push({
      keeper,
      loser,
      sourcePass: "dedupe-by-sha256",
    });
    ctx.touchedThisRun.add(loser.documentId);
    report.flagged++;
    recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "flag", ok: true, reason: "sha256-equal" });
  }
  report.ms += Date.now() - t0;
}

// 2C — lesson-key dedup. Atom-type-gated, NOT category-gated: any
// LESSON_KEY_ELIGIBLE_ATOM_TYPES leaf (default: self-improvement-lesson)
// can be grouped by (project_module, area, task_type, error_pattern).
// Empty error_pattern skips the pair (those are surfaced separately by
// audit_memory). Layout YAML still decides which categories are even
// walked (via `consolidate: refine`) — this pass only applies the
// atom-type semantic on top.
function dedupeByLessonKey({ leaf, clusterLeaves, ctx, now }) {
  const leafAtom = String(leaf.memory?.atom_type || "");
  if (!LESSON_KEY_ELIGIBLE_ATOM_TYPES.has(leafAtom)) return;
  const t0 = Date.now();
  const report = ctx.report.get("dedupe-by-lesson-key");
  const leafKey = lessonKey(leaf);
  if (!leafKey) {
    report.ms += Date.now() - t0;
    return;
  }
  for (const m of clusterLeaves) {
    if (m.documentId === leaf.documentId) continue;
    if (ctx.touchedThisRun.has(m.documentId)) continue;
    const mAtom = String(m.memory?.atom_type || "");
    if (!LESSON_KEY_ELIGIBLE_ATOM_TYPES.has(mAtom)) continue;
    if (lessonKey(m) !== leafKey) continue;
    const keeper = pickKeeper(leaf, m);
    const loser = keeper.documentId === leaf.documentId ? m : leaf;
    if (ctx.pairsSeen.has(loserKey(keeper, loser))) continue;
    ctx.pairsSeen.add(loserKey(keeper, loser));
    ctx.mergeCandidates.push({
      keeper,
      loser,
      sourcePass: "dedupe-by-lesson-key",
    });
    ctx.touchedThisRun.add(loser.documentId);
    report.flagged++;
    recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "flag", ok: true, reason: "lesson-key-equal" });
  }
  report.ms += Date.now() - t0;
}

function lessonKey(leaf) {
  const m = leaf.memory || {};
  const ep = String(m.error_pattern || "").trim().toLowerCase();
  if (!ep) return ""; // sentinel: skip
  const pm = String(m.project_module || "").trim().toLowerCase();
  const ar = String(m.area || "").trim().toLowerCase();
  const tt = String(m.task_type || "").trim().toLowerCase();
  return `${pm}|${ar}|${tt}|${ep}`;
}

// 2D — cosine-similarity archive inside the cluster. The cluster scores
// returned by `searchMemoryFiltered` already use the leaf body as the query,
// so `record.score === cosine(leaf, member)` — no extra vector math needed.
// The lexical-fallback warning is emitted ONCE per run at orchestrator
// startup (see consolidateMemory), so this pass just reads the resolved
// threshold off ctx.cosineThreshold without re-warning.
function dedupeByCosine({ leaf, cluster, ctx, now }) {
  const t0 = Date.now();
  const report = ctx.report.get("dedupe-by-cosine");
  const threshold = ctx.cosineThreshold;
  // The LLM-only band exists ONLY when the merge pass can actually adjudicate
  // this run: when the LLM is unavailable, finalize archives every flagged
  // loser deterministically, so flagging a sub-threshold pair would archive
  // it without judgment — exactly what the band forbids.
  const bandActive = ctx.cosineBandFloor != null && ctx.llmEnabled === true;
  const effectiveFloor = bandActive ? ctx.cosineBandFloor : threshold;
  for (const member of cluster.records) {
    if (member.documentId === leaf.documentId) continue;
    if (ctx.touchedThisRun.has(member.documentId)) continue;
    if (member.score < effectiveFloor) continue;
    const memberLeaf = readLeafForConsolidate({
      documentId: member.documentId,
    });
    if (!memberLeaf) continue; // vanished mid-walk
    if (memberLeaf.category && memberLeaf.category !== leaf.category) continue;
    // Defensive: cluster is already category-scoped via searchMemoryFiltered's
    // datasetId, but we double-check by category prefix on the documentId.
    if (!memberLeaf.documentId.startsWith(`${leaf.category}/`)) continue;
    memberLeaf.category = leaf.category;
    const keeper = pickKeeper(leaf, memberLeaf);
    const loser = keeper.documentId === leaf.documentId ? memberLeaf : leaf;
    if (ctx.pairsSeen.has(loserKey(keeper, loser))) continue;
    ctx.pairsSeen.add(loserKey(keeper, loser));
    const inBand = member.score < threshold;
    ctx.mergeCandidates.push({
      keeper,
      loser,
      sourcePass: "dedupe-by-cosine",
      score: member.score,
      band: inBand,
    });
    ctx.touchedThisRun.add(loser.documentId);
    report.flagged++;
    recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "flag", ok: true, reason: `cosine ${Number(member.score).toFixed(4)}${inBand ? " (band)" : ""}` });
  }
  report.ms += Date.now() - t0;
}

function loserKey(keeper, loser) {
  return `${keeper.documentId}|${loser.documentId}`;
}

// 3A — LLM merge-near-duplicates. Consumes the mergeCandidates queued by
// 2B/2C/2D BEFORE the deterministic finalize archives the loser. For each
// (keeper, loser) pair we ask the LLM to either rewrite the keeper body
// (action="merge"), leave the keeper as-is and still archive the loser
// (action="keep-keeper-unchanged"), or skip the whole pair (action="skip")
// — which leaves BOTH leaves active.
//
// Mutates each candidate in place with `cand.llmDecision`:
//   - { action: "merge",  ...llm }                  -> keeper body rewritten here; finalize archives loser
//   - { action: "keep-keeper-unchanged", ...llm }   -> finalize archives loser unchanged
//   - { action: "skip",   ...llm }                  -> finalize skips this candidate (both leaves stay active)
//   - { action: "fallback", ...err }                -> LLM unreachable / schema failed; finalize archives loser
//
// `dryRun`: the LLM still runs (the orchestrator wants to know what WOULD
// change), but the keeper-body rewrite is skipped and the candidate is
// returned with the decision logged. The downstream finalize also honours
// dryRun.
async function llmMergeNearDuplicates({ candidates, ctx, now, dryRun }) {
  if (!candidates.length) return;
  const report = ctx.report.get("llm-merge-near-duplicates");
  const t0 = Date.now();
  const maxRetries = consolidateLlmMaxRetries();
  const bodyCap = atomBodyMaxChars();
  const promptPath = path.join(PROMPTS_DIR, "consolidate-merge.md");
  for (const cand of candidates) {
    if (cand.llmDecision) continue; // already decided
    const { keeper, loser, sourcePass } = cand;
    const vars = {
      SOURCE_PASS: sourcePass,
      KEEPER_ID: keeper.documentId,
      KEEPER_UPDATED: String(keeper.frontmatter?.updated || ""),
      KEEPER_FRONTMATTER: keeper.memory || {},
      KEEPER_BODY: String(keeper.text || ""),
      LOSER_ID: loser.documentId,
      LOSER_UPDATED: String(loser.frontmatter?.updated || ""),
      LOSER_FRONTMATTER: loser.memory || {},
      LOSER_BODY: String(loser.text || ""),
      ATOM_BODY_MAX_CHARS: bodyCap,
    };
    try {
      const decision = await callJSON({
        promptPath,
        userPrompt: "Emit STRICT JSON per the schema in the system prompt.",
        vars,
        schema: MERGE_SCHEMA,
        maxRetries,
        maxTokens: 1200,
      });
      // Hallucination guard against the documentIds — schema already enforces
      // string presence; here we enforce match to inputs.
      if (decision.keeper_id !== keeper.documentId || decision.loser_id !== loser.documentId) {
        throw new LLMOutputInvalid(
          `LLM emitted ids that don't match inputs: keeper=${decision.keeper_id} (want ${keeper.documentId}), loser=${decision.loser_id} (want ${loser.documentId})`,
          JSON.stringify(decision),
        );
      }
      cand.llmDecision = decision;
      if (decision.action === "merge") {
        let body = String(decision.merged_body || "");
        if (body.length > bodyCap) {
          body = truncateAtWordBoundary(body, bodyCap, { preferSentence: true }) +
            `\n\n[truncated by consolidate at ${toIso(now)} — merged_body exceeded settings.compile.atomBodyMaxChars]\n`;
          process.stderr.write(
            `[consolidate] 3A merged_body truncated for keeper=${keeper.documentId} (${decision.merged_body.length} -> ${body.length} chars)\n`,
          );
        }
        if (!dryRun) {
          // Rewrite the keeper body in place. CRITICAL: saveDocument runs
          // facet inference on the passed metadata and would RELOCATE the
          // leaf if the inferred placement disagrees with the current dir.
          // That would silently invalidate keeper.documentId AND the
          // supersedes_id we're about to stamp on the loser. Pin the
          // placement via `placementOverride` (the leaf's existing dir)
          // so the rewrite stays in place. saveDocument's
          // normalisePlacementOverride accepts a directory; we strip the
          // leaf basename from keeper.documentId.
          const keeperMem = { ...(keeper.memory || {}) };
          const keeperDir = path.posix.dirname(keeper.documentId);
          try {
            saveDocument({
              name: keeper.name,
              text: body,
              datasetId: keeper.category,
              metadata: keeperMem,
              placementOverride: keeperDir,
            });
            stampLeafMetadata(keeper.documentId, { consolidated_at: toIso(now) });
            report.merged++;
            recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "merge", ok: true });
          } catch (err) {
            report.errors++;
            recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "merge", ok: false, error: err });
            process.stderr.write(
              `[consolidate] 3A merge-write failed for keeper=${keeper.documentId}: ${err?.message || err}\n`,
            );
            if (cand.band) {
              // Band pairs are LLM-judgment-only: a failed rewrite must not
              // degrade into a deterministic archive. Keep both leaves.
              cand.llmDecision = { action: "skip", reason: `band pair, merge-write failed — kept both active`, bandFallback: true };
              ctx.flaggedSkips = ctx.flaggedSkips || [];
              ctx.flaggedSkips.push({ class: "band-llm-unreachable", keeperId: keeper.documentId, loserId: loser.documentId, reason: String(err?.message || err) });
              recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "skip", ok: true, reason: "band pair, merge-write failed — kept both active" });
            } else {
              // Treat as fallback so finalize still archives the loser.
              cand.llmDecision = { action: "fallback", reason: `merge-write failed: ${err?.message || err}` };
            }
          }
        } else {
          report.merged++;
          recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "merge", ok: true });
        }
      } else if (decision.action === "keep-keeper-unchanged") {
        // No keeper rewrite; finalize still archives loser.
        recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "keep-keeper", ok: true });
      } else if (decision.action === "skip") {
        // Surface the LLM rejection on the merge-pass report (the source
        // pass already counted the deterministic flag at queue time, so
        // bumping it again here would double-count).
        report.flagged++;
        ctx.flaggedSkips = ctx.flaggedSkips || [];
        ctx.flaggedSkips.push({
          class: "llm-rejected-merge",
          keeperId: keeper.documentId,
          loserId: loser.documentId,
          reason: decision.reason,
        });
        recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "skip", ok: true, reason: decision.reason });
      }
    } catch (err) {
      // Terminal LLM failure. At/above the threshold the established
      // contract holds: fall back to deterministic archive-without-merge.
      // In the BAND the pair exists only for LLM adjudication, so an
      // unreachable LLM means keep both leaves (skip), never blind-archive.
      if (cand.band) {
        cand.llmDecision = {
          action: "skip",
          reason: `band pair, llm unreachable — kept both active`,
          bandFallback: true,
        };
        ctx.flaggedSkips = ctx.flaggedSkips || [];
        ctx.flaggedSkips.push({
          class: "band-llm-unreachable",
          keeperId: keeper.documentId,
          loserId: loser.documentId,
          reason: String(err?.message || err),
        });
        recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "skip", ok: true, reason: "band pair, llm unreachable — kept both active" });
      } else {
        cand.llmDecision = {
          action: "fallback",
          reason: `llm-merge-failed: ${err?.message || String(err)}`,
        };
      }
      report.errors++;
      recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "merge", ok: false, error: err });
      process.stderr.write(
        `[consolidate] event=llm-merge-failed pair=${keeper.documentId}|${loser.documentId} ${err?.message || err}\n`,
      );
    }
  }
  report.ms += Date.now() - t0;
}

// 3B — LLM semantic refresh. Runs AFTER stalenessFlag flagged leaves. Caps
// per-run LLM calls at consolidateRefreshMaxPerRun(); remaining stale leaves
// carry over to the next run. For each candidate the LLM either keeps it
// (optionally clearing the stale flag), rewrites the body (clearing stale +
// stamping last_refreshed_at), or archives it. Per-leaf failures DO NOT
// abort the loop.
async function llmSemanticRefresh({ ctx, now, dryRun }) {
  const report = ctx.report.get("llm-semantic-refresh");
  const t0 = Date.now();
  const maxRetries = consolidateLlmMaxRetries();
  const cap = consolidateRefreshMaxPerRun();
  const bodyCap = atomBodyMaxChars();
  const promptPath = path.join(PROMPTS_DIR, "consolidate-refresh.md");

  // Collect stale leaves across refine-eligible categories (layout-declared).
  const stale = [];
  for (const cat of ctx.refineCategories || []) {
    for (const leaf of listActiveLeavesForConsolidate({ category: cat })) {
      if (leaf.memory?.stale !== true) continue;
      stale.push({ ...leaf, category: cat });
    }
  }
  // Process recently-recalled leaves first; they're more likely to be
  // load-bearing in current work. Tie-break by lex-ascending documentId
  // so two runs with identical timestamps pick the same leaves first
  // (deterministic ordering under the per-run cap).
  stale.sort((a, b) => {
    const aMs = Date.parse(a.memory?.last_recalled_at || "") || 0;
    const bMs = Date.parse(b.memory?.last_recalled_at || "") || 0;
    if (aMs !== bMs) return bMs - aMs;
    return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
  });

  const limited = stale.slice(0, Math.max(0, cap));
  if (stale.length > limited.length) {
    process.stderr.write(
      `[consolidate] 3B refresh capped at ${cap}/run; ${stale.length - limited.length} stale leaves deferred to next run\n`,
    );
  }

  for (const leaf of limited) {
    let cluster;
    try {
      cluster = await searchMemoryFiltered({
        query: String(leaf.text).slice(0, 1024),
        datasetId: leaf.category,
        limit: consolidateClusterTopK(),
        scoreThreshold: consolidateClusterScoreThreshold(),
      });
    } catch (err) {
      report.errors++;
      recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: "refresh", ok: false, error: err });
      process.stderr.write(
        `[consolidate] 3B cluster lookup failed for ${leaf.documentId}: ${err?.message || err}\n`,
      );
      continue;
    }
    const filteredCluster = (cluster?.records || []).filter(
      (r) => r.documentId !== leaf.documentId,
    );
    const clusterBundle = filteredCluster.slice(0, consolidateClusterTopK()).map((r, i) => ({
      n: i + 1,
      documentId: r.documentId,
      score: Number(r.score?.toFixed?.(4) ?? r.score),
      content: String(r.content || "").slice(0, 600),
    }));

    const lastRecalled = leaf.memory?.last_recalled_at || "";
    const daysSinceRecall = lastRecalled
      ? Math.max(0, Math.round(ageInDays(lastRecalled, now)))
      : "never";

    const vars = {
      LEAF_ID: leaf.documentId,
      LEAF_UPDATED: String(leaf.frontmatter?.updated || ""),
      LEAF_LAST_RECALLED: lastRecalled || "never",
      LEAF_DAYS_SINCE_RECALL: daysSinceRecall,
      LEAF_FRONTMATTER: leaf.memory || {},
      LEAF_BODY: String(leaf.text || ""),
      CLUSTER_BUNDLE: clusterBundle,
      ATOM_BODY_MAX_CHARS: bodyCap,
    };

    let decision;
    try {
      decision = await callJSON({
        promptPath,
        userPrompt: "Emit STRICT JSON per the schema in the system prompt.",
        vars,
        schema: REFRESH_SCHEMA,
        maxRetries,
        maxTokens: 1200,
      });
      if (decision.leaf_id !== leaf.documentId) {
        throw new LLMOutputInvalid(
          `LLM emitted leaf_id=${decision.leaf_id} that doesn't match input ${leaf.documentId}`,
          JSON.stringify(decision),
        );
      }
    } catch (err) {
      report.errors++;
      recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: "refresh", ok: false, error: err });
      process.stderr.write(
        `[consolidate] event=llm-refresh-failed leaf=${leaf.documentId} ${err?.message || err}\n`,
      );
      continue; // leave the stale flag in place
    }

    if (dryRun) {
      if (decision.action === "rewrite") report.refreshed++;
      else if (decision.action === "archive") report.archived++;
      else report.touched++;
      recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: decision.action, ok: true });
      continue;
    }

    try {
      if (decision.action === "keep") {
        stampLeafMetadata(leaf.documentId, { stale: decision.stale_after === true });
        report.touched++;
        recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: "keep", ok: true });
      } else if (decision.action === "rewrite") {
        let body = String(decision.rewritten_body || "");
        if (body.length > bodyCap) {
          body = truncateAtWordBoundary(body, bodyCap, { preferSentence: true }) +
            `\n\n[truncated by consolidate at ${toIso(now)} — rewritten_body exceeded settings.compile.atomBodyMaxChars]\n`;
          process.stderr.write(
            `[consolidate] 3B rewritten_body truncated for ${leaf.documentId}\n`,
          );
        }
        // Same relocation hazard as 3A — pin to the leaf's existing dir.
        const leafDir = path.posix.dirname(leaf.documentId);
        saveDocument({
          name: leaf.name,
          text: body,
          datasetId: leaf.category,
          metadata: leaf.memory || {},
          placementOverride: leafDir,
        });
        stampLeafMetadata(leaf.documentId, {
          stale: false,
          last_refreshed_at: toIso(now),
          consolidated_at: toIso(now),
        });
        report.refreshed++;
        recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: "rewrite", ok: true });
      } else if (decision.action === "archive") {
        stampLeafMetadata(leaf.documentId, { consolidated_at: toIso(now) });
        disableDocument({ documentId: leaf.documentId });
        ctx.flaggedRefreshArchives = ctx.flaggedRefreshArchives || [];
        ctx.flaggedRefreshArchives.push({
          leafId: leaf.documentId,
          archive_reason: decision.archive_reason,
          reason: decision.reason,
        });
        report.archived++;
        recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: "archive", ok: true, reason: decision.archive_reason });
      }
    } catch (err) {
      report.errors++;
      recordEntity(report, { id: entityLeafId(leaf), kind: "leaf", action: decision.action, ok: false, error: err });
      process.stderr.write(
        `[consolidate] 3B apply failed for ${leaf.documentId} (action=${decision.action}): ${err?.message || err}\n`,
      );
    }
  }
  report.ms += Date.now() - t0;
}

// Per-leaf finalize: archive every loser the cluster passes flagged. When
// Phase 3's LLM merge ran, candidates whose llmDecision.action==="skip" are
// LEFT ACTIVE; candidates with action==="merge"/"keep-keeper-unchanged"/
// "fallback" all archive the loser (the merge may have rewritten the
// keeper body first, but the archive of the loser is identical).
function finalizeMergeCandidates({ candidates, ctx, now, dryRun }) {
  if (!candidates.length) return;
  for (const cand of candidates) {
    const { keeper, loser, sourcePass } = cand;
    const report = ctx.report.get(sourcePass);
    // LLM said "skip" — leave both leaves active.
    if (cand.llmDecision?.action === "skip") continue;
    if (dryRun) {
      report.archived++;
      recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "archive", ok: true });
      continue;
    }
    try {
      // Re-read the loser right before mutating. If `frontmatter.updated`
      // changed since we queued the candidate, a concurrent write landed; skip
      // to avoid clobbering newer state. Same guard the plan calls out.
      const cur = readLeafForConsolidate({ documentId: loser.documentId });
      if (!cur || !cur.active) {
        report.skipped = true;
        recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "skip-vanished", ok: true });
        continue;
      }
      const beforeUpdated = String(loser.frontmatter?.updated || "");
      const curUpdated = String(cur.frontmatter?.updated || "");
      if (beforeUpdated && curUpdated && curUpdated !== beforeUpdated) {
        recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "skip-changed", ok: true });
        process.stderr.write(
          `[consolidate] skip-changed-under-pass: ${loser.documentId} ` +
            `(before=${beforeUpdated}, now=${curUpdated})\n`,
        );
        continue;
      }
      stampLeafMetadata(loser.documentId, {
        supersedes_id: keeper.documentId,
        consolidated_at: toIso(now),
      });
      disableDocument({ documentId: loser.documentId });
      report.archived++;
      recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "archive", ok: true });
    } catch (err) {
      report.errors++;
      recordEntity(report, { id: entityPairId(keeper, loser), kind: "dedup-pair", action: "archive", ok: false, error: err });
      process.stderr.write(
        `[consolidate] archive failed for ${loser.documentId} (${sourcePass}): ${err?.message || err}\n`,
      );
    }
  }
}

// ─── corpus passes ─────────────────────────────────────────────────────────

// 2E — flag stale leaves so the LLM-semantic-refresh pass (3B) can revisit
// them. UNIFORM across every refine-eligible category: a leaf is a
// candidate iff its atom_type is in STALENESS_ELIGIBLE_ATOM_TYPES
// (self-improvement-lesson / bug-root-cause / feedback-rule /
// pattern-gotcha). Category eligibility comes from the layout YAML
// (`consolidate: refine`); the atom-type filter is the within-category
// semantic. NO category-name string is hardcoded here — the layout owns
// "which trees" and atom_types own "which leaves within a tree".
//
// The deterministic flag flips both ways: stale when lastActivity > N
// months; un-flagged otherwise.
function stalenessFlag({ ctx, now, dryRun }) {
  const t0 = Date.now();
  const report = ctx.report.get("staleness-flag");
  const months = consolidateStaleAfterMonths();

  const candidates = [];
  for (const cat of ctx.refineCategories || []) {
    for (const leaf of listActiveLeavesForConsolidate({ category: cat })) {
      const atom = String(leaf.memory?.atom_type || "");
      if (STALENESS_ELIGIBLE_ATOM_TYPES.has(atom)) {
        candidates.push(leaf);
      }
    }
  }

  for (const leaf of candidates) {
    const m = leaf.memory || {};
    const last = m.last_recalled_at || leaf.frontmatter?.updated || null;
    const stale = ageInMonths(last, now) > months;
    if (stale && m.stale !== true) {
      if (!dryRun) stampLeafMetadata(leaf.documentId, { stale: true });
      report.touched++;
    } else if (!stale && m.stale === true) {
      if (!dryRun) stampLeafMetadata(leaf.documentId, { stale: false });
      report.touched++;
    }
  }
  report.ms += Date.now() - t0;
}

// 2F — archive orphan leaves: no inbound `[[link]]`, no non-index `parents:`,
// `frontmatter.updated` older than orphan TTL, never recalled.
//
// The INBOUND-LINK MAP is built across the WHOLE active wiki (every
// category): a knowledge leaf with one inbound from a plan still counts as
// linked even if `plans` is declared `consolidate: none`. Other categories
// can "save" a refine-eligible leaf from archival.
//
// The ORPHAN-ARCHIVAL DECISION is limited to refine-eligible categories
// (layout-declared `consolidate: refine`). A `consolidate: none` category
// is never mutated by this pass.
function pruneOrphanLeaves({ ctx, now, dryRun }) {
  const t0 = Date.now();
  const report = ctx.report.get("prune-orphan-leaves");
  const ttlDays = consolidateOrphanTtlDays();
  const refineSet = new Set(ctx.refineCategories || []);

  const allActive = [];
  for (const cat of getCategoryListSafe()) {
    allActive.push(...listActiveLeavesForConsolidate({ category: cat }));
  }
  const inbound = new Map();
  const linkRe = /\[\[([^\]]+)\]\]/g;
  for (const leaf of allActive) {
    let mm;
    linkRe.lastIndex = 0;
    while ((mm = linkRe.exec(leaf.text)) !== null) {
      const target = mm[1].trim();
      if (!target) continue;
      const set = inbound.get(target) || new Set();
      set.add(leaf.documentId);
      inbound.set(target, set);
    }
    const parents = Array.isArray(leaf.frontmatter?.parents)
      ? leaf.frontmatter.parents
      : [];
    for (const p of parents) {
      const pp = String(p || "").trim();
      if (!pp || pp === "index.md") continue;
      const set = inbound.get(pp) || new Set();
      set.add(leaf.documentId);
      inbound.set(pp, set);
    }
  }

  for (const leaf of allActive) {
    // Layout-eligibility guard: never archive a leaf in a non-refine category.
    const cat = String(leaf.documentId).split("/")[0];
    if (!refineSet.has(cat)) continue;
    const m = leaf.memory || {};
    if (ORPHAN_EXCLUDE_ATOM_TYPES.has(String(m.atom_type || ""))) continue;
    if (m.last_recalled_at) continue;
    if (ageInDays(leaf.frontmatter?.updated, now) <= ttlDays) continue;
    // Has inbound link via document id, leaf name, or frontmatter parent?
    const candidates = [leaf.documentId, leaf.name].filter(Boolean);
    let hasInbound = candidates.some((k) => {
      const set = inbound.get(k);
      return set && set.size > 0;
    });
    if (hasInbound) continue;
    // Last check: frontmatter.parents with a non-index entry counts as linked.
    const parents = Array.isArray(leaf.frontmatter?.parents)
      ? leaf.frontmatter.parents.map((p) => String(p || "").trim()).filter(Boolean)
      : [];
    if (parents.some((p) => p && p !== "index.md")) continue;
    if (dryRun) {
      report.archived++;
      continue;
    }
    try {
      stampLeafMetadata(leaf.documentId, { consolidated_at: toIso(now) });
      disableDocument({ documentId: leaf.documentId });
      ctx.touchedThisRun.add(leaf.documentId);
      report.archived++;
    } catch (err) {
      report.errors++;
      process.stderr.write(
        `[consolidate] orphan archive failed for ${leaf.documentId}: ${err?.message || err}\n`,
      );
    }
  }
  report.ms += Date.now() - t0;
}

// 2G — compress old archived bodies. Keeps the original sha256 in
// frontmatter as the recovery handle (truncateArchivedBody preserves it).
function compressArchived({ ctx, now, dryRun }) {
  const t0 = Date.now();
  const report = ctx.report.get("compress-archived");
  const max = consolidateArchiveBodyMax();
  const ageDays = consolidateArchiveAgeDays();
  // Limit body truncation to refine-eligible categories. A `consolidate: none`
  // category's archived leaves are kept verbatim (those trees are owned by
  // other lifecycles — plans/investigations/daily — and shouldn't have their
  // bodies rewritten by consolidate even when archived).
  const refineCats = new Set(ctx.refineCategories || []);
  for (const cat of getCategoryListSafe()) {
    if (!refineCats.has(cat)) continue;
    const { documents } = listDocuments({ datasetId: cat, enabled: false });
    for (const d of documents) {
      const leaf = readLeafForConsolidate({ documentId: d.id });
      if (!leaf) continue;
      const m = leaf.memory || {};
      if (m.status !== "archived") continue;
      if (m.consolidate_truncated_at) continue;
      if (String(leaf.text).length <= max) continue;
      if (ageInDays(leaf.frontmatter?.updated, now) <= ageDays) continue;
      if (dryRun) {
        report.touched++;
        continue;
      }
      try {
        const r = truncateArchivedBody({
          documentId: leaf.documentId,
          max,
          nowIso: toIso(now),
        });
        if (r?.ok) {
          report.touched++;
          report.freedBytes += Number(r.freedBytes) || 0;
        }
      } catch (err) {
        report.errors++;
        process.stderr.write(
          `[consolidate] compress failed for ${leaf.documentId}: ${err?.message || err}\n`,
        );
      }
    }
  }
  report.ms += Date.now() - t0;
}

// 2H — structural cleanup. Idempotent; cheap. Always runs last.
function pruneEmptyAncestorsCorpus({ ctx, dryRun }) {
  const t0 = Date.now();
  const report = ctx.report.get("prune-empty-ancestors");
  if (dryRun) {
    report.ms += Date.now() - t0;
    return;
  }
  const root = wikiRoot();
  for (const cat of getCategoryListSafe()) {
    const catDir = path.join(root, cat);
    if (!fs.existsSync(catDir)) continue;
    walkDirsDepthFirst(catDir, (dir) => {
      try {
        pruneEmptyAncestors(dir, root);
      } catch {
        /* best-effort */
      }
    });
  }
  report.ms += Date.now() - t0;
}

function pruneEmbeddingsCorpus({ ctx, dryRun }) {
  const t0 = Date.now();
  const report = ctx.report.get("prune-embeddings");
  try {
    // Respect MEMORY_GC_INTERVAL_DAYS (default 7d) — without `ifDue:true`
    // the daily consolidate cron would silently override the documented
    // weekly cadence for the embed-cache sweep. The SessionEnd embed-gc
    // hook and the hook-less skill rule already use ifDue:true; consolidate
    // is just one more caller and should align.
    const r = pruneEmbeddingCache({ ifDue: true, dryRun: Boolean(dryRun) });
    report.touched += Number(r?.removed) || 0;
  } catch (err) {
    report.errors++;
    process.stderr.write(
      `[consolidate] gc-embeddings failed: ${err?.message || err}\n`,
    );
  }
  report.ms += Date.now() - t0;
}

function indexRebuildCorpus({ ctx, dryRun }) {
  const t0 = Date.now();
  const report = ctx.report.get("index-rebuild");
  if (dryRun) {
    report.ms += Date.now() - t0;
    return;
  }
  // ensureIndexes expects LEAF paths and walks the ancestors up to wikiRoot
  // to refresh each ancestor's index.md. Passing the wiki root itself is a
  // no-op (no leaf), so we feed a single synthetic per category to refresh
  // category-root indexes. Per-leaf indexes were already refreshed by the
  // mutating passes that touched them; this is the corpus-wide closer.
  try {
    const root = wikiRoot();
    const synthetic = [];
    for (const cat of getCategoryListSafe()) {
      synthetic.push(path.join(root, cat, "__consolidate_synthetic__.md"));
    }
    if (synthetic.length) {
      ensureIndexes(root, synthetic);
      report.touched++;
    }
  } catch (err) {
    report.errors++;
    process.stderr.write(
      `[consolidate] index-rebuild best-effort failed: ${err?.message || err}\n`,
    );
  }
  report.ms += Date.now() - t0;
}

function getCategoryListSafe() {
  // Returns the layout-declared category list, or an empty array on error.
  // Empty-on-error is deliberate: with no category list, every category-
  // scoped pass becomes a no-op, which is the safe default. The orchestrator
  // also fails its layout-eligibility check earlier, so this path is rarely
  // reached at all. No fallback to a hardcoded historical default — layout
  // is the only source of truth for which trees exist.
  try {
    return getCategories();
  } catch {
    return [];
  }
}

function walkDirsDepthFirst(dir, cb) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    walkDirsDepthFirst(path.join(dir, e.name), cb);
  }
  cb(dir);
}

// ─── entry point ───────────────────────────────────────────────────────────

export async function consolidateMemory({
  dryRun = false,
  ifDue = false,
  force = false,
  llm = true,
  passes,
  now,
} = {}) {
  const startMs = Date.now();
  const allowed = resolveAllowedPasses(passes);

  // Resolve the LLM-requested flag up front so every return path can report
  // it consistently (success + skip). The actual ctx.llmEnabled (post-probe)
  // is set later, inside the maintenance frame.
  const llmRequested = consolidateLlmPassesEnabled() && llm !== false;

  // Layout must declare per-category eligibility. If any category lacks
  // `consolidate: refine|none`, refuse to run — author intent must be
  // explicit. The error envelope carries the missing category names so an
  // operator can fix the layout YAML and re-run.
  const layout = getConsolidateLayout();
  if (layout.missing.length > 0) {
    return {
      ok: false,
      error: "layout-missing-consolidate-field",
      message:
        "Each category in <wiki>/.layout/layout.yaml must declare `consolidate: refine` or `consolidate: none` — no default is applied. " +
        "Missing categories: " + layout.missing.join(", "),
      missing: layout.missing,
      llmRequested,
      llm: false,
    };
  }

  // Throttle. `ifDue` + last_run within the cadence => skip immediately.
  if (ifDue && !force) {
    const cadenceDays = consolidateIntervalDays();
    if (cadenceDays > 0) {
      const state = readState();
      const last = state?.last_run_utc ? Date.parse(state.last_run_utc) : 0;
      if (Number.isFinite(last) && last > 0) {
        const ageDays = (nowMs(now) - last) / (1000 * 60 * 60 * 24);
        if (ageDays < cadenceDays) {
          return {
            ok: true,
            skipped: "not-due",
            lastRunUtc: state.last_run_utc,
            cadenceDays,
            ageDays,
            llmRequested,
            llm: false,
          };
        }
      }
    }
  }

  // Lock. Share the compile lock so consolidate never races with compile and
  // both fit one shared LLM-API quota window.
  // Pass the SAME staleMs source compile.mjs uses: both contend on
  // COMPILE_LOCK_PATH, so a shared lock must have one authoritative TTL —
  // otherwise an operator who lowers compile.lockStaleMs leaves the two
  // processes disagreeing on when the lock is stale.
  const lock = acquireLock(COMPILE_LOCK_PATH, { staleMs: compileLockStaleMs(), label: "consolidate" });
  if (!lock.ok) {
    return {
      ok: false,
      skipped: "locked-by",
      reason: lock.reason,
      owner: lock.owner,
      llmRequested,
      llm: false,
    };
  }
  // Wire SIGTERM/SIGINT/SIGHUP/exit to release the lock so a killed cron
  // (or an MCP-server shutdown mid-run) doesn't leave it stale for 30 min.
  // installLockReleaseHandlers is idempotent across calls (compile.mjs may
  // have wired the same path); the lock module dedupes via its own set.
  installLockReleaseHandlers(COMPILE_LOCK_PATH);

  try {
    // One consolidate run = one wiki commit (dedup archives, merges,
    // refreshes, stale stamps). Nested INSIDE the maintenance frame's caller
    // so dry-run records nothing and commits nothing.
    return await withWikiCommit({ op: "consolidate", actor: "consolidate", noCommit: Boolean(dryRun) }, () =>
      withSystemMaintenance(async () => {
      const backend = activeBackend();
      const lexical = backend === "lexical";
      const cosineThreshold = lexical
        ? consolidateCosineLexicalThreshold()
        : consolidateCosineThreshold();
      // One-shot warning per run (moved out of the per-leaf cosine pass —
      // see review finding D-1: the per-leaf shallow-copied subCtx made
      // the previous in-pass flag fire on every leaf).
      if (lexical) {
        process.stderr.write(
          "[consolidate] embedding backend is lexical; cosine dedup threshold " +
            `auto-bumped to ${cosineThreshold} (real bge cosine inflates on the lexical fallback).\n`,
        );
      }
      // Band floor re-clamped against the ACTIVE threshold: the lexical
      // backend bumps the threshold to 0.995, and a floor that is no longer
      // strictly below it must disable the band (fail-safe OFF).
      const bandFloorRaw = consolidateCosineBandFloor();
      const cosineBandFloor =
        bandFloorRaw != null && bandFloorRaw >= 0.8 && bandFloorRaw < cosineThreshold
          ? bandFloorRaw
          : null;
      const ctx = {
        report: new Map(ALL_PASS_NAMES.map((n) => [n, emptyPassReport(n)])),
        touchedThisRun: new Set(),
        pairsSeen: new Set(),
        mergeCandidates: [], // accumulated across all leaves; finalized per leaf
        activeBackend: backend,
        cosineThreshold,
        cosineBandFloor,
        llmEnabled: false,
        refineCategories: layout.refine,
        excludedCategories: layout.excluded,
      };

      // Probe the LLM provider ONCE at the top of the run. If unreachable,
      // disable LLM passes for this run and log a single line — every
      // per-call probe would otherwise spam logs. `llmRequested` was
      // computed in the outer scope and is in closure here.
      if (llmRequested) {
        try {
          const h = await llmHealth();
          if (h?.available === true) {
            ctx.llmEnabled = true;
          } else {
            process.stderr.write(
              `[consolidate] event=llm-provider-unavailable provider=${h?.provider} reason="${h?.reason || ""}" — LLM passes skipped this run\n`,
            );
          }
        } catch (err) {
          process.stderr.write(
            `[consolidate] event=llm-provider-unavailable reason="probe-threw: ${err?.message || err}" — LLM passes skipped this run\n`,
          );
        }
      }

      const summary = await runConsolidate({ allowed, dryRun, llm: ctx.llmEnabled, now, ctx });
      sortPassEntities(ctx.report);

      const stateOut = {
        last_run_utc: toIso(now),
        durationMs: Date.now() - startMs,
        dryRun: Boolean(dryRun),
        // Counts only: the per-entity arrays travel via the returned report
        // (and the sharded full cron log), never the slim state file.
        passes: stripPassEntities(Object.fromEntries(ctx.report)),
        totals: summary.totals,
      };
      if (!dryRun) writeState(stateOut);
      return {
        ok: true,
        dryRun: Boolean(dryRun),
        llm: ctx.llmEnabled,
        llmRequested,
        ...summary,
        stateOut,
      };
    }));
  } finally {
    try {
      lock.release && lock.release();
    } catch {
      /* best-effort */
    }
  }
}

async function runConsolidate({ allowed, dryRun, llm, now, ctx }) {
  // Phase 2: search-driven cluster passes, per-leaf finalize, then corpus passes.

  // Empty allow-list: return immediately with zero totals. Without this short-
  // circuit the per-leaf loop would still walk the working set + run a
  // searchMemoryFiltered cluster lookup per leaf only to find every pass
  // gated-off — wasted compute (and embedding-cache reads) for no effect.
  if (allowed.size === 0) {
    const totals = { archived: 0, touched: 0, merged: 0, refreshed: 0, flagged: 0, errors: 0, freedBytes: 0 };
    return {
      passes: Object.fromEntries(ctx.report),
      totals,
      workingSetSize: 0,
    };
  }

  // Working set: every active leaf in the layout-declared `consolidate: refine`
  // categories. Stable documentId-ascending order for determinism.
  const refineCategories = ctx.refineCategories || [];
  const workingSet = [];
  for (const cat of refineCategories) {
    const leaves = listActiveLeavesForConsolidate({ category: cat });
    for (const l of leaves) workingSet.push({ ...l, category: cat });
  }
  workingSet.sort((a, b) => (a.documentId < b.documentId ? -1 : 1));

  for (const leaf of workingSet) {
    if (ctx.touchedThisRun.has(leaf.documentId)) continue; // already archived this run
    // Cluster: every similar leaf in the SAME category above the cluster score
    // threshold. The threshold is coarser than the dedupe threshold on purpose
    // so the LLM-refresh prompt (Phase 3B) sees enough surrounding context.
    let cluster;
    try {
      cluster = await searchMemoryFiltered({
        query: String(leaf.text).slice(0, 1024),
        datasetId: leaf.category,
        limit: consolidateClusterTopK(),
        scoreThreshold: consolidateClusterScoreThreshold(),
      });
    } catch (err) {
      ctx.report.get("dedupe-by-cosine").errors++;
      process.stderr.write(
        `[consolidate] cluster search failed for ${leaf.documentId}: ${err?.message || err}\n`,
      );
      continue;
    }

    // For passes that need full leaves (sha256, lesson-key), materialise the
    // cluster's members once. The cosine pass works off `cluster.records`
    // directly because the score IS the cosine.
    const clusterLeaves = [];
    for (const r of cluster.records) {
      if (r.documentId === leaf.documentId) continue;
      const cl = readLeafForConsolidate({ documentId: r.documentId });
      if (!cl) continue;
      cl.category = leaf.category;
      clusterLeaves.push(cl);
    }

    const localCandidates = [];
    const subCtx = { ...ctx, mergeCandidates: localCandidates };

    if (passEnabled("dedupe-by-sha256", allowed)) {
      dedupeBySha256({ leaf, clusterLeaves, ctx: subCtx, now });
    }
    if (passEnabled("dedupe-by-lesson-key", allowed)) {
      dedupeByLessonKey({ leaf, clusterLeaves, ctx: subCtx, now });
    }
    if (passEnabled("dedupe-by-cosine", allowed)) {
      dedupeByCosine({ leaf, cluster, ctx: subCtx, now });
    }

    // 3A — LLM merge runs BEFORE the deterministic finalize so it can
    // rewrite the keeper body. When the LLM provider is unavailable, ctx
    // .llmEnabled is false and this pass no-ops; finalize archives losers
    // unchanged. The candidates list carries each LLM decision so finalize
    // can honour "skip" (leave both active).
    if (
      ctx.llmEnabled &&
      passEnabled("llm-merge-near-duplicates", allowed) &&
      localCandidates.length > 0
    ) {
      await llmMergeNearDuplicates({ candidates: localCandidates, ctx, now, dryRun });
    }

    finalizeMergeCandidates({ candidates: localCandidates, ctx, now, dryRun });
  }

  // Corpus passes (run once, after the per-leaf loop). 3B llm-semantic-refresh
  // sits between the deterministic stalenessFlag (which marks candidates) and
  // the corpus cleanup that follows, so the refresh decision is the FIRST
  // thing acting on a freshly-flagged leaf.
  if (passEnabled("staleness-flag", allowed)) stalenessFlag({ ctx, now, dryRun });
  if (
    ctx.llmEnabled &&
    passEnabled("llm-semantic-refresh", allowed)
  ) {
    await llmSemanticRefresh({ ctx, now, dryRun });
  }
  if (passEnabled("prune-orphan-leaves", allowed)) pruneOrphanLeaves({ ctx, now, dryRun });
  if (passEnabled("compress-archived", allowed)) compressArchived({ ctx, now, dryRun });
  if (passEnabled("prune-empty-ancestors", allowed)) pruneEmptyAncestorsCorpus({ ctx, dryRun });
  if (passEnabled("prune-embeddings", allowed)) pruneEmbeddingsCorpus({ ctx, dryRun });
  if (passEnabled("index-rebuild", allowed)) indexRebuildCorpus({ ctx, dryRun });

  // Totals summary.
  const totals = { archived: 0, touched: 0, merged: 0, refreshed: 0, flagged: 0, errors: 0, freedBytes: 0 };
  for (const r of ctx.report.values()) {
    totals.archived += r.archived;
    totals.touched += r.touched;
    totals.merged += r.merged;
    totals.refreshed += r.refreshed;
    totals.flagged += r.flagged;
    totals.errors += r.errors;
    totals.freedBytes += r.freedBytes;
  }
  return {
    passes: Object.fromEntries(ctx.report),
    totals,
    workingSetSize: workingSet.length,
  };
}

// Exported helpers for tests.
export const _internals = {
  ALL_PASS_NAMES,
  resolveAllowedPasses,
  pickKeeper,
  lessonKey,
  ageInDays,
  ageInMonths,
  readState,
  writeState,
};

import { callJSON } from "./lib/llm-callJSON.mjs";
import { generateWithJudge } from "./lib/quality-loop.mjs";
import { forcedLessonUpdate } from "./compile-dedup.mjs";

/** @typedef {import("./lib/types.mjs").DistilledAtom} DistilledAtom */
/** @typedef {import("./lib/types.mjs").SearchHit} SearchHit */
/** @typedef {import("./compile-dedup.mjs").CompileDecision} CompileDecision */

/**
 * @param {DistilledAtom} atom
 * @param {SearchHit[]} candidates
 * @param {string} systemPrompt
 * @param {string} [recommendation] fed back by the quality judge on a rewrite round
 * @returns {Promise<CompileDecision>}
 */
export async function decideAction(atom, candidates, systemPrompt, recommendation = "") {
  const forced = forcedLessonUpdate(atom, candidates);
  if (forced) return forced;
  const userPrompt = [
    "NEW ATOM:",
    JSON.stringify(atom, null, 2),
    "",
    `EXISTING CANDIDATES (already filtered by atom_type=${atom.type} and matching metadata):`,
    candidates.length === 0
      ? "[]"
      : JSON.stringify(
          candidates.map((c) => ({
            documentId: c.documentId,
            documentName: c.documentName,
            score: c.score,
            content: String(c.content || "").slice(0, 800),
          })),
          null,
          2,
        ),
    ...(recommendation
      ? [
          "",
          "---",
          "A QUALITY JUDGE REJECTED YOUR PREVIOUS DECISION'S RESULTING LEAF. If this is an `update`, rewrite `merged_text` to address the feedback while preserving the durable facts. Do NOT discard a substantive atom to dodge the feedback — keep it and improve it:",
          recommendation,
        ]
      : []),
  ].join("\n");
  return /** @type {Promise<CompileDecision>} */ (
    callJSON(
      /** @type {{ systemPrompt: string, userPrompt: string, maxTokens: number, maxRetries?: number }} */ ({
        systemPrompt,
        userPrompt,
        maxTokens: 800,
      }),
    )
  );
}

// The content a decision would WRITE, for the quality judge. On `create` the
// body is the atom itself (authored upstream by flush), which the judge cannot
// have compile rewrite — so a failing create is judged, and since the
// regenerated body is identical each round the loop short-circuits and keeps it
// flagged (no wasted re-judging). On `update` the LLM-authored `merged_text` IS
// regenerable, so the judge's recommendation can steer a passing rewrite.
/**
 * @param {DistilledAtom} atom
 * @param {CompileDecision} decision
 * @returns {{ title: string, body: string }}
 */
function previewLeafContent(atom, decision) {
  if (decision.action === "update") {
    return {
      title: decision.merged_name || atom.title,
      body: String(decision.merged_text || "").trim() || String(atom.body || ""),
    };
  }
  return { title: String(atom.title || ""), body: String(atom.body || "") };
}

// decideAction wrapped in the judge-in-the-loop. Regenerates the decision (up to
// quality.maxRounds) until the would-be leaf passes the judge; a `skip` (or any
// non-writing decision) bypasses the judge; after the last failed round the best
// attempt is kept with `flagged:true` so the caller stamps it `quality:unverified`.
// FAIL-CLOSED: a judge/provider outage throws (LLMProviderUnavailable), which the
// per-atom caller already handles by keeping the daily enabled for a retry.
/**
 * @param {DistilledAtom} atom
 * @param {SearchHit[]} candidates
 * @param {string} systemPrompt
 * @param {string} targetDataset
 * @returns {Promise<{ decision: CompileDecision, flagged: boolean }>}
 */
export async function decideActionJudged(atom, candidates, systemPrompt, targetDataset) {
  const judged = await generateWithJudge({
    category: targetDataset,
    generate: async ({ recommendation }) => {
      const decision = await decideAction(atom, candidates, systemPrompt, recommendation);
      const judgeable =
        decision &&
        typeof decision === "object" &&
        (decision.action === "create" || decision.action === "update");
      if (!judgeable) {
        // A `skip` writes nothing, and a null/invalid decision must reach
        // processAtom's guard as-is (there it raises LLMOutputInvalid → the
        // daily is kept for a retry). Never coerce a null decision into a
        // legitimate skip, which would silently disable the daily.
        return { decision, __bypassJudge: true };
      }
      const { title, body } = previewLeafContent(atom, decision);
      return { decision, title, body };
    },
  });
  const candidate = /** @type {{ decision: CompileDecision }} */ (judged.candidate);
  return { decision: candidate.decision, flagged: Boolean(judged.flagged) };
}

// Interactive judge gate (JL5). The MCP write tools author no content themselves
// — the CLIENT LLM does — so the server cannot run the generate->judge->rewrite
// loop in-process (as compile/consolidate do). Instead it JUDGES the submission
// once and, on a fail, returns the verdict + recommendation WITHOUT writing; the
// discipline instructs the client to revise and resubmit (up to 3 attempts), then
// resubmit with `write.acceptQuality:true` to store the best attempt flagged
// `memory.quality:"unverified"`. FAIL-CLOSED: a judge/provider outage blocks the
// write (a clear retry error), never a silent drop.

import { jsonResponse } from "./mcp-responses.mjs";
import { judgeLeaf, JudgeUnavailable, isJudgeableCategory } from "../scripts/lib/quality-loop.mjs";
import { qualityJudgeEnabled } from "../scripts/lib/settings.mjs";

/**
 * @typedef {{ content: Array<{ type: "text", text: string }> }} ToolResponse
 * @typedef {{ block: false, flagged: boolean } | { block: true, response: ToolResponse }} JudgeGateResult
 */

/**
 * @param {{ dataset: string, title: string, body: string, acceptQuality?: boolean }} args
 * @returns {Promise<JudgeGateResult>}
 */
export async function judgeInteractiveSubmission({ dataset, title, body, acceptQuality }) {
  // Only the atomic curated categories are judged; structured/exempt categories
  // (plans/investigations/issues/daily/absorb) pass through — see quality-loop.mjs.
  if (!isJudgeableCategory(dataset) || !qualityJudgeEnabled()) {
    return { block: false, flagged: false };
  }
  let verdict;
  try {
    verdict = await judgeLeaf({ category: dataset, title, body });
  } catch (err) {
    if (err instanceof JudgeUnavailable) {
      return {
        block: true,
        response: jsonResponse({
          ok: false,
          error: "quality-judge-unavailable",
          message:
            "The quality judge could not run (no LLM provider available), so the write was blocked (fail-closed). Retry when a provider is reachable, or an operator may set quality.judgeEnabled:false to bypass the judge.",
        }),
      };
    }
    throw err;
  }
  if (verdict.pass) return { block: false, flagged: false };
  if (acceptQuality) return { block: false, flagged: true };
  return {
    block: true,
    response: jsonResponse({
      ok: false,
      error: "quality-judge-rejected",
      verdict,
      recommendation: verdict.recommendation,
      message:
        "The quality judge rejected this leaf. Revise it per `recommendation` and resubmit (up to 3 attempts). To store your best attempt anyway — flagged memory.quality:'unverified' — resubmit with write.acceptQuality:true.",
    }),
  };
}

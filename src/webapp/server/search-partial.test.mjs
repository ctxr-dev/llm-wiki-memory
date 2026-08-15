/**
 * The "your results are incomplete" advisory reached MCP clients and the CLI but NOT this app.
 *
 * searchWiki calls searchOneTree directly and destructures only `{ records }`, so it never went
 * through recall-search.mjs where the advisory is attached — and the route returns `{ results }`,
 * a different envelope entirely. A webapp user therefore saw a silently-truncated result set with
 * no indication, which is exactly the defect the MCP side just fixed.
 *
 * No engine change is needed: searchOneTree already accepts a `coldBudget`, so this end owns a
 * ledger the same way recall-search.mjs does and reads the shortfall off it afterwards.
 */

import { describe, it, expect } from "vitest";
import { SearchResultsSchema, ColdShortfallSchema } from "../shared/contract.mjs";

describe("the search envelope can carry a partial-results advisory", () => {
  it("accepts a response with no advisory (the normal, complete case)", () => {
    const parsed = SearchResultsSchema.parse({ results: [] });
    expect(parsed.partial).toBeUndefined();
  });

  it("accepts and PRESERVES an advisory", () => {
    const partial = {
      skippedLeaves: 9,
      embeddedTexts: 8,
      remedy: "Run `cli.mjs warm` to embed the corpus.",
    };
    const parsed = SearchResultsSchema.parse({ results: [], partial });
    /**
     * zod strips unknown keys, so without the schema field the advisory vanishes silently —
     * which is precisely why it was invisible in this app.
     */
    expect(parsed.partial).toEqual(partial);
  });

  it("rejects a malformed advisory rather than passing it through", () => {
    expect(() =>
      SearchResultsSchema.parse({ results: [], partial: { skippedLeaves: "nine" } }),
    ).toThrow();
  });

  it("the advisory shape matches what the engine emits", () => {
    /** Mirrors ColdShortfall in scripts/lib/types-records.mjs. */
    const fromEngine = { skippedLeaves: 3, embeddedTexts: 32, remedy: "…" };
    expect(() => ColdShortfallSchema.parse(fromEngine)).not.toThrow();
  });
});

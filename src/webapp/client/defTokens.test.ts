import { describe, test, expect } from "vitest";
import {
  DEF_TOKEN_ATTR,
  DEF_TOKEN_CLASS,
  DEF_TOKEN_PATTERN,
  defAnchorId,
  defTokenAnchor,
  findDefTokenMatches,
  hasDefTokenClass,
  headingDefToken,
  isDefToken,
  uniqueAnchorId,
} from "./defTokens";

const WHOLE_TOKEN_CASES: [string, boolean][] = [
  ["E1", true],
  ["A1", true],
  ["T12", true],
  ["ABC123", true],
  ["ABC7", true],
  ["ABCD1", false],
  ["A1234", false],
  ["a1", false],
  ["e1", false],
  ["E", false],
  ["1", false],
  ["", false],
  ["E1x", false],
  ["xE1", false],
  ["E1 E2", false],
  ["E-1", false],
  ["1E", false],
];

describe("isDefToken — the whole-string grammar gate", () => {
  test.each(WHOLE_TOKEN_CASES)("%s -> %s", (text, expected) => {
    expect(isDefToken(text)).toBe(expected);
  });
  test("surrounding whitespace is tolerated", () => {
    expect(isDefToken("  E1\n")).toBe(true);
  });
});

describe("findDefTokenMatches — occurrence scanning inside prose", () => {
  test("the real status-row prose yields both bounding tokens with their offsets", () => {
    const prose = "Escalated - needs an upstream owner (E1-E6)";
    expect(findDefTokenMatches(prose)).toEqual([
      { token: "E1", index: prose.indexOf("E1") },
      { token: "E6", index: prose.indexOf("E6") },
    ]);
  });
  test("tokens glued to letters or digits, over-long runs and lowercase are all rejected", () => {
    expect(findDefTokenMatches("ABCD1 A1234 a1 E1x xE1 ABC1234 12")).toEqual([]);
  });
  test("underscore counts as a word character, so an underscore-hugged token is not a match", () => {
    expect(findDefTokenMatches("_E1_")).toEqual([]);
  });
  test("punctuation and parentheses are boundaries", () => {
    expect(findDefTokenMatches("(T1), E1. ABC7;").map((match) => match.token)).toEqual([
      "T1",
      "E1",
      "ABC7",
    ]);
  });
  test("an empty string yields no matches", () => {
    expect(findDefTokenMatches("")).toEqual([]);
  });
  test("scanning twice returns the same matches (no shared regex cursor)", () => {
    expect(findDefTokenMatches("E1 and E2")).toEqual(findDefTokenMatches("E1 and E2"));
  });
  test("the exported grammar is the source of the scanner", () => {
    expect(new RegExp(DEF_TOKEN_PATTERN).test("E1")).toBe(true);
    expect(new RegExp(DEF_TOKEN_PATTERN).test("ABCD1")).toBe(false);
  });
});

const HEADING_CASES: [string, string | null][] = [
  ["T1 — Toolkit: ship netty >= 4.1.136.Final", "T1"],
  ["T1—Toolkit", "T1"],
  ["T1: Toolkit", "T1"],
  ["T1. Toolkit", "T1"],
  ["T1) Toolkit", "T1"],
  ["T1", "T1"],
  ["  E6 escalation", "E6"],
  ["ABC123 something", "ABC123"],
  ["3. Escalated", null],
  ["Escalated - needs an upstream owner (E1-E6)", null],
  ["T1-E6 range", null],
  ["T1x Toolkit", null],
  ["Toolkit T1", null],
  ["ABCD1 something", null],
  ["", null],
];

describe("headingDefToken — a heading defines only when the token leads it", () => {
  test.each(HEADING_CASES)("%s -> %s", (text, expected) => {
    expect(headingDefToken(text)).toBe(expected);
  });
});

describe("defAnchorId / uniqueAnchorId", () => {
  test("the anchor id is the lowercased token behind a def- prefix", () => {
    expect(defAnchorId("E1")).toBe("def-e1");
    expect(defAnchorId("ABC123")).toBe("def-abc123");
  });
  test("a free base id is used as-is", () => {
    expect(uniqueAnchorId("def-e1", new Set())).toBe("def-e1");
  });
  test("a taken base id gets the first free numeric suffix", () => {
    expect(uniqueAnchorId("def-e1", new Set(["def-e1"]))).toBe("def-e1-2");
    expect(uniqueAnchorId("def-e1", new Set(["def-e1", "def-e1-2"]))).toBe("def-e1-3");
  });
});

describe("defTokenAnchor — the node the plugin injects", () => {
  test("carries the in-page href, the stable class and the e2e data attribute", () => {
    expect(defTokenAnchor("E1", "def-e1")).toEqual({
      type: "element",
      tagName: "a",
      properties: {
        href: "#def-e1",
        className: [DEF_TOKEN_CLASS],
        [DEF_TOKEN_ATTR]: "E1",
      },
      children: [{ type: "text", value: "E1" }],
    });
  });
  test("points at a heading slug when that is the target id", () => {
    const anchor = defTokenAnchor("T1", "t1-toolkit");
    expect(anchor.properties?.href).toBe("#t1-toolkit");
  });
});

describe("hasDefTokenClass — how the renderer recognises the anchor", () => {
  test("matches the class alone or among others", () => {
    expect(hasDefTokenClass(DEF_TOKEN_CLASS)).toBe(true);
    expect(hasDefTokenClass(`prose ${DEF_TOKEN_CLASS} extra`)).toBe(true);
  });
  test("rejects undefined, empty and partial matches", () => {
    expect(hasDefTokenClass(undefined)).toBe(false);
    expect(hasDefTokenClass("")).toBe(false);
    expect(hasDefTokenClass(`${DEF_TOKEN_CLASS}x`)).toBe(false);
    expect(hasDefTokenClass("wiki-ref")).toBe(false);
  });
});

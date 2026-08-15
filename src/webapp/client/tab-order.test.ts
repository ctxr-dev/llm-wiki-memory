import { describe, test, expect } from "vitest";
import { reorder, orderWithPins, replaceTabId } from "./tab-order";

describe("reorder", () => {
  test("moves an item forward, shifting the rest", () =>
    expect(reorder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]));
  test("moves an item backward", () =>
    expect(reorder(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]));
  test("first to last and last to first", () => {
    expect(reorder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  test("from === to is a no-op (same reference)", () => {
    const list = ["a", "b", "c"];
    expect(reorder(list, 1, 1)).toBe(list);
  });
  test("out-of-bounds indices return the list unchanged", () => {
    const list = ["a", "b"];
    expect(reorder(list, -1, 0)).toBe(list);
    expect(reorder(list, 0, 5)).toBe(list);
    expect(reorder(list, 9, 0)).toBe(list);
  });
});

describe("replaceTabId", () => {
  test("swaps a stale id for the resolved one, in place", () =>
    expect(replaceTabId(["a", "stale", "c"], "stale", "real")).toEqual(["a", "real", "c"]));
  test("the resolved id already open collapses to one entry at the earlier position", () => {
    expect(replaceTabId(["real", "b", "stale"], "stale", "real")).toEqual(["real", "b"]);
    expect(replaceTabId(["stale", "b", "real"], "stale", "real")).toEqual(["real", "b"]);
  });
  test("adjacent duplicates collapse too", () =>
    expect(replaceTabId(["stale", "real"], "stale", "real")).toEqual(["real"]));
  test("from === to is a no-op (same reference)", () => {
    const list = ["a", "b"];
    expect(replaceTabId(list, "a", "a")).toBe(list);
  });
  test("a stale id absent from the list is a no-op (same reference)", () => {
    const list = ["a", "b"];
    expect(replaceTabId(list, "zz", "real")).toBe(list);
    expect(replaceTabId([], "zz", "real")).toEqual([]);
  });
  test("only the matching id changes; every other entry keeps its identity and order", () =>
    expect(replaceTabId(["x", "stale", "y", "z"], "stale", "real")).toEqual([
      "x",
      "real",
      "y",
      "z",
    ]));
  test("a repeated stale id collapses into a single resolved entry", () =>
    expect(replaceTabId(["stale", "b", "stale"], "stale", "real")).toEqual(["real", "b"]));
  test("the input list is never mutated", () => {
    const list = ["a", "stale"];
    replaceTabId(list, "stale", "real");
    expect(list).toEqual(["a", "stale"]);
  });
  test("the result is stable under a second application (converges)", () => {
    const once = replaceTabId(["a", "stale"], "stale", "real");
    expect(replaceTabId(once, "real", "real")).toBe(once);
  });
});

describe("orderWithPins", () => {
  test("pinned tabs come first, preserving their in-list order", () =>
    expect(orderWithPins(["a", "b", "c", "d"], ["c", "a"])).toEqual(["a", "c", "b", "d"]));
  test("no pins returns the list unchanged in order", () =>
    expect(orderWithPins(["a", "b", "c"], [])).toEqual(["a", "b", "c"]));
  test("a pinned id absent from the tabs is ignored", () =>
    expect(orderWithPins(["a", "b"], ["z", "b"])).toEqual(["b", "a"]));
  test("all pinned keeps the original order", () =>
    expect(orderWithPins(["a", "b", "c"], ["a", "b", "c"])).toEqual(["a", "b", "c"]));
});

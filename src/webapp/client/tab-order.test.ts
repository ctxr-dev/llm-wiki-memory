import { describe, test, expect } from "vitest";
import { reorder, orderWithPins } from "./tab-order";

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

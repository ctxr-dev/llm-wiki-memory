import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { anchorTargetId, cancelDefinitionFlash, flashDefinition, scrollToAnchor } from "./defFlash";
import { DEF_TOKEN_FLASH_CLASS, DEF_TOKEN_FLASH_MS } from "./defTokens";

function definition(id: string, tag = "strong"): HTMLElement {
  const element = document.createElement(tag);
  element.id = id;
  element.textContent = id.toUpperCase();
  document.body.append(element);
  return element;
}

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  document.body.replaceChildren();
});

afterEach(() => {
  cancelDefinitionFlash();
  vi.useRealTimers();
});

describe("anchorTargetId", () => {
  test("reads the id out of a fragment href", () =>
    expect(anchorTargetId("#def-e1")).toBe("def-e1"));
  test("decodes a percent-encoded fragment", () =>
    expect(anchorTargetId("#caf%C3%A9")).toBe("café"));
  test("falls back to the raw fragment when the escape is malformed", () =>
    expect(anchorTargetId("#%E0%A4%A")).toBe("%E0%A4%A"));
  test("rejects a non-fragment or missing href", () => {
    expect(anchorTargetId("http://example.com/x")).toBe("");
    expect(anchorTargetId(undefined)).toBe("");
  });
});

describe("scrollToAnchor", () => {
  test("scrolls the target into view and hands it focus", () => {
    const target = definition("def-e1");
    expect(scrollToAnchor("def-e1")).toBe(target);
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(target.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(target);
  });

  test("leaves a natively focusable target's tab order alone", () => {
    const target = definition("def-e2", "button");
    scrollToAnchor("def-e2");
    expect(target.getAttribute("tabindex")).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  test("keeps an author-provided tabindex", () => {
    const target = definition("def-e3");
    target.setAttribute("tabindex", "0");
    scrollToAnchor("def-e3");
    expect(target.getAttribute("tabindex")).toBe("0");
  });

  test("an unknown or empty target id is a no-op", () => {
    expect(scrollToAnchor("missing")).toBeNull();
    expect(scrollToAnchor("")).toBeNull();
  });
});

describe("flashDefinition", () => {
  test("highlights the target and clears the highlight after the flash window", () => {
    const target = definition("def-e1");
    flashDefinition("def-e1");
    expect(target.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(true);
    vi.advanceTimersByTime(DEF_TOKEN_FLASH_MS - 1);
    expect(target.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(target.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(false);
  });

  test("a repeat jump replays the animation and restarts the flash window", () => {
    const target = definition("def-e1");
    flashDefinition("def-e1");
    vi.advanceTimersByTime(DEF_TOKEN_FLASH_MS - 100);
    const classChanges: string[] = [];
    const record = (change: string) => (token: string) => classChanges.push(`${change} ${token}`);
    const removeSpy = vi.spyOn(target.classList, "remove").mockImplementation(record("remove"));
    const addSpy = vi.spyOn(target.classList, "add").mockImplementation(record("add"));
    flashDefinition("def-e1");
    removeSpy.mockRestore();
    addSpy.mockRestore();
    expect(classChanges.slice(-2)).toEqual([
      `remove ${DEF_TOKEN_FLASH_CLASS}`,
      `add ${DEF_TOKEN_FLASH_CLASS}`,
    ]);
    vi.advanceTimersByTime(DEF_TOKEN_FLASH_MS - 1);
    expect(target.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(target.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(false);
  });

  test("a jump to another definition never leaves the previous one highlighted", () => {
    const first = definition("def-e1");
    const second = definition("def-e2");
    flashDefinition("def-e1");
    flashDefinition("def-e2");
    expect(first.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(false);
    expect(second.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(true);
  });

  test("cancelling clears the highlight and the pending timer", () => {
    const target = definition("def-e1");
    flashDefinition("def-e1");
    cancelDefinitionFlash();
    expect(target.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(false);
    target.classList.add(DEF_TOKEN_FLASH_CLASS);
    vi.advanceTimersByTime(DEF_TOKEN_FLASH_MS * 2);
    expect(target.classList.contains(DEF_TOKEN_FLASH_CLASS)).toBe(true);
  });

  test("cancelling with nothing pending is safe, and a missing target flashes nothing", () => {
    expect(() => cancelDefinitionFlash()).not.toThrow();
    expect(() => flashDefinition("missing")).not.toThrow();
  });
});

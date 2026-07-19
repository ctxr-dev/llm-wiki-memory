import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { currentTheme, setTheme, applyTheme } from "./theme";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
  document.documentElement.classList.remove("dark");
});

afterEach(() => vi.unstubAllGlobals());

test("currentTheme reads a stored preference", () => {
  setTheme("dark");
  expect(currentTheme()).toBe("dark");
  setTheme("light");
  expect(currentTheme()).toBe("light");
});

test("applyTheme toggles the dark class on the document element", () => {
  applyTheme("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  applyTheme("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

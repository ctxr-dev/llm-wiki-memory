import { act } from "@testing-library/react";

/**
 * Install a controllable `matchMedia` and hand back a way to cross the breakpoint.
 *
 * jsdom has no media queries at all, so any component whose layout depends on
 * viewport width is untestable without this. `cross` fires the same `change`
 * event a real browser would, wrapped in `act` so React has flushed by the time
 * the assertion runs.
 *
 * Shared by the CollapsibleColumn suites rather than copied into each: the two
 * files test opposite halves of one contract (width-driven versus remembered),
 * and a drifting copy of the stub would make them disagree about what a
 * breakpoint crossing even is.
 */
export function mockMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: "",
    onchange: null,
    addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: () => mql });
  return {
    cross(next: boolean) {
      act(() => {
        mql.matches = next;
        listeners.forEach((cb) => cb({ matches: next } as MediaQueryListEvent));
      });
    },
  };
}

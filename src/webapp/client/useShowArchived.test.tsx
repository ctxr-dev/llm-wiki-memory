import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { api } from "./api";
import { useShowArchived } from "./useShowArchived";

vi.mock("./api", () => ({ api: { getPref: vi.fn(), setPref: vi.fn() } }));

const getPref = vi.mocked(api.getPref);
const setPref = vi.mocked(api.setPref);

beforeEach(() => {
  getPref.mockReset();
  setPref.mockReset();
  setPref.mockResolvedValue(undefined as never);
});
afterEach(() => cleanup());

test("loads the per-wiki pref and reads '1' as true", async () => {
  getPref.mockResolvedValue("1");
  const { result } = renderHook(() => useShowArchived("w1"));
  await waitFor(() => expect(result.current.showArchived).toBe(true));
  expect(getPref).toHaveBeenCalledWith("w1", "showArchived");
});

test("setShowArchived updates state and persists '1'", async () => {
  getPref.mockResolvedValue("0");
  const { result } = renderHook(() => useShowArchived("w1"));
  await waitFor(() => expect(result.current.showArchived).toBe(false));
  act(() => result.current.setShowArchived(true));
  expect(result.current.showArchived).toBe(true);
  expect(setPref).toHaveBeenCalledWith("w1", "showArchived", "1");
});

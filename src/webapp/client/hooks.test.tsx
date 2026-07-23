import { test, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

vi.mock("./api", () => ({ api: { titles: vi.fn() } }));
import { api } from "./api";
import { useTitles } from "./hooks";

test("useTitles keeps the previous titles while the next batch loads (no flicker)", async () => {
  let resolveSecond: (value: Record<string, string>) => void = () => undefined;
  vi.mocked(api.titles)
    .mockResolvedValueOnce({ a: "Alpha" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

  const { result, rerender } = renderHook(({ ids }) => useTitles("w", ids), {
    wrapper: Wrapper,
    initialProps: { ids: ["a"] },
  });

  await waitFor(() => expect(result.current.data).toEqual({ a: "Alpha" }));

  rerender({ ids: ["a", "b"] });
  expect(result.current.data).toEqual({ a: "Alpha" });
  expect(result.current.isPlaceholderData).toBe(true);

  resolveSecond({ a: "Alpha", b: "Beta" });
  await waitFor(() => expect(result.current.data).toEqual({ a: "Alpha", b: "Beta" }));
});

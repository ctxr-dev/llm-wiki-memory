import { test, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

vi.mock("./api", () => ({ api: { titles: vi.fn(), related: vi.fn() } }));
import { api } from "./api";
import { useTitles, useRelated } from "./hooks";

type Titles = Record<string, { title: string; active: boolean }>;
type Related = Awaited<ReturnType<typeof api.related>>;

test("useTitles keeps the previous titles while the next batch loads (no flicker)", async () => {
  const alpha: Titles = { a: { title: "Alpha", active: true } };
  const both: Titles = { a: { title: "Alpha", active: true }, b: { title: "Beta", active: false } };
  let resolveSecond: (value: Titles) => void = () => undefined;
  vi.mocked(api.titles)
    .mockResolvedValueOnce(alpha)
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

  await waitFor(() => expect(result.current.data).toEqual(alpha));

  rerender({ ids: ["a", "b"] });
  expect(result.current.data).toEqual(alpha);
  expect(result.current.isPlaceholderData).toBe(true);

  resolveSecond(both);
  await waitFor(() => expect(result.current.data).toEqual(both));
});

test("useRelated keeps the previous related list while the next doc's loads (no flicker)", async () => {
  const first = [{ id: "a-rel" }] as unknown as Related;
  const second = [{ id: "b-rel" }] as unknown as Related;
  let resolveSecond: () => void = () => undefined;
  vi.mocked(api.related)
    .mockResolvedValueOnce(first)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = () => resolve(second);
        }),
    );

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

  const { result, rerender } = renderHook(({ docId }) => useRelated("w", docId, false), {
    wrapper: Wrapper,
    initialProps: { docId: "a" },
  });

  await waitFor(() => expect(result.current.data).toEqual(first));

  rerender({ docId: "b" });
  expect(result.current.data).toEqual(first);
  expect(result.current.isPlaceholderData).toBe(true);

  resolveSecond();
  await waitFor(() => expect(result.current.data).toEqual(second));
});

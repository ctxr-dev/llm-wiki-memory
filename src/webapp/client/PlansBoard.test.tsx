import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PlansBoard } from "./PlansBoard";

const respond = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response);

afterEach(() => vi.unstubAllGlobals());

test("renders plan cards in lifecycle columns; a click opens the doc", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      respond({
        columns: [
          { key: "pending", cards: [] },
          {
            key: "in-progress",
            cards: [
              {
                id: "plans/a.md",
                name: "a.md",
                title: "Plan A",
                status: "in-progress",
                progress: "2/5",
                active: true,
              },
            ],
          },
          { key: "done", cards: [] },
          { key: "archived", cards: [] },
        ],
      }),
    ),
  );
  const onOpen = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PlansBoard wikiId="w1" onOpen={onOpen} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText("Plan A")).toBeTruthy());
  expect(screen.getByText("2/5")).toBeTruthy();
  fireEvent.click(screen.getByText("Plan A"));
  expect(onOpen).toHaveBeenCalledWith("plans/a.md");
});

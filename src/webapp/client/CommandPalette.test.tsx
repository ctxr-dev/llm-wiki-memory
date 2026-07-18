import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandPalette } from "./CommandPalette";

const respond = (body: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response);

function stubFetch(map: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      const key = Object.keys(map).find((candidate) => url.includes(candidate));
      return respond(key ? map[key] : {});
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

function renderPalette(onOpenDoc = vi.fn(), onSwitchWiki = vi.fn(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CommandPalette
        wikiId="w1"
        onOpenDoc={onOpenDoc}
        onSwitchWiki={onSwitchWiki}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onOpenDoc, onSwitchWiki, onClose };
}

test("typing a query shows ranked results; clicking opens the doc and closes", async () => {
  stubFetch({
    "/search": {
      results: [
        { id: "knowledge/a.md", name: "a.md", category: "knowledge", score: 0.9, snippet: "kafka" },
      ],
    },
    "/api/wikis": { wikis: [] },
  });
  const { onOpenDoc, onClose } = renderPalette();
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), { target: { value: "kafka" } });
  await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
  fireEvent.click(screen.getByText("a.md"));
  expect(onOpenDoc).toHaveBeenCalledWith("knowledge/a.md");
  expect(onClose).toHaveBeenCalled();
});

test("with an empty query it lists wikis to switch to", async () => {
  stubFetch({
    "/api/wikis": {
      wikis: [
        {
          id: "w2",
          kind: "added",
          root: "/r",
          mountDir: "/m",
          projectModule: "repo",
          ownership: "repo",
          label: "My Repo",
          categories: [],
        },
      ],
    },
  });
  const { onSwitchWiki, onClose } = renderPalette();
  await waitFor(() => expect(screen.getByText("My Repo")).toBeTruthy());
  fireEvent.click(screen.getByText("My Repo"));
  expect(onSwitchWiki).toHaveBeenCalledWith("w2");
  expect(onClose).toHaveBeenCalled();
});

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

const RESULT = {
  id: "knowledge/a.md",
  name: "a.md",
  title: "Alpha Decision",
  location: "Knowledge › Backend › Decision",
  category: "knowledge",
  score: 0.9,
  snippet: "kafka",
};

test("typing a query shows titled results with location; clicking opens the doc and closes", async () => {
  stubFetch({ "/search": { results: [RESULT] }, "/api/wikis": { wikis: [] } });
  const { onOpenDoc, onClose } = renderPalette();
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), { target: { value: "kafka" } });
  await waitFor(() => expect(screen.getByText("Alpha Decision")).toBeTruthy());
  expect(screen.getByText(/Knowledge › Backend › Decision/)).toBeTruthy();
  fireEvent.click(screen.getByText("Alpha Decision"));
  expect(onOpenDoc).toHaveBeenCalledWith("knowledge/a.md");
  expect(onClose).toHaveBeenCalled();
});

test("an initial facet filter searches with no free text and is removable", async () => {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/search")) return respond({ results: [RESULT] });
      return respond({ wikis: [] });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CommandPalette
        wikiId="w1"
        onOpenDoc={vi.fn()}
        onSwitchWiki={vi.fn()}
        onClose={vi.fn()}
        initialFilters={[{ key: "area", value: "backend" }]}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText("area: backend")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("Alpha Decision")).toBeTruthy());
  expect(requested.some((url) => url.includes("area=backend"))).toBe(true);
  fireEvent.click(screen.getByLabelText("remove area: backend"));
  expect(screen.queryByText("area: backend")).toBeNull();
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

test("the active wiki is excluded from the empty-query switch list", async () => {
  stubFetch({
    "/api/wikis": {
      wikis: [
        {
          id: "w1",
          kind: "home",
          root: "/r",
          mountDir: "/m",
          projectModule: "home",
          ownership: "wiki",
          label: "Home",
          categories: [],
        },
      ],
    },
  });
  renderPalette();
  await waitFor(() => expect(screen.getByText(/Type to search/)).toBeTruthy());
  expect(screen.queryByText(/Switch to/)).toBeNull();
});

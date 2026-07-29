import { test, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommandPalette } from "./CommandPalette";
import { SearchResultSchema } from "../shared/contract.mjs";

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
  active: true,
};

beforeAll(() => {
  SearchResultSchema.parse(RESULT);
});

test("focuses the search input on open", () => {
  stubFetch({ "/api/wikis": { wikis: [] } });
  renderPalette();
  expect(screen.getByPlaceholderText(/Search or jump/)).toBe(document.activeElement);
});

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

test("an archived result shows an archive icon and a colored priority tag", async () => {
  const archived = { ...RESULT, id: "knowledge/z.md", title: "Retired Note", active: false, priority: "P0" };
  stubFetch({ "/search": { results: [archived] }, "/api/wikis": { wikis: [] } });
  renderPalette();
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), { target: { value: "kafka" } });
  await waitFor(() => expect(screen.getByText("Retired Note")).toBeTruthy());
  expect(screen.getByLabelText("archived")).toBeTruthy();
  expect(screen.getByText("P0").className).toContain("bg-red-100");
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
  expect(screen.getByText("Area: backend")).toBeTruthy();
  await waitFor(() => expect(screen.getByText("Alpha Decision")).toBeTruthy());
  expect(requested.some((url) => url.includes("area=backend"))).toBe(true);
  fireEvent.click(screen.getByLabelText("remove Area: backend"));
  expect(screen.queryByText("Area: backend")).toBeNull();
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

test("a query that matches nothing shows the 'No results.' empty state", async () => {
  stubFetch({ "/search": { results: [] }, "/api/wikis": { wikis: [] } });
  renderPalette();
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), { target: { value: "nomatch" } });
  await waitFor(() => expect(screen.getByText("No results.")).toBeTruthy());
});

test("ArrowDown then Enter opens the second result", async () => {
  const second = { ...RESULT, id: "knowledge/b.md", name: "b.md", title: "Beta Decision" };
  stubFetch({ "/search": { results: [RESULT, second] }, "/api/wikis": { wikis: [] } });
  const { onOpenDoc, onClose } = renderPalette();
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), { target: { value: "d" } });
  await waitFor(() => expect(screen.getByText("Beta Decision")).toBeTruthy());
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "ArrowDown" });
  fireEvent.keyDown(dialog, { key: "Enter" });
  expect(onOpenDoc).toHaveBeenCalledWith("knowledge/b.md");
  expect(onClose).toHaveBeenCalled();
});

test("toggling scope re-issues the search against all wikis", async () => {
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
  renderPalette();
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), { target: { value: "kafka" } });
  await waitFor(() => expect(screen.getByText("Alpha Decision")).toBeTruthy());
  fireEvent.click(screen.getByText("this wiki"));
  await waitFor(() => expect(requested.some((url) => url.includes("scope=all"))).toBe(true));
});

test("clicking a result that belongs to another wiki switches wikis instead of opening it", async () => {
  const cross = {
    ...RESULT,
    id: "knowledge/x.md",
    title: "Cross-Wiki Hit",
    wikiId: "w2",
    wikiLabel: "Other Wiki",
  };
  stubFetch({ "/search": { results: [cross] }, "/api/wikis": { wikis: [] } });
  const { onOpenDoc, onSwitchWiki, onClose } = renderPalette();
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), {
    target: { value: "database" },
  });
  await waitFor(() => expect(screen.getByText("Cross-Wiki Hit")).toBeTruthy());
  fireEvent.click(screen.getByText("Cross-Wiki Hit"));
  expect(onSwitchWiki).toHaveBeenCalledWith("w2");
  expect(onOpenDoc).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

test("an initial category chip constrains the search and is removable", async () => {
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
        initialCategory="knowledge"
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Category: knowledge")).toBeTruthy();
  await waitFor(() =>
    expect(requested.some((url) => url.includes("category=knowledge"))).toBe(true),
  );
  fireEvent.click(screen.getByLabelText("remove Category: knowledge"));
  expect(screen.queryByText("Category: knowledge")).toBeNull();
});

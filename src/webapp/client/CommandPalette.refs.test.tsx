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

const homeWiki = {
  id: "w1",
  kind: "home",
  root: "/ws/.llm-wiki-memory/wiki",
  mountDir: "/ws",
  projectModule: "ws-module",
  ownership: "wiki",
  label: "Main Brain",
  categories: ["knowledge"],
};
const repoWiki = {
  id: "w2",
  kind: "added",
  root: "/ws/repos/widget/.llm-wiki-memory/wiki",
  mountDir: "/ws/repos/widget",
  projectModule: "acme/widget",
  ownership: "repo",
  label: "Widget",
  categories: ["knowledge"],
};

function renderWithRef(
  onOpenRef: ((wikiId: string, docId: string) => void) | undefined,
  extra = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = { onOpenDoc: vi.fn(), onSwitchWiki: vi.fn(), onClose: vi.fn(), ...extra };
  render(
    <QueryClientProvider client={client}>
      <CommandPalette wikiId="w1" onOpenRef={onOpenRef} {...props} />
    </QueryClientProvider>,
  );
  return props as { onOpenDoc: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> };
}

test("pasting a valid reference pins a distinct Reference row and opens it via onOpenRef", async () => {
  stubFetch({ "/search": { results: [] }, "/api/wikis": { wikis: [homeWiki, repoWiki] } });
  const onOpenRef = vi.fn();
  renderWithRef(onOpenRef);
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), {
    target: { value: "brain:knowledge/a.md" },
  });
  await waitFor(() => expect(screen.getByText("Reference")).toBeTruthy());
  fireEvent.click(screen.getByText("knowledge/a.md"));
  expect(onOpenRef).toHaveBeenCalledWith("w1", "knowledge/a.md");
});

test("a cross-wiki reference resolves to the other wiki's id", async () => {
  stubFetch({ "/search": { results: [] }, "/api/wikis": { wikis: [homeWiki, repoWiki] } });
  const onOpenRef = vi.fn();
  renderWithRef(onOpenRef);
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), {
    target: { value: "acme/widget:knowledge/x.md" },
  });
  await waitFor(() => expect(screen.getByText("Reference")).toBeTruthy());
  fireEvent.click(screen.getByText("knowledge/x.md"));
  expect(onOpenRef).toHaveBeenCalledWith("w2", "knowledge/x.md");
});

test("a non-reference query shows no Reference row and falls through to fuzzy search", async () => {
  stubFetch({ "/search": { results: [RESULT] }, "/api/wikis": { wikis: [homeWiki, repoWiki] } });
  renderWithRef(vi.fn());
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), { target: { value: "kafka" } });
  await waitFor(() => expect(screen.getByText("Alpha Decision")).toBeTruthy());
  expect(screen.queryByText("Reference")).toBeNull();
});

test("without onOpenRef, a same-wiki reference falls back to onOpenDoc", async () => {
  stubFetch({ "/search": { results: [] }, "/api/wikis": { wikis: [homeWiki, repoWiki] } });
  const { onOpenDoc, onClose } = renderWithRef(undefined);
  fireEvent.change(screen.getByPlaceholderText(/Search or jump/), {
    target: { value: "brain:knowledge/a.md" },
  });
  await waitFor(() => expect(screen.getByText("Reference")).toBeTruthy());
  fireEvent.click(screen.getByText("knowledge/a.md"));
  expect(onOpenDoc).toHaveBeenCalledWith("knowledge/a.md");
  expect(onClose).toHaveBeenCalled();
});

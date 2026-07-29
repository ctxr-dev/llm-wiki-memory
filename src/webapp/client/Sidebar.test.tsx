import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "./Sidebar";

const HOME = {
  id: "home1",
  kind: "home",
  root: "/r",
  mountDir: "/home",
  projectModule: "brain",
  ownership: "wiki",
  label: "Brain",
  categories: ["knowledge"],
};
const ADDED = {
  id: "repo1",
  kind: "added",
  root: "/rr",
  mountDir: "/repo",
  projectModule: "repo",
  ownership: "repo",
  label: "Repo",
  categories: ["shared_notes"],
};

const respond = (ok: boolean, status: number, body: unknown) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as unknown as Response);

function renderSidebar(fetchImpl: typeof fetch, onSelect = vi.fn()) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Sidebar activeId="home1" onSelect={onSelect} />
    </QueryClientProvider>,
  );
  return { onSelect };
}

afterEach(() => vi.unstubAllGlobals());

test("shows a brain-chip icon for the home wiki and a git icon for a repo wiki", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/wikis") return respond(true, 200, { wikis: [HOME, ADDED] });
      return respond(true, 200, {});
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <Sidebar activeId="home1" onSelect={vi.fn()} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText("Repo")).toBeTruthy());
  expect(container.querySelector('[data-icon="brain"]')).toBeTruthy();
  expect(container.querySelector('[data-icon="git"]')).toBeTruthy();
});

test("adds a wiki through the folder input and shows it", async () => {
  let added = false;
  renderSidebar((input, init) => {
    const url = String(input);
    if (url === "/api/wikis" && init?.method === "POST") {
      added = true;
      return respond(true, 200, { wiki: ADDED });
    }
    if (url === "/api/wikis") return respond(true, 200, { wikis: added ? [HOME, ADDED] : [HOME] });
    return respond(true, 200, {});
  });
  await waitFor(() => expect(screen.getByText("Brain")).toBeTruthy());
  fireEvent.click(screen.getByText("Add wiki"));
  fireEvent.change(screen.getByPlaceholderText(/absolute\/path/), { target: { value: "/repo" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(screen.getByText("Repo")).toBeTruthy());
});

test("shows a friendly error when the folder is not a wiki", async () => {
  renderSidebar((input, init) => {
    const url = String(input);
    if (url === "/api/wikis" && init?.method === "POST")
      return respond(false, 422, { error: "not-a-wiki" });
    if (url === "/api/wikis") return respond(true, 200, { wikis: [HOME] });
    return respond(true, 200, {});
  });
  await waitFor(() => expect(screen.getByText("Brain")).toBeTruthy());
  fireEvent.click(screen.getByText("Add wiki"));
  fireEvent.change(screen.getByPlaceholderText(/absolute\/path/), { target: { value: "/nope" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(screen.getByText(/No .llm-wiki-memory found/)).toBeTruthy());
});

test("removes an added wiki via right-click after confirming; home has no menu", async () => {
  let removed = false;
  renderSidebar((input, init) => {
    const url = String(input);
    if (url.startsWith("/api/wikis/") && init?.method === "DELETE") {
      removed = true;
      return respond(true, 200, { ok: true });
    }
    if (url === "/api/wikis")
      return respond(true, 200, { wikis: removed ? [HOME] : [HOME, ADDED] });
    return respond(true, 200, {});
  });
  await waitFor(() => expect(screen.getByText("Repo")).toBeTruthy());
  fireEvent.contextMenu(screen.getByText("Brain"));
  expect(screen.queryByRole("menu", { name: "wiki actions" })).toBeNull();
  fireEvent.contextMenu(screen.getByText("Repo"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await waitFor(() => expect(screen.queryByText("Repo")).toBeNull());
});

test("canceling the remove confirmation keeps the wiki (no DELETE)", async () => {
  const del = vi.fn();
  renderSidebar((input, init) => {
    const url = String(input);
    if (url.startsWith("/api/wikis/") && init?.method === "DELETE") {
      del();
      return respond(true, 200, { ok: true });
    }
    if (url === "/api/wikis") return respond(true, 200, { wikis: [HOME, ADDED] });
    return respond(true, 200, {});
  });
  await waitFor(() => expect(screen.getByText("Repo")).toBeTruthy());
  fireEvent.contextMenu(screen.getByText("Repo"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(del).not.toHaveBeenCalled();
  expect(screen.getByText("Repo")).toBeTruthy();
});

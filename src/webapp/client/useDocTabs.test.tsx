import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

vi.mock("./api", () => ({
  api: { getPref: vi.fn(), setPref: vi.fn(), doc: vi.fn(), titles: vi.fn() },
}));
import { api } from "./api";
import type { DocView, Wiki } from "./api";
import { useDocTabs, useAdoptResolvedId } from "./useDocTabs";
import { useDoc } from "./hooks";

const home: Wiki = {
  id: "w1",
  kind: "home",
  root: "/ws/.llm-wiki-memory/wiki",
  mountDir: "/ws",
  projectModule: "ws-default-module",
  ownership: "wiki",
  label: "Main Brain",
  categories: ["issues", "knowledge"],
};
const wikis = [home];

const LEAF = "DEV-134096-vulnerabilities-cleanup.plan.md";
const STALE = `issues/JIRA/DEV/134/9/6/in-progress/${LEAF}`;
const REAL = `issues/JIRA/DEV/134/9/6/pending/${LEAF}`;
const OTHER = "knowledge/backend/decision/architecture/kafka.md";

const noop = () => undefined;
const setPrefResult = () => Promise.resolve() as unknown as ReturnType<typeof api.setPref>;

const docView = (id: string, requestedId?: string): DocView => ({
  id,
  ...(requestedId ? { requestedId } : {}),
  name: id.split("/").pop() as string,
  category: id.split("/")[0],
  body: "# body",
  frontmatter: {},
  memory: {},
  active: true,
});

const answerFor = (docId: string) => (docId === STALE ? docView(REAL, STALE) : docView(docId));

type Tabs = ReturnType<typeof useDocTabs>;
let state: Tabs | null = null;
const current = () => state as Tabs;

function Harness() {
  const [wikiId, setWikiId] = useState<string | null>(null);
  const activeWiki = wikis.find((wiki) => wiki.id === wikiId);
  const tabs = useDocTabs({ wikiId, setWikiId, wikis, activeWiki, setDocsView: noop });
  const doc = useDoc(wikiId, tabs.active);
  useAdoptResolvedId(doc.data, tabs.adoptDocId);
  state = tabs;
  return null;
}

function mount({ openTabs = [] as string[], pinnedTabs = [] as string[], hash = "" } = {}) {
  vi.mocked(api.getPref).mockImplementation((_wikiId: string, key: string) => {
    if (key === "openTabs") return Promise.resolve(JSON.stringify(openTabs));
    if (key === "pinnedTabs") return Promise.resolve(JSON.stringify(pinnedTabs));
    return Promise.resolve("horizontal");
  });
  window.history.replaceState(null, "", hash || "/");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const prefWrites = (key: string) =>
  vi.mocked(api.setPref).mock.calls.filter((call) => call[1] === key);
const requestedDocIds = () => vi.mocked(api.doc).mock.calls.map((call) => call[1]);

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  state = null;
  vi.clearAllMocks();
  vi.mocked(api.setPref).mockImplementation(setPrefResult);
  vi.mocked(api.doc).mockImplementation((_wikiId: string, docId: string) =>
    Promise.resolve(answerFor(docId)),
  );
  vi.mocked(api.titles).mockResolvedValue({});
});

describe("adopting a server-corrected document id", () => {
  test("a stale lifecycle id opened from a hash reference becomes the leaf's real id", async () => {
    mount({ openTabs: [OTHER], hash: `#brain:${STALE}` });
    await waitFor(() => expect(current().active).toBe(REAL));
    expect(current().tabs).toEqual([OTHER, REAL]);
    expect(window.location.hash).toBe(`#brain:${REAL}`);
  });

  test("the corrected list is persisted, so a reload cannot resurrect the dead id", async () => {
    mount({ openTabs: [STALE] });
    await waitFor(() => expect(current().active).toBe(REAL));
    expect(current().tabs).toEqual([REAL]);
    expect(prefWrites("openTabs")).toEqual([["w1", "openTabs", JSON.stringify([REAL])]]);
  });

  test("adopting an id that is already open collapses the tabs instead of duplicating", async () => {
    mount({ openTabs: [REAL] });
    await waitFor(() => expect(current().active).toBe(REAL));
    act(() => current().openDoc(STALE));
    expect(current().tabs).toEqual([REAL, STALE]);
    await waitFor(() => expect(current().tabs).toEqual([REAL]));
    expect(current().active).toBe(REAL);
    expect(current().displayTabs).toEqual([REAL]);
  });

  test("a pinned stale tab keeps its pin, and the dead id leaves the pinnedTabs preference", async () => {
    mount({ openTabs: [OTHER, STALE], pinnedTabs: [STALE], hash: `#brain:${STALE}` });
    await waitFor(() => expect(current().active).toBe(REAL));
    expect(current().pinnedTabs).toEqual([REAL]);
    expect(current().displayTabs).toEqual([REAL, OTHER]);
    expect(prefWrites("pinnedTabs")).toEqual([["w1", "pinnedTabs", JSON.stringify([REAL])]]);
  });

  test("the swap is reported for the tab it applies to, so the UI can show it", async () => {
    mount({ openTabs: [STALE, OTHER] });
    await waitFor(() => expect(current().active).toBe(REAL));
    expect(current().staleRef).toBe(STALE);
    act(() => current().setActive(OTHER));
    expect(current().staleRef).toBeNull();
    act(() => current().setActive(REAL));
    expect(current().staleRef).toBe(STALE);
  });

  test("closing the tab forgets the swap, so reopening the leaf is not re-flagged", async () => {
    mount({ openTabs: [STALE, OTHER] });
    await waitFor(() => expect(current().active).toBe(REAL));
    act(() => current().closeTab(REAL));
    expect(current().staleRef).toBeNull();
    act(() => current().openDoc(REAL));
    expect(current().staleRef).toBeNull();
  });

  test("the correction settles after one extra request and does not loop", async () => {
    mount({ openTabs: [STALE] });
    await waitFor(() => expect(current().active).toBe(REAL));
    expect(requestedDocIds()).toEqual([STALE, REAL]);
    await settle();
    await settle();
    expect(requestedDocIds()).toEqual([STALE, REAL]);
    expect(current().active).toBe(REAL);
    expect(current().tabs).toEqual([REAL]);
    expect(prefWrites("openTabs")).toHaveLength(1);
  });
});

describe("a document whose id already resolves", () => {
  test("is left untouched: no tab churn, no persist, no second request", async () => {
    mount({ openTabs: [OTHER] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER]));
    const before = current().tabs;
    await settle();
    expect(current().tabs).toBe(before);
    expect(current().active).toBe(OTHER);
    expect(requestedDocIds()).toEqual([OTHER]);
    expect(prefWrites("openTabs")).toEqual([]);
    expect(window.location.hash).toBe(`#brain:${OTHER}`);
  });

  test("adoptDocId called with the id the tab already has is inert", async () => {
    mount({ openTabs: [OTHER] });
    await waitFor(() => expect(current().active).toBe(OTHER));
    const before = current().tabs;
    act(() => current().adoptDocId(OTHER, OTHER));
    expect(current().tabs).toBe(before);
    expect(current().staleRef).toBeNull();
    expect(prefWrites("openTabs")).toEqual([]);
  });

  test("adoptDocId is inert when no document is active", async () => {
    mount({ openTabs: [] });
    await waitFor(() => expect(current().tabs).toEqual([]));
    act(() => current().adoptDocId(REAL, STALE));
    expect(current().active).toBeNull();
    expect(current().tabs).toEqual([]);
    expect(prefWrites("openTabs")).toEqual([]);
  });
});

describe("a differing id the server did not declare as a substitution", () => {
  test("is never adopted: only a declared correction may rewrite persisted state", async () => {
    vi.mocked(api.doc).mockImplementation(() => Promise.resolve(docView(REAL)));
    mount({ openTabs: [STALE] });
    await waitFor(() => expect(current().tabs).toEqual([STALE]));
    await settle();
    expect(current().active).toBe(STALE);
    expect(current().tabs).toEqual([STALE]);
    expect(current().staleRef).toBeNull();
    expect(prefWrites("openTabs")).toEqual([]);
    expect(window.location.hash).toBe(`#brain:${STALE}`);
  });

  test("a correction for a tab that is no longer active leaves every tab alone", async () => {
    mount({ openTabs: [OTHER] });
    await waitFor(() => expect(current().active).toBe(OTHER));
    const before = current().tabs;
    act(() => current().adoptDocId(REAL, STALE));
    expect(current().tabs).toBe(before);
    expect(current().active).toBe(OTHER);
    expect(current().staleRef).toBeNull();
    expect(prefWrites("openTabs")).toEqual([]);
  });
});

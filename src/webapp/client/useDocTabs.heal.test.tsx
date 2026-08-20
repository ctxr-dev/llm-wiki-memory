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
const STALE2 = `issues/JIRA/DEV/134/9/6/archived/${LEAF}`;
const REAL = `issues/JIRA/DEV/134/9/6/pending/${LEAF}`;
const OTHER = "knowledge/backend/decision/architecture/kafka.md";
const healed = { title: "Cleanup Plan", active: true, resolvedId: REAL };
const LEAF_B = "DEV-134097-second.plan.md";
const STALE_B = `issues/JIRA/DEV/134/9/7/in-progress/${LEAF_B}`;
const REAL_B = `issues/JIRA/DEV/134/9/7/pending/${LEAF_B}`;
const healedB = { title: "Second Plan", active: true, resolvedId: REAL_B };

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

describe("healing a stale tab from the titles response", () => {
  test("a stale tab that is not active heals from the titles response without a click", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed });
    mount({ openTabs: [OTHER, STALE] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER, REAL]));
    expect(current().active).toBe(OTHER);
    expect(prefWrites("openTabs")).toEqual([["w1", "openTabs", JSON.stringify([OTHER, REAL])]]);
  });

  test("a healed tab reports its swap when the user selects it", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed });
    mount({ openTabs: [OTHER, STALE] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER, REAL]));
    expect(current().staleRef).toBeNull();
    act(() => current().setActive(REAL));
    expect(current().staleRef).toBe(STALE);
    act(() => current().closeTab(REAL));
    expect(current().staleRef).toBeNull();
  });

  test("a stale id and its real id both open collapse to one tab, keeping the pin", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed });
    mount({ openTabs: [OTHER, REAL, STALE], pinnedTabs: [STALE] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER, REAL]));
    expect(current().pinnedTabs).toEqual([REAL]);
    expect(current().displayTabs).toEqual([REAL, OTHER]);
    expect(prefWrites("pinnedTabs")).toEqual([["w1", "pinnedTabs", JSON.stringify([REAL])]]);
  });

  test("two stale spellings of one leaf collapse onto a single tab", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed, [STALE2]: healed });
    mount({ openTabs: [OTHER, STALE, STALE2] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER, REAL]));
    expect(prefWrites("openTabs")).toHaveLength(1);
  });

  test("the heal settles after one response and does not loop", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed });
    mount({ openTabs: [OTHER, STALE] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER, REAL]));
    await settle();
    const settled = current().tabs;
    await settle();
    expect(current().tabs).toBe(settled);
    expect(prefWrites("openTabs")).toHaveLength(1);
    expect(vi.mocked(api.titles).mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("the active tab is still healed by the document response, with its notice", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed });
    mount({ openTabs: [STALE, OTHER] });
    await waitFor(() => expect(current().active).toBe(REAL));
    expect(current().tabs).toEqual([REAL, OTHER]);
    expect(current().staleRef).toBe(STALE);
    await settle();
    expect(prefWrites("openTabs")).toHaveLength(1);
  });

  test("collapsing a stale duplicate onto the tab already being read flags nothing", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed });
    mount({ openTabs: [REAL, STALE] });
    await waitFor(() => expect(current().tabs).toEqual([REAL]));
    expect(current().active).toBe(REAL);
    expect(current().staleRef).toBeNull();
  });

  test("closing other tabs forgets their swaps, so reopening one is not re-flagged", async () => {
    vi.mocked(api.titles).mockResolvedValue({ [STALE]: healed });
    mount({ openTabs: [OTHER, STALE] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER, REAL]));
    act(() => current().closeOthers(OTHER));
    expect(current().tabs).toEqual([OTHER]);
    act(() => current().openDoc(REAL));
    expect(current().staleRef).toBeNull();
  });

  test("an adoption computed from the pre-heal render does not discard the heal", async () => {
    let releaseTitles: (
      map: Record<string, { title: string; active: boolean; resolvedId?: string }>,
    ) => void = () => undefined;
    vi.mocked(api.titles).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseTitles = resolve;
        }),
    );
    vi.mocked(api.doc).mockImplementation((_wikiId: string, docId: string) =>
      Promise.resolve(docView(docId)),
    );
    mount({ openTabs: [STALE, STALE_B] });
    await waitFor(() => expect(current().tabs).toEqual([STALE, STALE_B]));
    const adoptFromStaleRender = current().adoptDocId;
    act(() => {
      releaseTitles({ [STALE_B]: healedB });
    });
    await settle();
    expect(current().tabs).toEqual([STALE, REAL_B]);
    act(() => adoptFromStaleRender(REAL, STALE));
    expect(current().tabs).toEqual([REAL, REAL_B]);
    expect(prefWrites("openTabs").at(-1)).toEqual([
      "w1",
      "openTabs",
      JSON.stringify([REAL, REAL_B]),
    ]);
  });

  test("titles held over from a previous tab set never heal a tab", async () => {
    vi.mocked(api.doc).mockImplementation((_wikiId: string, docId: string) =>
      Promise.resolve(docView(docId)),
    );
    let release: (
      map: Record<string, { title: string; active: boolean; resolvedId?: string }>,
    ) => void = () => undefined;
    vi.mocked(api.titles)
      .mockResolvedValueOnce({ [STALE]: healed })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    mount({ openTabs: [OTHER] });
    await waitFor(() => expect(current().tabs).toEqual([OTHER]));
    act(() => current().openDoc(STALE));
    await settle();
    act(() => current().setActive(OTHER));
    await settle();
    expect(current().tabs).toEqual([OTHER, STALE]);
    act(() => release({}));
    await settle();
    expect(current().tabs).toEqual([OTHER, STALE]);
  });
});

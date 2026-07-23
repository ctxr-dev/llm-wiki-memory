import { useCallback, useEffect, useMemo, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "./Button";
import { Sidebar } from "./Sidebar";
import { NavPanel, type NavRequest } from "./NavPanel";
import { DocView } from "./DocView";
import { Breadcrumb } from "./Breadcrumb";
import { CommandPalette } from "./CommandPalette";
import { AskPanel } from "./AskPanel";
import { PlansBoard } from "./PlansBoard";
import { IssuesBoard } from "./IssuesBoard";
import { ThemeToggle } from "./ThemeToggle";
import { useWikis, useTitles } from "./hooks";
import { api } from "./api";
import type { Facet } from "./api";
import { parseTabs } from "./tabs";
import { availableViews } from "./views";

type PaletteInit = { filters: Facet[]; category: string | null } | null;

export function App() {
  const wikis = useWikis();
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInit, setPaletteInit] = useState<PaletteInit>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [view, setView] = useState<"docs" | "plans" | "issues">("docs");
  const [navRequest, setNavRequest] = useState<NavRequest>({ category: null, path: "", token: 0 });
  const tabTitles = useTitles(wikiId, tabs);
  const labelFor = (docId: string) => tabTitles.data?.[docId] ?? docId.split("/").pop() ?? docId;
  const activeWiki = wikis.data?.find((wiki) => wiki.id === wikiId);
  const views = useMemo(() => availableViews(activeWiki?.categories), [activeWiki?.categories]);
  const effectiveView = views.includes(view) ? view : "docs";

  useEffect(() => {
    if (!wikiId && wikis.data?.length) setWikiId(wikis.data[0].id);
  }, [wikis.data, wikiId]);

  useEffect(() => {
    if (!views.includes(view)) setView("docs");
  }, [views, view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setPaletteInit(null);
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!wikiId) return undefined;
    let ignore = false;
    setTabs([]);
    setActive(null);
    setView("docs");
    api
      .getPref(wikiId, "openTabs")
      .then((value) => {
        if (ignore) return;
        const restored = parseTabs(value);
        setTabs(restored);
        setActive(restored[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [wikiId]);

  const persist = useCallback(
    (next: string[]) => {
      if (wikiId) api.setPref(wikiId, "openTabs", JSON.stringify(next)).catch(() => undefined);
    },
    [wikiId],
  );

  const openDoc = useCallback(
    (docId: string) => {
      const next = tabs.includes(docId) ? tabs : [...tabs, docId];
      setTabs(next);
      persist(next);
      setActive(docId);
      setView("docs");
    },
    [tabs, persist],
  );

  const closeTab = useCallback(
    (docId: string) => {
      const next = tabs.filter((tab) => tab !== docId);
      setTabs(next);
      persist(next);
      if (active === docId) setActive(next[next.length - 1] ?? null);
    },
    [tabs, active, persist],
  );

  const selectWiki = useCallback((id: string) => {
    setWikiId(id);
    setNavRequest((request) => ({ category: null, path: "", token: request.token + 1 }));
  }, []);

  const navigateTo = useCallback((category: string, path: string) => {
    setNavRequest((request) => ({ category, path, token: request.token + 1 }));
  }, []);

  const openFacetSearch = useCallback((facet: Facet) => {
    setPaletteInit(
      facet.key === "category"
        ? { filters: [], category: facet.value }
        : { filters: [facet], category: null },
    );
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    setPaletteInit(null);
  }, []);

  return (
    <div className="flex h-screen text-slate-800 dark:text-slate-100">
      <Sidebar activeId={wikiId} onSelect={selectWiki} />
      {wikiId && <NavPanel wikiId={wikiId} onOpenDoc={openDoc} request={navRequest} />}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 px-3 py-1.5">
          <div className="flex gap-1 text-sm">
            {views.map((name) => (
              <button
                key={name}
                onClick={() => setView(name)}
                disabled={!wikiId}
                className={`cursor-pointer rounded px-2 py-1 capitalize disabled:opacity-40 ${
                  effectiveView === name
                    ? "bg-slate-200 dark:bg-slate-700 font-medium"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              setPaletteInit(null);
              setPaletteOpen(true);
            }}
            className="flex-1 cursor-pointer rounded border border-slate-200 dark:border-slate-700 px-3 py-1 text-left text-sm text-slate-400 dark:text-slate-500 hover:border-slate-300 dark:hover:border-slate-600"
          >
            Search or jump… <span className="ml-1 text-xs">⌘K</span>
          </button>
          <Button
            variant="primary"
            onClick={() => setAskOpen(true)}
            disabled={!wikiId}
            className="px-3 py-1"
          >
            Ask
          </Button>
          <ThemeToggle />
        </div>
        {effectiveView === "docs" && (
          <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-700 px-2">
            {tabs.map((tab) => (
              <div
                key={tab}
                className={`flex items-center gap-1 border-b-2 px-3 py-2 text-sm ${
                  tab === active
                    ? "border-slate-800"
                    : "border-transparent text-slate-500 dark:text-slate-400"
                }`}
              >
                <button
                  onClick={() => setActive(tab)}
                  className="max-w-[16rem] cursor-pointer truncate"
                  title={tab}
                >
                  {labelFor(tab)}
                </button>
                <Button
                  variant="ghost"
                  onClick={() => closeTab(tab)}
                  aria-label="close tab"
                  className="px-1 text-slate-400 hover:bg-transparent dark:text-slate-500"
                  icon={<XMarkIcon className="h-4 w-4" />}
                />
              </div>
            ))}
          </div>
        )}
        {effectiveView === "docs" && active && (
          <Breadcrumb docId={active} onNavigate={navigateTo} />
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {wikiId && effectiveView === "plans" && <PlansBoard wikiId={wikiId} onOpen={openDoc} />}
          {wikiId && effectiveView === "issues" && <IssuesBoard wikiId={wikiId} onOpen={openDoc} />}
          {effectiveView === "docs" &&
            (wikiId && active ? (
              <DocView
                wikiId={wikiId}
                docId={active}
                onOpen={openDoc}
                onChipFilter={openFacetSearch}
              />
            ) : (
              <div className="p-8 text-slate-400 dark:text-slate-500">
                Select a document from the tree.
              </div>
            ))}
        </div>
      </main>
      {paletteOpen && wikiId && (
        <CommandPalette
          key={JSON.stringify(paletteInit)}
          wikiId={wikiId}
          onOpenDoc={openDoc}
          onSwitchWiki={selectWiki}
          onClose={closePalette}
          initialFilters={paletteInit?.filters ?? []}
          initialCategory={paletteInit?.category ?? null}
        />
      )}
      {askOpen && wikiId && (
        <AskPanel wikiId={wikiId} onOpenDoc={openDoc} onClose={() => setAskOpen(false)} />
      )}
    </div>
  );
}

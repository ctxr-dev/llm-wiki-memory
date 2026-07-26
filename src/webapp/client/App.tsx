import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "./Button";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { TabContextMenu } from "./TabContextMenu";
import { NavPanel, type NavRequest } from "./NavPanel";
import { DocView } from "./DocView";
import { Breadcrumb } from "./Breadcrumb";
import { CommandPalette } from "./CommandPalette";
import { AskPanel } from "./AskPanel";
import { PlansBoard } from "./PlansBoard";
import { IssuesBoard } from "./IssuesBoard";
import { ThemeToggle } from "./ThemeToggle";
import { useWikis, useTitles } from "./hooks";
import type { Facet } from "./api";
import { formatRef } from "./refs";
import { availableViews } from "./views";
import { useDocTabs } from "./useDocTabs";

type PaletteInit = { filters: Facet[]; category: string | null } | null;

export function App() {
  const wikis = useWikis();
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInit, setPaletteInit] = useState<PaletteInit>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [view, setView] = useState<"docs" | "plans" | "issues">("docs");
  const [navRequest, setNavRequest] = useState<NavRequest>({ category: null, path: "", token: 0 });
  const activeWiki = wikis.data?.find((wiki) => wiki.id === wikiId);
  const views = useMemo(() => availableViews(activeWiki?.categories), [activeWiki?.categories]);
  const effectiveView = views.includes(view) ? view : "docs";
  const setDocsView = useCallback(() => setView("docs"), []);
  const {
    tabs,
    active,
    setActive,
    pinnedTabs,
    orientation,
    tabMenu,
    setTabMenu,
    displayTabs,
    openDoc,
    closeTab,
    reorderTabs,
    closeOthers,
    togglePin,
    changeOrientation,
    navigateToRef,
  } = useDocTabs({ wikiId, setWikiId, wikis: wikis.data, activeWiki, setDocsView });
  const tabTitles = useTitles(wikiId, tabs);
  const labelFor = (docId: string) => tabTitles.data?.[docId] ?? docId.split("/").pop() ?? docId;

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

  const copyTabReference = useCallback(
    (docId: string) => {
      if (!activeWiki || !navigator.clipboard) return;
      navigator.clipboard.writeText(formatRef(activeWiki, docId)).catch(() => undefined);
    },
    [activeWiki],
  );

  const tabBar =
    effectiveView === "docs" ? (
      <TabBar
        tabs={displayTabs}
        active={active}
        pinnedIds={pinnedTabs}
        orientation={orientation}
        labelFor={labelFor}
        onSelect={setActive}
        onClose={closeTab}
        onReorder={reorderTabs}
        onContextMenu={(docId, x, y) => setTabMenu({ docId, x, y })}
      />
    ) : null;
  const breadcrumb =
    effectiveView === "docs" && active ? (
      <Breadcrumb docId={active} wiki={activeWiki} onNavigate={navigateTo} />
    ) : null;
  const scrollArea = (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {wikiId && effectiveView === "plans" && <PlansBoard wikiId={wikiId} onOpen={openDoc} />}
      {wikiId && effectiveView === "issues" && <IssuesBoard wikiId={wikiId} onOpen={openDoc} />}
      {effectiveView === "docs" &&
        (wikiId && active ? (
          <DocView
            wikiId={wikiId}
            docId={active}
            onOpen={openDoc}
            onOpenRef={navigateToRef}
            onChipFilter={openFacetSearch}
          />
        ) : (
          <div className="p-8 text-slate-400 dark:text-slate-500">
            Select a document from the tree.
          </div>
        ))}
    </div>
  );

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
        {effectiveView === "docs" && orientation === "vertical" ? (
          <div className="flex min-h-0 flex-1">
            {tabBar}
            <div className="flex min-w-0 flex-1 flex-col">
              {breadcrumb}
              {scrollArea}
            </div>
          </div>
        ) : (
          <>
            {tabBar}
            {breadcrumb}
            {scrollArea}
          </>
        )}
      </main>
      {paletteOpen && wikiId && (
        <CommandPalette
          key={JSON.stringify(paletteInit)}
          wikiId={wikiId}
          onOpenDoc={openDoc}
          onSwitchWiki={selectWiki}
          onOpenRef={navigateToRef}
          onClose={closePalette}
          initialFilters={paletteInit?.filters ?? []}
          initialCategory={paletteInit?.category ?? null}
        />
      )}
      {askOpen && wikiId && (
        <AskPanel
          wikiId={wikiId}
          onOpenDoc={openDoc}
          onOpenRef={navigateToRef}
          onClose={() => setAskOpen(false)}
        />
      )}
      {tabMenu && (
        <TabContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          isPinned={pinnedTabs.includes(tabMenu.docId)}
          orientation={orientation}
          onCloseTab={() => closeTab(tabMenu.docId)}
          onCloseOthers={() => closeOthers(tabMenu.docId)}
          onTogglePin={() => togglePin(tabMenu.docId)}
          onCopyReference={() => copyTabReference(tabMenu.docId)}
          onSetOrientation={changeOrientation}
          onDismiss={() => setTabMenu(null)}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MagnifyingGlassIcon,
  SparklesIcon,
  DocumentTextIcon,
  ClipboardDocumentCheckIcon,
  TicketIcon,
} from "@heroicons/react/24/outline";
import { Button } from "./Button";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { TabContextMenu } from "./TabContextMenu";
import { NavPanel, type NavRequest } from "./NavPanel";
import { DocView } from "./DocView";
import { StaleRefNotice } from "./StaleRefNotice";
import { Breadcrumb } from "./Breadcrumb";
import { CommandPalette } from "./CommandPalette";
import { AskPanel } from "./AskPanel";
import { PlansBoard } from "./PlansBoard";
import { IssuesBoard } from "./IssuesBoard";
import { ThemeToggle } from "./ThemeToggle";
import { useWikis, useDoc } from "./hooks";
import type { Facet } from "./api";
import { formatRef } from "./refs";
import { availableViews } from "./views";
import { useDocTabs, useAdoptResolvedId } from "./useDocTabs";
import { useShowArchived } from "./useShowArchived";

type PaletteInit = { filters: Facet[]; category: string | null } | null;

const VIEW_ICONS: Record<string, typeof DocumentTextIcon> = {
  docs: DocumentTextIcon,
  plans: ClipboardDocumentCheckIcon,
  issues: TicketIcon,
};

export function App() {
  const wikis = useWikis();
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInit, setPaletteInit] = useState<PaletteInit>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [view, setView] = useState<"docs" | "plans" | "issues">("docs");
  const [navRequest, setNavRequest] = useState<NavRequest>({ category: null, path: "", token: 0 });
  const activeWiki = wikis.data?.find((wiki) => wiki.id === wikiId);
  const { showArchived, setShowArchived } = useShowArchived(wikiId);
  const [editing, setEditing] = useState(false);
  const views = useMemo(() => availableViews(activeWiki?.categories), [activeWiki?.categories]);
  const effectiveView = views.includes(view) ? view : "docs";
  const setDocsView = useCallback(() => setView("docs"), []);
  const {
    active,
    setActive,
    labelFor,
    archivedTabIds,
    staleRef,
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
    adoptDocId,
  } = useDocTabs({ wikiId, setWikiId, wikis: wikis.data, activeWiki, setDocsView });
  const activeDoc = useDoc(wikiId, active);
  useAdoptResolvedId(activeDoc.data, adoptDocId);

  useEffect(() => setEditing(false), [active]);

  useEffect(() => {
    if (!views.includes(view)) setView("docs");
  }, [views, view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (event.shiftKey) {
          setAskOpen(true);
        } else {
          setPaletteInit(null);
          setPaletteOpen((open) => !open);
        }
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
        archivedIds={archivedTabIds}
        onSelect={setActive}
        onClose={closeTab}
        onReorder={reorderTabs}
        onContextMenu={(docId, x, y) => setTabMenu({ docId, x, y })}
      />
    ) : null;
  const docHeader =
    effectiveView === "docs" && active ? (
      <>
        <Breadcrumb
          docId={active}
          wiki={activeWiki}
          onNavigate={navigateTo}
          onEdit={() => setEditing(true)}
          editing={editing}
          archived={activeDoc.data ? !activeDoc.data.active : false}
        />
        {staleRef && <StaleRefNotice requestedId={staleRef} resolvedId={active} />}
      </>
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
            editing={editing}
            onEditDone={(newId) => {
              setEditing(false);
              if (newId && newId !== active) openDoc(newId);
            }}
            onDeleted={() => {
              setEditing(false);
              if (active) closeTab(active);
            }}
            showArchived={showArchived}
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
      {wikiId && (
        <NavPanel
          wikiId={wikiId}
          onOpenDoc={openDoc}
          request={navRequest}
          showArchived={showArchived}
          onToggleArchived={setShowArchived}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-700 px-3 py-1.5">
          <div className="flex gap-1 text-sm">
            {views.map((name) => {
              const ViewIcon = VIEW_ICONS[name];
              return (
                <button
                  key={name}
                  onClick={() => setView(name)}
                  disabled={!wikiId}
                  className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1 capitalize disabled:opacity-40 ${
                    effectiveView === name
                      ? "bg-slate-200 dark:bg-slate-700 font-medium"
                      : "hover:bg-slate-100 dark:hover:bg-slate-800"
                  }`}
                >
                  {ViewIcon && <ViewIcon className="h-4 w-4" aria-hidden="true" />}
                  {name}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => {
              setPaletteInit(null);
              setPaletteOpen(true);
            }}
            className="flex flex-1 cursor-pointer items-center gap-2 rounded border border-slate-200 dark:border-slate-700 px-3 py-1 text-left text-sm text-slate-400 dark:text-slate-500 hover:border-slate-300 dark:hover:border-slate-600"
          >
            <MagnifyingGlassIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            Search or jump…
            <span className="ml-auto text-xs">⌘K</span>
          </button>
          <Button
            variant="primary"
            onClick={() => setAskOpen(true)}
            disabled={!wikiId}
            className="px-3 py-1"
            icon={<SparklesIcon className="h-4 w-4" />}
          >
            Ask <span className="ml-1 text-xs opacity-70">⌘⇧K</span>
          </Button>
          <ThemeToggle />
        </div>
        {effectiveView === "docs" && orientation === "vertical" ? (
          <div className="flex min-h-0 flex-1">
            {tabBar}
            <div className="flex min-w-0 flex-1 flex-col">
              {docHeader}
              {scrollArea}
            </div>
          </div>
        ) : (
          <>
            {tabBar}
            {docHeader}
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
          showArchived={showArchived}
        />
      )}
      {askOpen && wikiId && (
        <AskPanel
          wikiId={wikiId}
          onOpenDoc={openDoc}
          onOpenRef={navigateToRef}
          onClose={() => setAskOpen(false)}
          showArchived={showArchived}
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

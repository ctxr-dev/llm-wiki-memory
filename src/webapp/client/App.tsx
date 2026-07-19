import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { NavPanel } from "./NavPanel";
import { DocView } from "./DocView";
import { CommandPalette } from "./CommandPalette";
import { AskPanel } from "./AskPanel";
import { PlansBoard } from "./PlansBoard";
import { IssuesBoard } from "./IssuesBoard";
import { useWikis } from "./hooks";
import { api } from "./api";
import { parseTabs } from "./tabs";

export function App() {
  const wikis = useWikis();
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [view, setView] = useState<"docs" | "plans" | "issues">("docs");

  useEffect(() => {
    if (!wikiId && wikis.data?.length) setWikiId(wikis.data[0].id);
  }, [wikis.data, wikiId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
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

  return (
    <div className="flex h-screen text-slate-800">
      <Sidebar activeId={wikiId} onSelect={setWikiId} />
      {wikiId && <NavPanel wikiId={wikiId} onOpenDoc={openDoc} />}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-1.5">
          <div className="flex gap-1 text-sm">
            {(["docs", "plans", "issues"] as const).map((name) => (
              <button
                key={name}
                onClick={() => setView(name)}
                disabled={!wikiId}
                className={`rounded px-2 py-1 capitalize disabled:opacity-40 ${
                  view === name ? "bg-slate-200 font-medium" : "hover:bg-slate-100"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex-1 rounded border border-slate-200 px-3 py-1 text-left text-sm text-slate-400 hover:border-slate-300"
          >
            Search or jump… <span className="ml-1 text-xs">⌘K</span>
          </button>
          <button
            onClick={() => setAskOpen(true)}
            disabled={!wikiId}
            className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-40"
          >
            Ask
          </button>
        </div>
        {view === "docs" && (
          <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 px-2">
            {tabs.map((tab) => (
              <div
                key={tab}
                className={`flex items-center gap-1 border-b-2 px-3 py-2 text-sm ${
                  tab === active ? "border-slate-800" : "border-transparent text-slate-500"
                }`}
              >
                <button
                  onClick={() => setActive(tab)}
                  className="max-w-[16rem] truncate"
                  title={tab}
                >
                  {tab.split("/").pop()}
                </button>
                <button
                  onClick={() => closeTab(tab)}
                  className="text-slate-400 hover:text-slate-700"
                  aria-label="close tab"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {wikiId && view === "plans" && <PlansBoard wikiId={wikiId} onOpen={openDoc} />}
          {wikiId && view === "issues" && <IssuesBoard wikiId={wikiId} onOpen={openDoc} />}
          {view === "docs" &&
            (wikiId && active ? (
              <DocView wikiId={wikiId} docId={active} onOpen={openDoc} />
            ) : (
              <div className="p-8 text-slate-400">Select a document from the tree.</div>
            ))}
        </div>
      </main>
      {paletteOpen && wikiId && (
        <CommandPalette
          wikiId={wikiId}
          onOpenDoc={openDoc}
          onSwitchWiki={setWikiId}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {askOpen && wikiId && (
        <AskPanel wikiId={wikiId} onOpenDoc={openDoc} onClose={() => setAskOpen(false)} />
      )}
    </div>
  );
}

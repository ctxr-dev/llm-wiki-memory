import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { NavPanel } from "./NavPanel";
import { DocView } from "./DocView";
import { useWikis } from "./hooks";
import { api } from "./api";
import { parseTabs } from "./tabs";

export function App() {
  const wikis = useWikis();
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (!wikiId && wikis.data?.length) setWikiId(wikis.data[0].id);
  }, [wikis.data, wikiId]);

  useEffect(() => {
    if (!wikiId) return undefined;
    let ignore = false;
    setTabs([]);
    setActive(null);
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
        <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 px-2">
          {tabs.map((tab) => (
            <div
              key={tab}
              className={`flex items-center gap-1 border-b-2 px-3 py-2 text-sm ${
                tab === active ? "border-slate-800" : "border-transparent text-slate-500"
              }`}
            >
              <button onClick={() => setActive(tab)} className="max-w-[16rem] truncate" title={tab}>
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
        <div className="min-h-0 flex-1 overflow-y-auto">
          {wikiId && active ? (
            <DocView wikiId={wikiId} docId={active} onOpen={openDoc} />
          ) : (
            <div className="p-8 text-slate-400">Select a document from the tree.</div>
          )}
        </div>
      </main>
    </div>
  );
}

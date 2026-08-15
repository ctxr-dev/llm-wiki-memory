import { useEffect } from "react";
import { useTitles } from "./hooks";
import { replaceTabId } from "./tab-order";

export function useTabTitles({
  wikiId,
  tabs,
  pinnedTabs,
  active,
  setTabs,
  setPinnedTabs,
  setCorrections,
  persist,
  persistPinned,
}: {
  wikiId: string | null;
  tabs: string[];
  pinnedTabs: string[];
  active: string | null;
  setTabs: (next: string[]) => void;
  setPinnedTabs: (next: string[]) => void;
  setCorrections: (update: (prev: Record<string, string>) => Record<string, string>) => void;
  persist: (next: string[]) => void;
  persistPinned: (next: string[]) => void;
}) {
  const tabTitles = useTitles(wikiId, tabs);

  useEffect(() => {
    const titles = tabTitles.data;
    if (!titles || tabTitles.isPlaceholderData) return;
    let nextTabs = tabs;
    let nextPinned = pinnedTabs;
    const applied: Record<string, string> = {};
    for (const [requestedId, entry] of Object.entries(titles)) {
      const resolvedId = entry.resolvedId;
      if (!resolvedId || requestedId === active || !nextTabs.includes(requestedId)) continue;
      nextTabs = replaceTabId(nextTabs, requestedId, resolvedId);
      nextPinned = replaceTabId(nextPinned, requestedId, resolvedId);
      if (resolvedId !== active) applied[resolvedId] = requestedId;
    }
    if (nextTabs === tabs) return;
    setTabs(nextTabs);
    persist(nextTabs);
    if (nextPinned !== pinnedTabs) {
      setPinnedTabs(nextPinned);
      persistPinned(nextPinned);
    }
    setCorrections((prev) => ({ ...prev, ...applied }));
  }, [
    tabTitles.data,
    tabTitles.isPlaceholderData,
    tabs,
    pinnedTabs,
    active,
    setTabs,
    setPinnedTabs,
    setCorrections,
    persist,
    persistPinned,
  ]);

  const labelFor = (docId: string) =>
    tabTitles.data?.[docId]?.title ?? docId.split("/").pop() ?? docId;
  const archivedTabIds = tabs.filter((tab) => tabTitles.data?.[tab]?.active === false);
  return { labelFor, archivedTabIds };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Wiki } from "./api";
import { parseTabs } from "./tabs";
import { orderWithPins, replaceTabId } from "./tab-order";
import { desiredHash, resolveHash, planRestore } from "./hash-route";
import { useTabTitles } from "./useTabTitles";
import type { TabOrientation } from "./TabContextMenu";

type TabMenu = { docId: string; x: number; y: number } | null;

export function useDocTabs({
  wikiId,
  setWikiId,
  wikis,
  activeWiki,
  setDocsView,
}: {
  wikiId: string | null;
  setWikiId: (id: string) => void;
  wikis: Wiki[] | undefined;
  activeWiki: Wiki | undefined;
  setDocsView: () => void;
}) {
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [pinnedTabs, setPinnedTabs] = useState<string[]>([]);
  const [orientation, setOrientation] = useState<TabOrientation>("horizontal");
  const [tabMenu, setTabMenu] = useState<TabMenu>(null);
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const pendingHashDoc = useRef<{ wikiId: string; docId: string } | null>(null);
  const bootstrapped = useRef(false);
  const wikiIdRef = useRef(wikiId);
  wikiIdRef.current = wikiId;
  const displayTabs = useMemo(() => orderWithPins(tabs, pinnedTabs), [tabs, pinnedTabs]);

  useEffect(() => {
    if (wikiId || !wikis?.length) return;
    bootstrapped.current = true;
    const hashed = resolveHash(wikis, window.location.hash);
    if (hashed) {
      pendingHashDoc.current = { wikiId: hashed.wikiId, docId: hashed.docId };
      setWikiId(hashed.wikiId);
    } else {
      setWikiId(wikis[0].id);
    }
  }, [wikis, wikiId, setWikiId]);

  useEffect(() => {
    if (!wikiId) return undefined;
    let ignore = false;
    setTabs([]);
    setActive(null);
    setDocsView();
    setTabMenu(null);
    setCorrections({});
    Promise.all([
      api.getPref(wikiId, "openTabs"),
      api.getPref(wikiId, "pinnedTabs"),
      api.getPref(wikiId, "tabOrientation"),
    ])
      .then(([openValue, pinnedValue, orientationValue]) => {
        if (ignore) return;
        const pending = pendingHashDoc.current;
        const pendingDocId = pending && pending.wikiId === wikiId ? pending.docId : null;
        if (pendingDocId !== null) pendingHashDoc.current = null;
        const plan = planRestore(parseTabs(openValue), pendingDocId);
        setTabs(plan.tabs);
        setActive(plan.active);
        setPinnedTabs(parseTabs(pinnedValue));
        setOrientation(orientationValue === "vertical" ? "vertical" : "horizontal");
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, [wikiId, setDocsView]);

  const persist = useCallback(
    (next: string[]) => {
      if (wikiId) api.setPref(wikiId, "openTabs", JSON.stringify(next)).catch(() => undefined);
    },
    [wikiId],
  );
  const persistPinned = useCallback(
    (next: string[]) => {
      if (wikiId) api.setPref(wikiId, "pinnedTabs", JSON.stringify(next)).catch(() => undefined);
    },
    [wikiId],
  );
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const pinnedRef = useRef(pinnedTabs);
  pinnedRef.current = pinnedTabs;
  const commitTabs = useCallback((next: string[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);
  const commitPinned = useCallback((next: string[]) => {
    pinnedRef.current = next;
    setPinnedTabs(next);
  }, []);
  const { labelFor, archivedTabIds } = useTabTitles({
    wikiId,
    tabs,
    pinnedTabs,
    active,
    setTabs: commitTabs,
    setPinnedTabs: commitPinned,
    setCorrections,
    persist,
    persistPinned,
  });

  const openDoc = useCallback(
    (docId: string) => {
      const next = tabs.includes(docId) ? tabs : [...tabs, docId];
      setTabs(next);
      persist(next);
      setActive(docId);
      setDocsView();
    },
    [tabs, persist, setDocsView],
  );
  const openDocRef = useRef(openDoc);
  openDocRef.current = openDoc;

  /**
   * A tracker plan's id carries its lifecycle folder, so a reference written before the
   * plan moved names an id that no longer exists; the server resolves it and answers with
   * the leaf's REAL id. Adopting it moves the tab, its pin, the persisted openTabs
   * preference and the hash onto the live document, so the next reload does not break
   * again. Re-requesting the real id is an exact hit that echoes the same id back, which
   * is why this settles after one adoption instead of looping.
   *
   * Rewriting persisted state destroys the id the user actually asked for, so it happens
   * ONLY for a substitution the server declared (`requestedId`), and only while that is
   * still the active tab — never for an arbitrary id mismatch, and never onto a tab the
   * user has since moved away from. The correction is remembered so the swap can be shown
   * rather than applied invisibly: the resolution matches on leaf name, so the document
   * served is not provably the one the reference meant.
   */
  const adoptDocId = useCallback(
    (resolvedId: string, requestedId: string) => {
      if (resolvedId === requestedId || active !== requestedId) return;
      const nextTabs = replaceTabId(tabsRef.current, requestedId, resolvedId);
      if (nextTabs !== tabsRef.current) {
        commitTabs(nextTabs);
        persist(nextTabs);
      }
      const nextPinned = replaceTabId(pinnedRef.current, requestedId, resolvedId);
      if (nextPinned !== pinnedRef.current) {
        commitPinned(nextPinned);
        persistPinned(nextPinned);
      }
      setActive(resolvedId);
      setCorrections((prev) => ({ ...prev, [resolvedId]: requestedId }));
    },
    [active, persist, persistPinned, commitTabs, commitPinned],
  );

  const navigateToRef = useCallback(
    (targetWikiId: string, docId: string) => {
      if (targetWikiId === wikiIdRef.current) {
        openDocRef.current(docId);
      } else {
        pendingHashDoc.current = { wikiId: targetWikiId, docId };
        setWikiId(targetWikiId);
      }
    },
    [setWikiId],
  );

  useEffect(() => {
    if (!wikis || !bootstrapped.current) return;
    if (pendingHashDoc.current && pendingHashDoc.current.wikiId === activeWiki?.id) return;
    const desired = desiredHash(activeWiki, active);
    if (desired === window.location.hash) return;
    const url = desired || `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, "", url);
  }, [wikis, activeWiki, active]);

  useEffect(() => {
    if (!wikis) return undefined;
    const onNav = () => {
      const resolved = resolveHash(wikis, window.location.hash);
      if (resolved) navigateToRef(resolved.wikiId, resolved.docId);
    };
    window.addEventListener("hashchange", onNav);
    window.addEventListener("popstate", onNav);
    return () => {
      window.removeEventListener("hashchange", onNav);
      window.removeEventListener("popstate", onNav);
    };
  }, [wikis, navigateToRef]);

  const closeTab = useCallback(
    (docId: string) => {
      const next = tabs.filter((tab) => tab !== docId);
      setTabs(next);
      persist(next);
      setCorrections((prev) => {
        const remaining = { ...prev };
        delete remaining[docId];
        return remaining;
      });
      if (pinnedTabs.includes(docId)) {
        const prunedPins = pinnedTabs.filter((id) => id !== docId);
        setPinnedTabs(prunedPins);
        persistPinned(prunedPins);
      }
      if (active === docId) setActive(next[next.length - 1] ?? null);
    },
    [tabs, active, pinnedTabs, persist, persistPinned],
  );
  const reorderTabs = useCallback(
    (next: string[]) => {
      setTabs(next);
      persist(next);
    },
    [persist],
  );
  const closeOthers = useCallback(
    (docId: string) => {
      const keep = new Set([docId, ...pinnedTabs]);
      const next = tabs.filter((tab) => keep.has(tab));
      setTabs(next);
      persist(next);
      setCorrections((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([id]) => keep.has(id))),
      );
      setActive(docId);
    },
    [tabs, pinnedTabs, persist],
  );
  const togglePin = useCallback(
    (docId: string) => {
      const next = pinnedTabs.includes(docId)
        ? pinnedTabs.filter((id) => id !== docId)
        : [...pinnedTabs, docId];
      setPinnedTabs(next);
      persistPinned(next);
    },
    [pinnedTabs, persistPinned],
  );
  const changeOrientation = useCallback(
    (next: TabOrientation) => {
      setOrientation(next);
      if (wikiId) api.setPref(wikiId, "tabOrientation", next).catch(() => undefined);
    },
    [wikiId],
  );

  return {
    tabs,
    active,
    setActive,
    labelFor,
    archivedTabIds,
    staleRef: active ? (corrections[active] ?? null) : null,
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
  };
}

/**
 * `requestedId` is present only when the server served a leaf under a different id than
 * the one asked for, so its presence — not a bare id mismatch — is what authorises the
 * tab rewrite below.
 */
export function useAdoptResolvedId(
  doc: { id: string; requestedId?: string } | undefined,
  adoptDocId: (resolvedId: string, requestedId: string) => void,
) {
  const resolvedId = doc?.id;
  const requestedId = doc?.requestedId;
  useEffect(() => {
    if (resolvedId && requestedId) adoptDocId(resolvedId, requestedId);
  }, [resolvedId, requestedId, adoptDocId]);
}

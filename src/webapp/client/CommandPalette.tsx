import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useSearch, useWikis } from "./hooks";
import { useDebounced } from "./useDebounced";
import { Highlight } from "./Highlight";
import { Button } from "./Button";
import type { Facet, SearchResult, Wiki } from "./api";

type Row = { kind: "wiki"; wiki: Wiki } | { kind: "doc"; result: SearchResult };

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1 rounded bg-slate-100 dark:bg-slate-700 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-200">
      {label}
      <Button
        variant="ghost"
        onClick={onRemove}
        aria-label={`remove ${label}`}
        className="p-0 text-slate-400 hover:bg-transparent hover:text-slate-700 dark:hover:text-slate-200"
        icon={<XMarkIcon className="h-3.5 w-3.5" />}
      />
    </span>
  );
}

export function CommandPalette({
  wikiId,
  onOpenDoc,
  onSwitchWiki,
  onClose,
  initialFilters = [],
  initialCategory = null,
}: {
  wikiId: string;
  onOpenDoc: (id: string) => void;
  onSwitchWiki: (id: string) => void;
  onClose: () => void;
  initialFilters?: Facet[];
  initialCategory?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"wiki" | "all">("wiki");
  const [filters, setFilters] = useState<Facet[]>(initialFilters);
  const [category, setCategory] = useState<string | null>(initialCategory);
  const [selected, setSelected] = useState(0);
  const debounced = useDebounced(query, 180);
  const filterObject = useMemo(
    () => Object.fromEntries(filters.map((facet) => [facet.key, facet.value])),
    [filters],
  );
  const search = useSearch(wikiId, debounced, { scope, filters: filterObject, category });
  const wikis = useWikis();
  const constrained = filters.length > 0 || !!category;
  const showWikis = debounced.trim().length === 0 && !constrained;
  const rows: Row[] = showWikis
    ? (wikis.data ?? [])
        .filter((wiki) => wiki.id !== wikiId)
        .map((wiki) => ({ kind: "wiki", wiki }))
    : (search.data ?? []).map((result) => ({ kind: "doc", result }));

  useEffect(() => setSelected(0), [debounced, scope, showWikis, filterObject, category]);

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "wiki") onSwitchWiki(row.wiki.id);
    else if (row.result.wikiId && row.result.wikiId !== wikiId) onSwitchWiki(row.result.wikiId);
    else onOpenDoc(row.result.id);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((s) => Math.min(s + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(selected);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/30 sm:items-start sm:pt-24"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="search"
        className="flex h-full w-full flex-col bg-white shadow-xl dark:bg-slate-800 sm:h-auto sm:max-h-[80vh] sm:w-[80vw] sm:max-w-5xl sm:rounded-lg"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 dark:border-slate-800 p-2">
          {category && (
            <FilterChip label={`category: ${category}`} onRemove={() => setCategory(null)} />
          )}
          {filters.map((facet) => (
            <FilterChip
              key={facet.key}
              label={`${facet.key}: ${facet.value}`}
              onRemove={() => setFilters((current) => current.filter((f) => f.key !== facet.key))}
            />
          ))}
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or jump to a wiki…"
            className="min-w-[8rem] flex-1 px-2 py-1 text-sm outline-none"
          />
          {!showWikis && (
            <button
              onClick={() => setScope(scope === "wiki" ? "all" : "wiki")}
              className="cursor-pointer rounded bg-slate-100 dark:bg-slate-800 px-2 py-1 text-xs text-slate-600 dark:text-slate-300"
            >
              {scope === "all" ? "all wikis" : "this wiki"}
            </button>
          )}
          <Button
            variant="ghost"
            onClick={onClose}
            aria-label="close"
            className="px-2 leading-none"
            icon={<XMarkIcon className="h-5 w-5" />}
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {rows.map((row, index) => (
            <li key={row.kind === "wiki" ? `w-${row.wiki.id}` : `d-${row.result.id}`}>
              <button
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(index)}
                className={`block w-full cursor-pointer rounded px-2 py-1.5 text-left text-sm ${
                  index === selected ? "bg-slate-100 dark:bg-slate-800" : ""
                }`}
              >
                {row.kind === "wiki" ? (
                  <span>
                    Switch to <b>{row.wiki.label}</b>
                  </span>
                ) : (
                  <span className="block">
                    <span className="font-medium">
                      <Highlight text={row.result.title} query={debounced} />
                    </span>
                    <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
                      {row.result.wikiLabel ? `${row.result.wikiLabel} · ` : ""}
                      {row.result.location || row.result.category}
                    </span>
                    {row.result.snippet && (
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        <Highlight text={row.result.snippet} query={debounced} />
                      </span>
                    )}
                  </span>
                )}
              </button>
            </li>
          ))}
          {!showWikis && !search.isPending && rows.length === 0 && (
            <li className="px-2 py-2 text-sm text-slate-400 dark:text-slate-500">No results.</li>
          )}
          {showWikis && rows.length === 0 && (
            <li className="px-2 py-2 text-sm text-slate-400 dark:text-slate-500">
              Type to search this wiki…
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

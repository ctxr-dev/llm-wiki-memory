import { useEffect, useState, type KeyboardEvent } from "react";
import { useSearch, useWikis } from "./hooks";
import { useDebounced } from "./useDebounced";
import type { SearchResult, Wiki } from "./api";

type Row = { kind: "wiki"; wiki: Wiki } | { kind: "doc"; result: SearchResult };

export function CommandPalette({
  wikiId,
  onOpenDoc,
  onSwitchWiki,
  onClose,
}: {
  wikiId: string;
  onOpenDoc: (id: string) => void;
  onSwitchWiki: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"wiki" | "all">("wiki");
  const [selected, setSelected] = useState(0);
  const debounced = useDebounced(query, 180);
  const search = useSearch(wikiId, debounced, scope);
  const wikis = useWikis();
  const showWikis = debounced.trim().length === 0;
  const rows: Row[] = showWikis
    ? (wikis.data ?? []).map((wiki) => ({ kind: "wiki", wiki }))
    : (search.data ?? []).map((result) => ({ kind: "doc", result }));

  useEffect(() => setSelected(0), [debounced, scope, showWikis]);

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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-slate-100 p-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or jump to a wiki…"
            className="flex-1 px-2 py-1 text-sm outline-none"
          />
          {!showWikis && (
            <button
              onClick={() => setScope(scope === "wiki" ? "all" : "wiki")}
              className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600"
            >
              {scope === "all" ? "all wikis" : "this wiki"}
            </button>
          )}
        </div>
        <ul className="max-h-80 overflow-y-auto p-1">
          {rows.map((row, index) => (
            <li key={row.kind === "wiki" ? `w-${row.wiki.id}` : `d-${row.result.id}`}>
              <button
                onMouseEnter={() => setSelected(index)}
                onClick={() => choose(index)}
                className={`block w-full rounded px-2 py-1.5 text-left text-sm ${
                  index === selected ? "bg-slate-100" : ""
                }`}
              >
                {row.kind === "wiki" ? (
                  <span>
                    Switch to <b>{row.wiki.label}</b>
                  </span>
                ) : (
                  <span className="block">
                    <span className="font-medium">{row.result.name}</span>
                    <span className="ml-1 text-xs text-slate-400">
                      {row.result.wikiLabel ? `${row.result.wikiLabel} · ` : ""}
                      {row.result.category}
                    </span>
                    <span className="block truncate text-xs text-slate-500">
                      {row.result.snippet}
                    </span>
                  </span>
                )}
              </button>
            </li>
          ))}
          {!showWikis && !search.isPending && rows.length === 0 && (
            <li className="px-2 py-2 text-sm text-slate-400">No results.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

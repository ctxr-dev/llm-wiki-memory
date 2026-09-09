import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useWikis } from "./hooks";
import { api } from "./api";
import { AddWikiDialog } from "./AddWikiDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { CollapsibleColumn } from "./CollapsibleColumn";
import { HoverCard } from "./HoverCard";
import { WikiIcon } from "./WikiIcon";
import { WikiContextMenu } from "./WikiContextMenu";

export function Sidebar({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const wikis = useWikis();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ id: string; label: string } | null>(null);
  const [menu, setMenu] = useState<{ id: string; label: string; x: number; y: number } | null>(
    null,
  );
  const activeWiki = wikis.data?.find((wiki) => wiki.id === activeId);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["wikis"] });

  const remove = async (id: string) => {
    const next = (wikis.data ?? []).find((wiki) => wiki.id !== id);
    await api.removeWiki(id);
    await refresh();
    if (id === activeId && next) onSelect(next.id);
  };

  return (
    <CollapsibleColumn
      ariaLabel="wikis"
      railLabel="Wikis"
      storageKey="wikis"
      railContext={activeWiki?.label}
      expandedWidthClass="w-56"
      collapseBelowPx={1280}
      header={
        <span className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          Wikis
        </span>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {wikis.data?.map((wiki) => (
          <div
            key={wiki.id}
            className="flex items-center gap-1"
            onContextMenu={(event) => {
              if (wiki.kind !== "added") return;
              event.preventDefault();
              setMenu({ id: wiki.id, label: wiki.label, x: event.clientX, y: event.clientY });
            }}
          >
            <HoverCard
              side="right"
              className="min-w-0 flex-1"
              card={
                <div>
                  <div className="font-medium text-slate-700 dark:text-slate-200">{wiki.label}</div>
                  <div className="mt-1 break-all text-slate-500 dark:text-slate-400">
                    {wiki.mountDir}
                  </div>
                </div>
              }
            >
              <button
                onClick={() => onSelect(wiki.id)}
                className={`flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
                  wiki.id === activeId
                    ? "bg-slate-200 dark:bg-slate-700 font-medium"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <WikiIcon kind={wiki.kind} className="h-4 w-4 shrink-0" />
                <span className="truncate">{wiki.label}</span>
                <span className="ml-auto shrink-0 text-xs text-slate-400 dark:text-slate-500">
                  {wiki.kind === "home" ? "home" : "repo"}
                </span>
              </button>
            </HoverCard>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 p-2">
        <button
          onClick={() => setAdding(true)}
          className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-left text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <PlusIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          Add wiki
        </button>
      </div>
      {menu && (
        <WikiContextMenu
          x={menu.x}
          y={menu.y}
          onRemove={() => setPendingRemove({ id: menu.id, label: menu.label })}
          onDismiss={() => setMenu(null)}
        />
      )}
      {adding && <AddWikiDialog onClose={() => setAdding(false)} onAdded={refresh} />}
      {pendingRemove && (
        <ConfirmDialog
          label="remove wiki"
          title="Remove wiki?"
          message={`Remove “${pendingRemove.label}” from the sidebar? Its files are not deleted — only unlinked here.`}
          confirmLabel="Remove"
          confirmIcon={<TrashIcon className="h-4 w-4" />}
          danger
          onConfirm={() => {
            const id = pendingRemove.id;
            setPendingRemove(null);
            remove(id);
          }}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </CollapsibleColumn>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useWikis } from "./hooks";
import { api } from "./api";
import { AddWikiDialog } from "./AddWikiDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./Button";
import { CollapsibleColumn } from "./CollapsibleColumn";
import { HoverCard } from "./HoverCard";

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
          <div key={wiki.id} className="flex items-center gap-1">
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
                className={`w-full cursor-pointer truncate rounded px-2 py-1 text-left text-sm ${
                  wiki.id === activeId
                    ? "bg-slate-200 dark:bg-slate-700 font-medium"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                {wiki.label}
                <span className="ml-1 text-xs text-slate-400 dark:text-slate-500">
                  {wiki.kind === "home" ? "home" : "repo"}
                </span>
              </button>
            </HoverCard>
            {wiki.kind === "added" && (
              <Button
                variant="ghost"
                onClick={() => setPendingRemove({ id: wiki.id, label: wiki.label })}
                aria-label={`remove ${wiki.label}`}
                className="shrink-0 px-1 text-slate-400 hover:bg-transparent hover:text-slate-700 dark:hover:text-slate-200"
                icon={<XMarkIcon className="h-4 w-4" />}
              />
            )}
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 p-2">
        <button
          onClick={() => setAdding(true)}
          className="w-full cursor-pointer rounded px-2 py-1 text-left text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          + Add wiki
        </button>
      </div>
      {adding && <AddWikiDialog onClose={() => setAdding(false)} onAdded={refresh} />}
      {pendingRemove && (
        <ConfirmDialog
          label="remove wiki"
          title="Remove wiki?"
          message={`Remove “${pendingRemove.label}” from the sidebar? Its files are not deleted — only unlinked here.`}
          confirmLabel="Remove"
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

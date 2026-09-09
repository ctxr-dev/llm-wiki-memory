import { useEffect, useState, type ReactNode } from "react";
import { ArchiveBoxIcon, ArrowLeftIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import { useNav, useNavChildren } from "./hooks";
import { HoverCard } from "./HoverCard";
import { LeafCard } from "./LeafCard";
import { SettingsDialog } from "./SettingsDialog";
import { VirtualList } from "./VirtualList";
import { CollapsibleColumn } from "./CollapsibleColumn";
import { navItems, type NavItem } from "./navItems";
import { crumbLabel, locationLabel } from "./crumbs";

export type NavRequest = { category: string | null; path: string; token: number };

export function NavPanel({
  wikiId,
  onOpenDoc,
  request,
  showArchived,
  onToggleArchived,
}: {
  wikiId: string;
  onOpenDoc: (id: string) => void;
  request: NavRequest;
  showArchived: boolean;
  onToggleArchived: (next: boolean) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const nav = useNav(wikiId, showArchived);
  const children = useNavChildren(wikiId, category ?? "", path, showArchived);

  useEffect(() => {
    setCategory(request.category);
    setPath(request.path);
    setSettingsOpen(false);
  }, [request]);

  const railContext = category ? crumbLabel(category, path) : undefined;
  const shell = (header: ReactNode, content: ReactNode) => (
    <CollapsibleColumn
      ariaLabel="browse"
      railLabel="Categories"
      storageKey="categories"
      railContext={railContext}
      expandedWidthClass="w-64"
      collapseBelowPx={1024}
      expandToken={request.token}
      header={header}
    >
      {content}
    </CollapsibleColumn>
  );

  if (!category) {
    return (
      <>
        {shell(
          <div className="flex items-center justify-between px-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              Categories
            </span>
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Category settings"
              title="Category settings"
              className="cursor-pointer text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
            >
              <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>,
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {nav.data?.map((entry) => (
              <button
                key={entry.category}
                onClick={() => {
                  setCategory(entry.category);
                  setPath("");
                }}
                className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <span>{entry.label}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">{entry.count}</span>
              </button>
            ))}
          </div>,
        )}
        {settingsOpen && (
          <SettingsDialog
            showArchived={showArchived}
            onToggleArchived={onToggleArchived}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </>
    );
  }

  const segments = path ? path.split("/") : [];
  const goUp = () =>
    segments.length === 0 ? setCategory(null) : setPath(segments.slice(0, -1).join("/"));

  const renderItem = (item: NavItem) =>
    item.kind === "dir" ? (
      <button
        onClick={() => setPath(path ? `${path}/${item.name}` : item.name)}
        className="flex w-full cursor-pointer items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
      >
        <span className="truncate">{item.label}</span>
        <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">{item.count}</span>
      </button>
    ) : (
      <HoverCard
        side="right"
        card={
          <LeafCard
            title={item.title}
            name={item.name}
            location={locationLabel(item.id)}
            summary={item.summary}
          />
        }
      >
        <button
          onClick={() => onOpenDoc(item.id)}
          className="flex w-full cursor-pointer items-center gap-1 rounded px-2 py-1 text-left text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {!item.active && (
            <ArchiveBoxIcon className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-label="archived" />
          )}
          <span className="truncate">{item.title}</span>
        </button>
      </HoverCard>
    );

  return shell(
    <button
      onClick={goUp}
      className="flex cursor-pointer items-center gap-1 px-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
    >
      <ArrowLeftIcon className="h-3.5 w-3.5" aria-hidden="true" />
      {segments.length ? segments[segments.length - 1] : category}
    </button>,
    <VirtualList
      items={navItems(children.data)}
      estimateSize={30}
      className="min-h-0 flex-1 px-2 pb-2"
      renderItem={renderItem}
    />,
  );
}

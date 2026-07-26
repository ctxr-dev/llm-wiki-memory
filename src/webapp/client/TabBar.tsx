import { Fragment, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "./Button";
import { HoverCard } from "./HoverCard";
import { LeafCard } from "./LeafCard";
import { reorder } from "./tab-order";
import { locationLabel } from "./crumbs";
import type { TabOrientation } from "./TabContextMenu";

export function TabBar({
  tabs,
  active,
  pinnedIds = [],
  orientation = "horizontal",
  labelFor,
  onSelect,
  onClose,
  onReorder,
  onContextMenu,
}: {
  tabs: string[];
  active: string | null;
  pinnedIds?: string[];
  orientation?: TabOrientation;
  labelFor: (docId: string) => string;
  onSelect: (docId: string) => void;
  onClose: (docId: string) => void;
  onReorder: (next: string[]) => void;
  onContextMenu?: (docId: string, x: number, y: number) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const pinned = new Set(pinnedIds);
  const vertical = orientation === "vertical";

  const endDrag = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };
  const drop = (index: number) => {
    if (dragIndex !== null && dragIndex !== index) onReorder(reorder(tabs, dragIndex, index));
    endDrag();
  };

  const containerClass = vertical
    ? "flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-slate-200 dark:border-slate-700 p-2"
    : "flex flex-wrap items-center gap-1 border-b border-slate-200 dark:border-slate-700 px-2";

  const itemClass = (isActive: boolean) =>
    vertical
      ? `group relative flex items-center gap-1 rounded px-2 py-1.5 text-sm ${
          isActive
            ? "bg-slate-200 font-medium dark:bg-slate-700"
            : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
        }`
      : `group relative flex items-center gap-1 border-b-2 px-3 py-2 text-sm ${
          isActive ? "border-slate-800" : "border-transparent text-slate-500 dark:text-slate-400"
        }`;

  const indicator = (
    <div
      aria-hidden="true"
      data-drop-indicator="true"
      className={
        vertical
          ? "h-0.5 w-full rounded bg-emerald-500"
          : "w-0.5 self-stretch rounded bg-emerald-500"
      }
    />
  );

  return (
    <div className={containerClass}>
      {tabs.map((tab, index) => {
        const over = dragIndex !== null && dragOverIndex === index && dragIndex !== index;
        return (
          <Fragment key={tab}>
            {over && dragIndex > index && indicator}
            <div
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverIndex(index);
              }}
              onDrop={() => drop(index)}
              onDragEnd={endDrag}
              onContextMenu={(event) => {
                if (!onContextMenu) return;
                event.preventDefault();
                onContextMenu(tab, event.clientX, event.clientY);
              }}
              className={itemClass(tab === active)}
            >
              {pinned.has(tab) && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                  aria-hidden="true"
                />
              )}
              <HoverCard
                side={vertical ? "right" : "bottom"}
                className={vertical ? "min-w-0 flex-1" : "min-w-0"}
                card={
                  <LeafCard
                    title={labelFor(tab)}
                    name={tab.split("/").pop() ?? tab}
                    location={locationLabel(tab)}
                  />
                }
              >
                <button
                  onClick={() => onSelect(tab)}
                  className={`cursor-pointer truncate group-hover:pr-5 ${
                    vertical ? "w-full text-left" : "max-w-[14rem]"
                  }`}
                >
                  {labelFor(tab)}
                </button>
              </HoverCard>
              <Button
                variant="ghost"
                onClick={() => onClose(tab)}
                aria-label="close tab"
                className="absolute inset-y-0 right-0 flex items-center rounded-none px-1 text-slate-400 opacity-0 hover:bg-transparent focus-visible:opacity-100 group-hover:opacity-100 dark:text-slate-500"
                icon={<XMarkIcon className="h-4 w-4" />}
              />
            </div>
            {over && dragIndex < index && indicator}
          </Fragment>
        );
      })}
    </div>
  );
}

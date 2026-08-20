import type { ReactNode } from "react";

const LABELS: Record<string, string> = {
  pending: "Pending",
  "in-progress": "In progress",
  done: "Done",
  archived: "Archived",
  facts: "Facts",
};

export function BoardColumns<T>({
  columns,
  renderCard,
  emptyLabel,
}: {
  columns: Array<{ key: string; cards: T[] }>;
  renderCard: (card: T) => ReactNode;
  emptyLabel: string;
}) {
  if (columns.every((column) => column.cards.length === 0)) {
    return <div className="p-8 text-slate-400 dark:text-slate-500">{emptyLabel}</div>;
  }
  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4">
      {columns.map((column) => (
        <div
          key={column.key}
          className="flex w-72 shrink-0 flex-col rounded bg-slate-50 dark:bg-slate-800"
        >
          <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <span>{LABELS[column.key] ?? column.key}</span>
            <span>{column.cards.length}</span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2">{column.cards.map(renderCard)}</div>
        </div>
      ))}
    </div>
  );
}

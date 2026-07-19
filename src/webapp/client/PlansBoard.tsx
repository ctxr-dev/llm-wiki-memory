import { usePlans } from "./hooks";
import { BoardColumns } from "./BoardColumns";

export function PlansBoard({ wikiId, onOpen }: { wikiId: string; onOpen: (id: string) => void }) {
  const plans = usePlans(wikiId);
  if (plans.isPending)
    return <div className="p-6 text-slate-400 dark:text-slate-500">Loading…</div>;
  return (
    <BoardColumns
      columns={plans.data?.columns ?? []}
      emptyLabel="No plans in this wiki."
      renderCard={(card) => (
        <button
          key={card.id}
          onClick={() => onOpen(card.id)}
          className="block w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 text-left text-sm hover:border-slate-300 dark:hover:border-slate-600"
        >
          <div className="truncate font-medium text-slate-800 dark:text-slate-100">
            {card.title}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
            {card.progress && <span>{card.progress}</span>}
            {!card.active && (
              <span className="rounded bg-slate-100 dark:bg-slate-800 px-1">archived</span>
            )}
          </div>
        </button>
      )}
    />
  );
}

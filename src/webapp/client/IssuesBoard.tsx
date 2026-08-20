import { useIssues } from "./hooks";
import { BoardColumns } from "./BoardColumns";

export function IssuesBoard({ wikiId, onOpen }: { wikiId: string; onOpen: (id: string) => void }) {
  const issues = useIssues(wikiId);
  if (issues.isPending)
    return <div className="p-6 text-slate-400 dark:text-slate-500">Loading…</div>;
  if (!issues.data?.hasIssues) {
    return (
      <div className="p-8 text-slate-400 dark:text-slate-500">This wiki has no issues tracker.</div>
    );
  }
  return (
    <BoardColumns
      columns={issues.data.columns}
      emptyLabel="No issues."
      renderCard={(card) => (
        <button
          key={card.id}
          onClick={() => onOpen(card.id)}
          className="block w-full cursor-pointer rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-2 text-left text-sm hover:border-slate-300 dark:hover:border-slate-600"
        >
          <div className="font-mono font-medium text-slate-800 dark:text-slate-100">
            {card.prefix}-{card.number}
          </div>
          {card.slug && (
            <div className="truncate text-xs text-slate-500 dark:text-slate-400">{card.slug}</div>
          )}
          <div className="mt-1 text-xs text-slate-400 dark:text-slate-500">
            {card.tracker} · {card.kind}
          </div>
        </button>
      )}
    />
  );
}

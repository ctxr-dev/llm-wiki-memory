import type { RelatedEntry } from "./api";

export function RelatedPanel({
  related,
  onOpen,
}: {
  related: RelatedEntry[];
  onOpen: (id: string) => void;
}) {
  if (related.length === 0) return null;
  return (
    <div className="text-sm">
      <div className="mb-2 font-semibold text-slate-500 dark:text-slate-400">Related</div>
      <ul className="space-y-1">
        {related.map((entry) => (
          <li key={entry.id}>
            <button
              className="w-full truncate text-left text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
              onClick={() => onOpen(entry.id)}
              title={entry.id}
            >
              {entry.name}{" "}
              <span className="text-xs text-slate-400 dark:text-slate-500">
                {entry.score.toFixed(2)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

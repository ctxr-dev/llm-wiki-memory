import { ArchiveBoxIcon } from "@heroicons/react/24/outline";
import type { RelatedEntry } from "./api";
import { HoverCard } from "./HoverCard";
import { LeafCard } from "./LeafCard";

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
            <HoverCard
              side="left"
              card={
                <LeafCard
                  title={entry.title}
                  name={entry.name}
                  location={entry.location}
                  summary={entry.summary}
                  score={entry.score}
                />
              }
            >
              <button
                className="flex w-full cursor-pointer items-center gap-1 text-left text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
                onClick={() => onOpen(entry.id)}
              >
                {!entry.active && (
                  <ArchiveBoxIcon
                    className="h-3.5 w-3.5 shrink-0 text-slate-400"
                    aria-label="archived"
                  />
                )}
                <span className="truncate">{entry.title}</span>
                <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                  {entry.score.toFixed(2)}
                </span>
              </button>
            </HoverCard>
          </li>
        ))}
      </ul>
    </div>
  );
}

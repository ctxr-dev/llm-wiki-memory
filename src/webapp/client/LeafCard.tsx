import type { ReactNode } from "react";
import type { LeafSummary } from "./api";
import { PriorityBadge } from "./PriorityBadge";
import { humanizeValue } from "./facets";

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-16 shrink-0 text-slate-400 dark:text-slate-500">{label}</span>
      <span className="min-w-0 text-slate-700 dark:text-slate-200">{value}</span>
    </div>
  );
}

export function LeafCard({
  title,
  name,
  location,
  summary,
  score,
}: {
  title: string;
  name: string;
  location?: string;
  summary?: LeafSummary;
  score?: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="font-semibold text-slate-800 dark:text-slate-100">{title}</div>
      {location && <Row label="Location" value={location} />}
      {summary?.atomType && <Row label="Type" value={humanizeValue(summary.atomType)} />}
      {summary?.area && <Row label="Area" value={humanizeValue(summary.area)} />}
      {summary?.priority && <Row label="Priority" value={<PriorityBadge priority={summary.priority} />} />}
      {summary?.updated && <Row label="Updated" value={summary.updated} />}
      {typeof score === "number" && <Row label="Score" value={score.toFixed(3)} />}
      {summary?.tags && summary.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {summary.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.7rem] text-slate-600 dark:bg-slate-700 dark:text-slate-300"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <Row label="File" value={<span className="break-all font-mono text-[0.7rem]">{name}</span>} />
    </div>
  );
}

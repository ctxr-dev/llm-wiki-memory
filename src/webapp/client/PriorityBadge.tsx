import { PRIORITY_META, type Priority } from "./facets";

export function PriorityBadge({
  priority,
  className = "",
}: {
  priority: string;
  className?: string;
}) {
  const meta = PRIORITY_META[priority as Priority];
  if (!meta) return <span className={className}>{priority}</span>;
  return (
    <span
      title={meta.explanation}
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${meta.classes} ${className}`}
    >
      {meta.label}
    </span>
  );
}

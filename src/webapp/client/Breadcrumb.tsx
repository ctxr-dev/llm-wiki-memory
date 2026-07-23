import { docCrumbs } from "./crumbs";

export function Breadcrumb({
  docId,
  onNavigate,
}: {
  docId: string;
  onNavigate: (category: string, path: string) => void;
}) {
  const crumbs = docCrumbs(docId);
  if (crumbs.length === 0) return null;
  return (
    <nav
      aria-label="breadcrumb"
      className="flex flex-wrap items-center gap-1 border-b border-slate-200 dark:border-slate-700 px-3 py-1 text-xs text-slate-500 dark:text-slate-400"
    >
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.path}-${index}`} className="flex items-center gap-1">
          {index > 0 && <span className="text-slate-300 dark:text-slate-600">›</span>}
          <button
            onClick={() => onNavigate(crumb.category, crumb.path)}
            className="cursor-pointer hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

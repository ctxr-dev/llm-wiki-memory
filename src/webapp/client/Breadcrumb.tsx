import { useState } from "react";
import {
  ArchiveBoxIcon,
  LinkIcon,
  CheckIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { docCrumbs } from "./crumbs";
import { formatRef } from "./refs";
import { Button } from "./Button";
import type { Wiki } from "./api";

export function Breadcrumb({
  docId,
  wiki,
  onNavigate,
  onEdit,
  editing = false,
  archived = false,
}: {
  docId: string;
  wiki?: Wiki;
  onNavigate: (category: string, path: string) => void;
  onEdit?: () => void;
  editing?: boolean;
  archived?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const crumbs = docCrumbs(docId);
  if (crumbs.length === 0) return null;
  const copyReference = () => {
    if (!wiki || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(formatRef(wiki, docId))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <nav
      aria-label="breadcrumb"
      className="flex flex-wrap items-center gap-1 border-b border-slate-200 dark:border-slate-700 px-3 py-1 text-xs text-slate-500 dark:text-slate-400"
    >
      {archived && (
        <ArchiveBoxIcon
          className="h-4 w-4 shrink-0 text-slate-400"
          aria-label="archived"
          title="Archived"
        />
      )}
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.path}-${index}`} className="flex items-center gap-1">
          {index > 0 && (
            <span aria-hidden="true" className="text-slate-300 dark:text-slate-600">
              ›
            </span>
          )}
          <button
            onClick={() => onNavigate(crumb.category, crumb.path)}
            className="cursor-pointer hover:text-slate-800 dark:hover:text-slate-200 hover:underline"
          >
            {crumb.label}
          </button>
        </span>
      ))}
      <div className="ml-auto flex items-center gap-1">
        {onEdit && !editing && (
          <Button
            variant="ghost"
            onClick={onEdit}
            aria-label="edit"
            title="Edit"
            className="px-1 py-0.5"
            icon={<PencilSquareIcon className="h-3.5 w-3.5" />}
          />
        )}
        {wiki && (
          <Button
            variant="ghost"
            onClick={copyReference}
            aria-label={copied ? "reference copied" : "copy reference"}
            title={copied ? "Reference copied" : "Copy reference"}
            className="px-1 py-0.5"
            icon={
              copied ? (
                <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <LinkIcon className="h-3.5 w-3.5" />
              )
            }
          />
        )}
      </div>
    </nav>
  );
}

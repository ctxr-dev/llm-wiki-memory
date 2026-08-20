import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { CodeBlock } from "./CodeBlock";

export function MetaBlock({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4 rounded border border-slate-200 dark:border-slate-700">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1 px-3 py-1.5 text-left text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
      >
        {open ? (
          <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        metadata · {lines.length} fields
      </button>
      {open && (
        <div className="border-t border-slate-100 dark:border-slate-800 px-2">
          <CodeBlock code={lines.join("\n")} lang="yaml" />
        </div>
      )}
    </div>
  );
}

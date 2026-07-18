import { useState } from "react";
import type { DocView } from "./api";

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
      <span className="text-slate-400">{label}:</span> {value}
    </span>
  );
}

function chipsFor(doc: DocView): Array<[string, string]> {
  const mem = doc.memory as Record<string, unknown>;
  const chips: Array<[string, string]> = [["category", doc.category]];
  if (typeof mem.area === "string") chips.push(["area", mem.area]);
  if (typeof mem.atom_type === "string") chips.push(["type", mem.atom_type]);
  if (typeof mem.task_type === "string") chips.push(["task", mem.task_type]);
  if (Array.isArray(mem.subject)) chips.push(["subject", mem.subject.join(" / ")]);
  if (typeof mem.priority === "string") chips.push(["priority", mem.priority]);
  if (!doc.active) chips.push(["status", "archived"]);
  return chips;
}

export function FrontmatterCard({ doc }: { doc: DocView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-5 rounded border border-slate-200">
      <div className="flex flex-wrap items-center gap-2 p-2">
        {chipsFor(doc).map(([label, value]) => (
          <Chip key={label} label={label} value={value} />
        ))}
        <button
          className="ml-auto text-xs text-slate-500 hover:text-slate-800"
          onClick={() => setOpen(!open)}
        >
          {open ? "hide frontmatter" : "frontmatter"}
        </button>
      </div>
      {open && (
        <pre className="overflow-x-auto border-t border-slate-100 p-2 text-xs text-slate-600">
          {JSON.stringify(doc.frontmatter, null, 2)}
        </pre>
      )}
    </div>
  );
}

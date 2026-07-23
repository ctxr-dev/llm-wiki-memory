import { useState } from "react";
import type { DocView, Facet } from "./api";
import { CodeBlock } from "./CodeBlock";

type ChipData = { label: string; value: string; facet?: Facet };

function Chip({ chip, onChip }: { chip: ChipData; onChip?: (facet: Facet) => void }) {
  const body = (
    <>
      <span className="text-slate-400 dark:text-slate-500">{chip.label}:</span> {chip.value}
    </>
  );
  const base =
    "rounded bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-200";
  if (chip.facet && onChip) {
    const facet = chip.facet;
    return (
      <button
        onClick={() => onChip(facet)}
        title={`Search ${facet.key}: ${facet.value}`}
        className={`${base} cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700`}
      >
        {body}
      </button>
    );
  }
  return <span className={base}>{body}</span>;
}

function chipsFor(doc: DocView): ChipData[] {
  const mem = doc.memory;
  const chips: ChipData[] = [
    { label: "category", value: doc.category, facet: { key: "category", value: doc.category } },
  ];
  if (typeof mem.area === "string")
    chips.push({ label: "area", value: mem.area, facet: { key: "area", value: mem.area } });
  if (typeof mem.atom_type === "string")
    chips.push({
      label: "type",
      value: mem.atom_type,
      facet: { key: "atom_type", value: mem.atom_type },
    });
  if (typeof mem.task_type === "string")
    chips.push({
      label: "task",
      value: mem.task_type,
      facet: { key: "task_type", value: mem.task_type },
    });
  if (Array.isArray(mem.subject) && mem.subject.length)
    chips.push({
      label: "subject",
      value: mem.subject.join(" / "),
      facet: { key: "subject", value: String(mem.subject[0]) },
    });
  if (typeof mem.priority === "string")
    chips.push({
      label: "priority",
      value: mem.priority,
      facet: { key: "priority", value: mem.priority },
    });
  if (!doc.active) chips.push({ label: "status", value: "archived" });
  return chips;
}

export function FrontmatterCard({
  doc,
  onChip,
}: {
  doc: DocView;
  onChip?: (facet: Facet) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-5 rounded border border-slate-200 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2 p-2">
        {chipsFor(doc).map((chip) => (
          <Chip key={chip.label} chip={chip} onChip={onChip} />
        ))}
        <button
          className="ml-auto cursor-pointer text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
          onClick={() => setOpen(!open)}
        >
          {open ? "hide frontmatter" : "frontmatter"}
        </button>
      </div>
      {open && (
        <div className="border-t border-slate-100 dark:border-slate-800 px-2">
          <CodeBlock code={JSON.stringify(doc.frontmatter, null, 2)} lang="json" />
        </div>
      )}
    </div>
  );
}

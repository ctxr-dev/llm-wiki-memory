import type { ReactNode } from "react";
import type { MemoryInput } from "./api";

const ATOM_TYPES = [
  "decision",
  "bug-root-cause",
  "feedback-rule",
  "project-lore",
  "reference",
  "pattern-gotcha",
  "self-improvement-lesson",
  "plan",
];
const TASK_TYPES = [
  "planning",
  "implementation",
  "debugging",
  "refactor",
  "review",
  "deploy",
  "docs",
  "unknown",
];
const PRIORITIES = ["P0", "P1", "P2"];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

export function FrontmatterForm({
  category,
  memory,
  onChange,
}: {
  category: string;
  memory: MemoryInput;
  onChange: (memory: MemoryInput) => void;
}) {
  const get = (key: string) => (typeof memory[key] === "string" ? (memory[key] as string) : "");
  const subject = Array.isArray(memory.subject) ? (memory.subject as string[]).join(", ") : "";
  const set = (key: string, value: unknown) => onChange({ ...memory, [key]: value });
  const input = "rounded border border-slate-200 px-2 py-1 text-sm";

  const select = (key: string, options: string[]) => (
    <select
      value={get(key)}
      onChange={(event) => set(key, event.target.value || undefined)}
      className={input}
    >
      <option value="">—</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );

  return (
    <div className="grid grid-cols-2 gap-3 rounded border border-slate-200 p-3 lg:grid-cols-3">
      <Field label="area">
        <input
          value={get("area")}
          onChange={(e) => set("area", e.target.value || undefined)}
          className={input}
        />
      </Field>
      <Field label="atom_type">{select("atom_type", ATOM_TYPES)}</Field>
      {category === "self_improvement" && (
        <Field label="task_type">{select("task_type", TASK_TYPES)}</Field>
      )}
      <Field label="priority">{select("priority", PRIORITIES)}</Field>
      <Field label="subject (comma-separated)">
        <input
          value={subject}
          onChange={(e) =>
            set(
              "subject",
              e.target.value
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean),
            )
          }
          className={input}
        />
      </Field>
    </div>
  );
}

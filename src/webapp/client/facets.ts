export type Priority = "P0" | "P1" | "P2";

export const PRIORITY_ORDER: Priority[] = ["P0", "P1", "P2"];

export const PRIORITY_META: Record<
  Priority,
  { label: string; explanation: string; classes: string }
> = {
  P0: {
    label: "P0",
    explanation: "Hard constraint — a guardrail that must be honoured; governs on conflict.",
    classes: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  P1: {
    label: "P1",
    explanation: "Strong default — apply whenever it's relevant.",
    classes: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  P2: {
    label: "P2",
    explanation: "Contextual — apply if relevant and there's room.",
    classes: "bg-slate-200 text-slate-600 dark:bg-slate-600 dark:text-slate-200",
  },
};

export const ATOM_TYPES = [
  "decision",
  "bug-root-cause",
  "feedback-rule",
  "project-lore",
  "reference",
  "pattern-gotcha",
  "self-improvement-lesson",
  "plan",
];

export const TASK_TYPES = [
  "planning",
  "implementation",
  "debugging",
  "refactor",
  "review",
  "deploy",
  "docs",
  "unknown",
];

const FACET_LABELS: Record<string, string> = {
  area: "Area",
  atom_type: "Atom type",
  task_type: "Task type",
  priority: "Priority",
  subject: "Subject",
  language: "Language",
  error_pattern: "Error pattern",
  tags: "Tags",
};

export function humanizeFacet(key: string): string {
  const known = FACET_LABELS[key];
  if (known) return known;
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function humanizeValue(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

import type { ReactNode } from "react";
import type { FacetsResponse, MemoryInput } from "./api";
import { Select } from "./Select";
import { Combobox } from "./Combobox";
import { TagInput } from "./TagInput";
import { FieldLabel } from "./FieldLabel";
import { PriorityBadge } from "./PriorityBadge";
import {
  ATOM_TYPES,
  TASK_TYPES,
  PRIORITY_ORDER,
  PRIORITY_META,
  humanizeValue,
  type Priority,
} from "./facets";

function priorityValue(value: string) {
  return <PriorityBadge priority={value} />;
}

function priorityOption(value: string) {
  return (
    <span className="flex items-start gap-2">
      <PriorityBadge priority={value} className="mt-0.5 shrink-0" />
      <span className="whitespace-normal text-slate-500 dark:text-slate-400">
        {PRIORITY_META[value as Priority]?.explanation}
      </span>
    </span>
  );
}

export function FrontmatterForm({
  category,
  memory,
  onChange,
  facets,
}: {
  category: string;
  memory: MemoryInput;
  onChange: (memory: MemoryInput) => void;
  facets?: FacetsResponse;
}) {
  const meta = facets?.meta ?? {};
  const get = (key: string) => (typeof memory[key] === "string" ? (memory[key] as string) : "");
  const subject = Array.isArray(memory.subject) ? (memory.subject as string[]) : [];
  const set = (key: string, value: unknown) => onChange({ ...memory, [key]: value });

  const fieldId = (key: string) => `fm-${key}`;
  const label = (key: string) => (
    <FieldLabel facet={key} htmlFor={fieldId(key)} description={meta[key]?.description} />
  );

  const selectField = (
    key: string,
    options: string[],
    render?: {
      valueLabel?: (value: string) => ReactNode;
      optionLabel?: (value: string) => ReactNode;
    },
  ) => (
    <div className="flex flex-col gap-1">
      {label(key)}
      <Select
        id={fieldId(key)}
        value={get(key)}
        options={options}
        valueLabel={render?.valueLabel ?? humanizeValue}
        optionLabel={render?.optionLabel ?? humanizeValue}
        onChange={(value) => set(key, value || undefined)}
      />
    </div>
  );

  return (
    <div className="grid grid-cols-2 gap-3 rounded border border-slate-200 dark:border-slate-700 p-3 lg:grid-cols-3">
      <div className="flex flex-col gap-1">
        {label("area")}
        <Combobox
          id={fieldId("area")}
          value={get("area")}
          options={facets?.areas ?? []}
          labelFor={humanizeValue}
          onChange={(value) => set("area", value || undefined)}
        />
      </div>
      {selectField("atom_type", ATOM_TYPES)}
      {category === "self_improvement" && selectField("task_type", TASK_TYPES)}
      {selectField("priority", PRIORITY_ORDER, {
        valueLabel: priorityValue,
        optionLabel: priorityOption,
      })}
      <div className="flex flex-col gap-1">
        {label("subject")}
        <TagInput
          id={fieldId("subject")}
          value={subject}
          options={facets?.subjects ?? []}
          labelFor={humanizeValue}
          onChange={(value) => set("subject", value)}
        />
      </div>
    </div>
  );
}

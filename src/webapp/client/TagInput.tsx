import { useEffect, useId, useRef, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Highlight } from "./Highlight";

export function addTag(tags: string[], raw: string): string[] {
  const value = raw.trim();
  if (!value || tags.includes(value)) return tags;
  return [...tags, value];
}

export function removeTag(tags: string[], value: string): string[] {
  return tags.filter((tag) => tag !== value);
}

export function suggestTags(options: string[], chosen: string[], query: string): string[] {
  const available = options.filter((option) => !chosen.includes(option));
  const q = query.trim().toLowerCase();
  if (!q) return available;
  return available.filter((option) => option.toLowerCase().includes(q));
}

export function TagInput({
  value,
  options,
  id,
  placeholder,
  labelFor = (candidate) => candidate,
  onChange,
}: {
  value: string[];
  options: string[];
  id?: string;
  placeholder?: string;
  labelFor?: (value: string) => string;
  onChange: (value: string[]) => void;
}) {
  const base = useId();
  const listboxId = `${base}-listbox`;
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const suggestions = suggestTags(options, value, draft);

  const commit = (raw: string) => {
    onChange(addTag(value, raw));
    setDraft("");
    setOpen(false);
    setActive(-1);
  };

  const addMany = (text: string) => {
    const next = text.split(",").reduce((tags, piece) => addTag(tags, piece), value);
    if (next !== value) onChange(next);
    setDraft("");
  };

  return (
    <div ref={ref} className="relative">
      <div className="flex flex-wrap items-center gap-1 rounded border border-slate-200 bg-transparent px-1.5 py-1 dark:border-slate-700">
        {value.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200"
          >
            {labelFor(tag)}
            <button
              type="button"
              aria-label={`Remove ${labelFor(tag)}`}
              onClick={() => onChange(removeTag(value, tag))}
              className="cursor-pointer text-slate-400 hover:text-slate-700 dark:hover:text-slate-100"
            >
              <XMarkIcon className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          placeholder={value.length === 0 ? placeholder : ""}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${base}-opt-${active}` : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!text.includes(",")) return;
            event.preventDefault();
            addMany(text);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((prev) => Math.min(prev + 1, suggestions.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((prev) => Math.max(prev - 1, 0));
            } else if (event.key === "Enter") {
              if (open && active >= 0 && active < suggestions.length) {
                event.preventDefault();
                commit(suggestions[active]);
              } else if (draft.trim()) {
                event.preventDefault();
                commit(draft);
              }
            } else if (event.key === "," && draft.trim()) {
              event.preventDefault();
              commit(draft);
            } else if (event.key === "Backspace" && !draft && value.length > 0) {
              onChange(value.slice(0, -1));
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          className="min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-slate-800 outline-none dark:text-slate-100"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          {suggestions.map((option, index) => (
            <li key={option}>
              <button
                type="button"
                id={`${base}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(option)}
                className={`flex w-full cursor-pointer px-2 py-1 text-left text-sm text-slate-700 dark:text-slate-200 ${
                  index === active
                    ? "bg-slate-100 dark:bg-slate-700"
                    : "hover:bg-slate-100 dark:hover:bg-slate-700"
                }`}
              >
                <Highlight text={labelFor(option)} query={draft} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

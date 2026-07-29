import { useEffect, useId, useRef, useState } from "react";
import { ChevronUpDownIcon } from "@heroicons/react/24/outline";
import { Highlight } from "./Highlight";

const IDENTITY = (value: string) => value;

export function filterOptions(options: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((option) => option.toLowerCase().includes(q));
}

export function Combobox({
  value,
  options,
  id,
  placeholder,
  labelFor = IDENTITY,
  onChange,
}: {
  value: string;
  options: string[];
  id?: string;
  placeholder?: string;
  labelFor?: (value: string) => string;
  onChange: (value: string) => void;
}) {
  const base = useId();
  const listboxId = `${base}-listbox`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [draft, setDraft] = useState(() => labelFor(value));
  const focused = useRef(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focused.current) setDraft(labelFor(value));
  }, [value, labelFor]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const matches = filterOptions(options, draft);

  const choose = (next: string) => {
    onChange(next);
    setDraft(focused.current ? next : labelFor(next));
    setOpen(false);
    setActive(-1);
  };

  return (
    <div ref={ref} className="relative">
      <div className="flex items-center rounded border border-slate-200 bg-transparent dark:border-slate-700">
        <input
          id={id}
          value={draft}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${base}-opt-${active}` : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            onChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => {
            focused.current = true;
            setDraft(value);
            setOpen(true);
          }}
          onBlur={() => {
            focused.current = false;
            setDraft(labelFor(value));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            else if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((prev) => Math.min(prev + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((prev) => Math.max(prev - 1, 0));
            } else if (event.key === "Enter" && open && active >= 0 && active < matches.length) {
              event.preventDefault();
              choose(matches[active]);
            }
          }}
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm text-slate-800 outline-none dark:text-slate-100"
        />
        <button
          type="button"
          aria-label="Toggle suggestions"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((prev) => !prev)}
          className="shrink-0 cursor-pointer px-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          <ChevronUpDownIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {open && matches.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          {matches.map((option, index) => (
            <li key={option}>
              <button
                type="button"
                id={`${base}-opt-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
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

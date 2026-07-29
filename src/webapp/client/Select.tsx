import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronUpDownIcon, CheckIcon } from "@heroicons/react/24/outline";

export function Select({
  value,
  options,
  placeholder = "—",
  ariaLabel,
  id,
  optionLabel,
  valueLabel,
  onChange,
}: {
  value: string;
  options: string[];
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  optionLabel?: (value: string) => ReactNode;
  valueLabel?: (value: string) => ReactNode;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const rows = ["", ...options];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 rounded border border-slate-200 bg-transparent px-2 py-1 text-left text-sm text-slate-800 hover:border-slate-300 dark:border-slate-700 dark:text-slate-100 dark:hover:border-slate-600"
      >
        <span className={value ? "truncate" : "truncate text-slate-400 dark:text-slate-500"}>
          {value ? (valueLabel ? valueLabel(value) : value) : placeholder}
        </span>
        <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          {rows.map((option) => {
            const selected = option === value;
            return (
              <li key={option || "__none"}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(option)}
                  className={`flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700 ${
                    option
                      ? "text-slate-700 dark:text-slate-200"
                      : "text-slate-500 dark:text-slate-400"
                  }`}
                >
                  {selected ? (
                    <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
                  ) : (
                    <span className="w-4 shrink-0" aria-hidden="true" />
                  )}
                  {option ? (optionLabel ? optionLabel(option) : option) : placeholder}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

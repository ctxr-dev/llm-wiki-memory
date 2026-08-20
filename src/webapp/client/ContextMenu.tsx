import { useEffect, useRef, type ReactNode } from "react";

export const contextMenuItemClass =
  "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700";

export function ContextMenu({
  x,
  y,
  ariaLabel,
  onDismiss,
  children,
}: {
  x: number;
  y: number;
  ariaLabel: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      style={{ top: y, left: x }}
      className="fixed z-50 min-w-[12rem] rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
    >
      {children}
    </div>
  );
}

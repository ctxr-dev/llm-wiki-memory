import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";

/**
 * Collapse state driven by available width, NOT persisted user state: the column
 * starts collapsed when the viewport is narrower than `collapseBelowPx` and expands
 * when it is wider. Crossing that width applies the new default (via the media-query
 * `change` event), overriding any in-session manual toggle; between crossings the
 * user's manual choice stands. SSR / no-matchMedia environments default to expanded.
 * @param {number} collapseBelowPx
 * @returns {readonly [boolean, (value: boolean) => void]}
 */
function useResponsiveCollapsed(collapseBelowPx: number) {
  const query = `(max-width: ${collapseBelowPx - 1}px)`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return globalThis.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query);
    if (!mql) return undefined;
    const onChange = (event: MediaQueryListEvent) => setCollapsed(event.matches);
    mql.addEventListener("change", onChange);
    setCollapsed(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return [collapsed, setCollapsed] as const;
}

/**
 * A column that can slide shut to a thin rail (a chevron plus a vertical label and
 * its current context) to give the document viewer more room, and expand back. One
 * persistent element animates its width so the collapse/expand reads as a slide.
 * `side` places the border and points the chevrons; `as` picks the semantic element
 * (nav for the browse columns, aside for the complementary TOC/Related column); a
 * change to `expandToken` force-expands the column (e.g. selecting a wiki reveals the
 * categories the user is about to browse).
 */
export function CollapsibleColumn({
  as = "nav",
  side = "left",
  ariaLabel,
  railLabel,
  railContext,
  expandedWidthClass,
  collapseBelowPx,
  className = "",
  expandToken,
  header,
  children,
}: {
  as?: "nav" | "aside";
  side?: "left" | "right";
  ariaLabel: string;
  railLabel: string;
  railContext?: string;
  expandedWidthClass: string;
  collapseBelowPx: number;
  className?: string;
  expandToken?: number;
  header: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useResponsiveCollapsed(collapseBelowPx);
  const toggledByUser = useRef(false);
  const expandSeen = useRef(false);
  const expandRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!toggledByUser.current) return;
    (collapsed ? expandRef : collapseRef).current?.focus();
    toggledByUser.current = false;
  }, [collapsed]);

  useEffect(() => {
    if (!expandSeen.current) {
      expandSeen.current = true;
      return;
    }
    setCollapsed(false);
  }, [expandToken, setCollapsed]);

  const toggle = (next: boolean) => {
    toggledByUser.current = true;
    setCollapsed(next);
  };

  const Element = as;
  const CollapseIcon = side === "left" ? ChevronLeftIcon : ChevronRightIcon;
  const ExpandIcon = side === "left" ? ChevronRightIcon : ChevronLeftIcon;
  const borderClass = side === "left" ? "border-r" : "border-l";

  return (
    <Element
      aria-label={ariaLabel}
      className={`flex shrink-0 flex-col overflow-hidden border-slate-200 transition-[width] duration-200 ease-in-out dark:border-slate-700 ${borderClass} ${
        collapsed ? "w-10" : expandedWidthClass
      } ${className}`}
    >
      {collapsed ? (
        <button
          ref={expandRef}
          onClick={() => toggle(false)}
          aria-label={`expand ${railLabel}`}
          title={railContext ? `Expand ${railLabel} — ${railContext}` : `Expand ${railLabel}`}
          className="flex h-full w-full cursor-pointer flex-col items-center gap-2 overflow-hidden pt-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <ExpandIcon className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600 [writing-mode:vertical-rl] dark:text-slate-300">
            {railLabel}
          </span>
          {railContext && (
            <span className="text-xs text-slate-500 [writing-mode:vertical-rl] dark:text-slate-400">
              {railContext}
            </span>
          )}
        </button>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between gap-1 p-2 pb-1">
            <div className="min-w-0 flex-1">{header}</div>
            <button
              ref={collapseRef}
              onClick={() => toggle(true)}
              aria-label={`collapse ${railLabel}`}
              title={`Collapse ${railLabel}`}
              className="shrink-0 cursor-pointer rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <CollapseIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {children}
        </>
      )}
    </Element>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";

export type ColumnPreference = "expanded" | "collapsed";

const PREF_PREFIX = "lwm-column:";

/**
 * Read a column's remembered preference. `null` means the user has never touched
 * this column, which is what keeps the purely automatic behaviour for everyone
 * who is happy with it.
 */
export function readColumnPreference(storageKey?: string): ColumnPreference | null {
  if (!storageKey) return null;
  try {
    const raw = globalThis.localStorage?.getItem(PREF_PREFIX + storageKey);
    return raw === "expanded" || raw === "collapsed" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Collapse state, driven by available width UNTIL the user expresses a choice.
 *
 * Three cases, and the asymmetry between them is deliberate:
 * - **Never touched** (no stored preference): width decides, exactly as before.
 * - **User expanded**: width may still collapse it, because a column held open in
 *   a viewport too narrow to show the document is not honouring the choice, it is
 *   just breaking the page. When the room comes back, the column reopens.
 * - **User collapsed**: nothing reopens it automatically. Not a width change, not
 *   `expandToken`. A column the user shut stays shut until they open it.
 *
 * So the automatic rules can always take space AWAY from a column, and may only
 * give it back to one the user has not explicitly closed.
 * @param collapseBelowPx viewport width under which the column cannot be shown
 * @param storageKey omit to keep the old purely-automatic behaviour
 */
function useResponsiveCollapsed(collapseBelowPx: number, storageKey?: string) {
  const query = `(max-width: ${collapseBelowPx - 1}px)`;
  const [preference, setPreference] = useState<ColumnPreference | null>(() =>
    readColumnPreference(storageKey),
  );
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (preference === "collapsed") return true;
    try {
      return globalThis.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  });
  /**
   * The preference is read through a ref, NOT taken as a dependency. As a
   * dependency the effect re-runs the moment the user clicks, immediately
   * re-applying the current width: in a narrow viewport that re-collapsed the
   * column the click had just opened, making the expand button do nothing. The
   * "too little space" exception is about width TRANSITIONS, not about vetoing
   * an explicit request to see the column right now.
   */
  const preferenceRef = useRef(preference);
  preferenceRef.current = preference;
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query);
    if (!mql) return undefined;
    const apply = (narrow: boolean) => {
      setCollapsed(preferenceRef.current === "collapsed" ? true : narrow);
    };
    const onChange = (event: MediaQueryListEvent) => apply(event.matches);
    mql.addEventListener("change", onChange);
    apply(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  const choose = (next: boolean) => {
    /**
     * Without a storageKey the column keeps the original purely width-driven
     * contract: no preference is recorded, so width still wins every time. The
     * remember-my-choice behaviour is opt-in per column, not a global change.
     */
    if (!storageKey) {
      setCollapsed(next);
      return;
    }
    const value: ColumnPreference = next ? "collapsed" : "expanded";
    setPreference(value);
    try {
      globalThis.localStorage?.setItem(PREF_PREFIX + storageKey, value);
    } catch {
      /** private mode or a full quota: the column still works, it just forgets */
    }
    setCollapsed(next);
  };
  /**
   * `autoExpand` is the AUTOMATIC door and records nothing; `choose` is the
   * user's and persists. Keeping them apart is what stops a helpful auto-expand
   * from being remembered as a preference the user never expressed, and putting
   * the never-reopen rule HERE keeps every automatic transition governed by one
   * place instead of each caller remembering to check.
   */
  const autoExpand = useCallback(() => {
    if (preferenceRef.current === "collapsed") return;
    setCollapsed(false);
  }, []);
  return { collapsed, choose, autoExpand } as const;
}

/**
 * A column that can slide shut to a thin rail (a chevron plus a vertical label and
 * its current context) to give the document viewer more room, and expand back. One
 * persistent element animates its width so the collapse/expand reads as a slide.
 * `side` places the border and points the chevrons; `as` picks the semantic element
 * (nav for the browse columns, aside for the complementary TOC/Related column); a
 * change to `expandToken` force-expands the column (e.g. selecting a wiki reveals the
 * categories the user is about to browse) UNLESS the user has collapsed it, which
 * nothing automatic overrides.
 *
 * Pass `storageKey` to make the user's collapse/expand choice stick across reloads.
 * Without one the column keeps the purely width-driven behaviour.
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
  collapsedClassName = "",
  expandedClassName = "",
  expandToken,
  storageKey,
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
  collapsedClassName?: string;
  expandedClassName?: string;
  expandToken?: number;
  storageKey?: string;
  header: ReactNode;
  children: ReactNode;
}) {
  const { collapsed, choose, autoExpand } = useResponsiveCollapsed(collapseBelowPx, storageKey);
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
    /**
     * A column the user collapsed is not reopened by navigation either: revealing
     * the categories for a freshly picked wiki is exactly the kind of helpful
     * automatic expand they were overriding when they shut it. `autoExpand`
     * enforces that.
     */
    autoExpand();
  }, [expandToken, autoExpand]);

  const toggle = (next: boolean) => {
    toggledByUser.current = true;
    choose(next);
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
      } ${className} ${collapsed ? collapsedClassName : expandedClassName}`}
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

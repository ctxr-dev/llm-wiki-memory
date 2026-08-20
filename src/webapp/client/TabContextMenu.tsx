import {
  XMarkIcon,
  XCircleIcon,
  BookmarkIcon,
  BookmarkSlashIcon,
  LinkIcon,
  Bars3Icon,
  ViewColumnsIcon,
  CheckIcon,
} from "@heroicons/react/24/outline";
import { ContextMenu, contextMenuItemClass } from "./ContextMenu";

export type TabOrientation = "horizontal" | "vertical";

const ICON = "h-4 w-4 shrink-0";

export function TabContextMenu({
  x,
  y,
  isPinned,
  orientation,
  onCloseTab,
  onCloseOthers,
  onTogglePin,
  onCopyReference,
  onSetOrientation,
  onDismiss,
}: {
  x: number;
  y: number;
  isPinned: boolean;
  orientation: TabOrientation;
  onCloseTab: () => void;
  onCloseOthers: () => void;
  onTogglePin: () => void;
  onCopyReference: () => void;
  onSetOrientation: (orientation: TabOrientation) => void;
  onDismiss: () => void;
}) {
  const run = (action: () => void) => () => {
    action();
    onDismiss();
  };

  return (
    <ContextMenu x={x} y={y} ariaLabel="tab actions" onDismiss={onDismiss}>
      <button role="menuitem" className={contextMenuItemClass} onClick={run(onCloseTab)}>
        <XMarkIcon className={ICON} aria-hidden="true" />
        Close
      </button>
      <button role="menuitem" className={contextMenuItemClass} onClick={run(onCloseOthers)}>
        <XCircleIcon className={ICON} aria-hidden="true" />
        Close Others
      </button>
      <button role="menuitem" className={contextMenuItemClass} onClick={run(onTogglePin)}>
        {isPinned ? (
          <BookmarkSlashIcon className={ICON} aria-hidden="true" />
        ) : (
          <BookmarkIcon className={ICON} aria-hidden="true" />
        )}
        {isPinned ? "Unpin" : "Pin to Start"}
      </button>
      <button role="menuitem" className={contextMenuItemClass} onClick={run(onCopyReference)}>
        <LinkIcon className={ICON} aria-hidden="true" />
        Copy reference
      </button>
      <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
      <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        Orientation
      </div>
      <button
        role="menuitemradio"
        aria-checked={orientation === "horizontal"}
        className={contextMenuItemClass}
        onClick={run(() => onSetOrientation("horizontal"))}
      >
        <Bars3Icon className={ICON} aria-hidden="true" />
        Horizontal
        {orientation === "horizontal" && (
          <CheckIcon className="ml-auto h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
      </button>
      <button
        role="menuitemradio"
        aria-checked={orientation === "vertical"}
        className={contextMenuItemClass}
        onClick={run(() => onSetOrientation("vertical"))}
      >
        <ViewColumnsIcon className={ICON} aria-hidden="true" />
        Vertical
        {orientation === "vertical" && (
          <CheckIcon className="ml-auto h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
      </button>
    </ContextMenu>
  );
}

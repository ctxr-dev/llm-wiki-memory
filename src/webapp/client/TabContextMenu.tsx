import { ContextMenu, contextMenuItemClass } from "./ContextMenu";

export type TabOrientation = "horizontal" | "vertical";

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
        Close
      </button>
      <button role="menuitem" className={contextMenuItemClass} onClick={run(onCloseOthers)}>
        Close Others
      </button>
      <button role="menuitem" className={contextMenuItemClass} onClick={run(onTogglePin)}>
        {isPinned ? "Unpin" : "Pin to Start"}
      </button>
      <button role="menuitem" className={contextMenuItemClass} onClick={run(onCopyReference)}>
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
        {orientation === "horizontal" ? "✓ " : "  "}Horizontal
      </button>
      <button
        role="menuitemradio"
        aria-checked={orientation === "vertical"}
        className={contextMenuItemClass}
        onClick={run(() => onSetOrientation("vertical"))}
      >
        {orientation === "vertical" ? "✓ " : "  "}Vertical
      </button>
    </ContextMenu>
  );
}

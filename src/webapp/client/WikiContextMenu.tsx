import { TrashIcon } from "@heroicons/react/24/outline";
import { ContextMenu, contextMenuItemClass } from "./ContextMenu";

export function WikiContextMenu({
  x,
  y,
  onRemove,
  onDismiss,
}: {
  x: number;
  y: number;
  onRemove: () => void;
  onDismiss: () => void;
}) {
  return (
    <ContextMenu x={x} y={y} ariaLabel="wiki actions" onDismiss={onDismiss}>
      <button
        role="menuitem"
        className={`${contextMenuItemClass} text-red-600 dark:text-red-400`}
        onClick={() => {
          onRemove();
          onDismiss();
        }}
      >
        <TrashIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        Remove
      </button>
    </ContextMenu>
  );
}

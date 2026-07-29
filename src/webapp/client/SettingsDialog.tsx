import { Modal } from "./Modal";

export function SettingsDialog({
  showArchived,
  onToggleArchived,
  onClose,
}: {
  showArchived: boolean;
  onToggleArchived: (next: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal label="category settings" title="Category settings" onClose={onClose}>
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm">
          <div className="font-medium text-slate-700 dark:text-slate-200">Show archived</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Include archived leaves in counts, the browse tree, and search results.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={showArchived}
          aria-label="Show archived"
          onClick={() => onToggleArchived(!showArchived)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
            showArchived ? "bg-sky-600" : "bg-slate-300 dark:bg-slate-600"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
              showArchived ? "translate-x-4" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
    </Modal>
  );
}

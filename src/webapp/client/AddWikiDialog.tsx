import { useState } from "react";
import { ClipboardIcon, FolderIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { api } from "./api";
import { Modal } from "./Modal";
import { Button } from "./Button";

const ADD_ERRORS: Record<string, string> = {
  "not-a-wiki": "No .llm-wiki-memory found in that folder.",
  "not-absolute": "Enter an absolute path.",
  "is-home": "That folder is already your home wiki.",
  "invalid-request": "Enter a folder path.",
};

export function addErrorText(code: string): string {
  return ADD_ERRORS[code] ?? "Couldn't add that folder.";
}

export function AddWikiDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: () => Promise<unknown> | void;
}) {
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const submit = async () => {
    const trimmed = folder.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addWiki(trimmed);
      await onAdded();
      onClose();
    } catch (caught) {
      setError(addErrorText(String((caught as Error).message)));
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard?.readText();
      if (text?.trim()) {
        setFolder(text.trim());
        setError(null);
      }
    } catch {
      setError("Couldn't read the clipboard.");
    }
  };

  const choose = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const picked = await api.pickFolder();
      if (picked) setFolder(picked);
    } catch (caught) {
      setError(
        String((caught as Error).message) === "unsupported"
          ? "The folder picker is only available on macOS — paste the path instead."
          : "Couldn't open the folder picker.",
      );
    } finally {
      setPicking(false);
    }
  };

  return (
    <Modal label="add wiki" title="Add a wiki" onClose={onClose}>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Point to a folder that contains a <code>.llm-wiki-memory</code> wiki.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex flex-col gap-2"
      >
        <div className="flex items-stretch gap-1">
          <input
            autoFocus
            value={folder}
            onChange={(event) => {
              setFolder(event.target.value);
              setError(null);
            }}
            placeholder="/absolute/path (contains .llm-wiki-memory)"
            className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1.5 text-xs text-slate-800 outline-none placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500"
          />
          <Button
            variant="secondary"
            onClick={paste}
            disabled={busy}
            aria-label="paste from clipboard"
            title="Paste from clipboard"
            className="px-2 py-1.5 text-xs"
            icon={<ClipboardIcon className="h-4 w-4" />}
          />
        </div>
        <Button
          variant="secondary"
          onClick={choose}
          disabled={picking || busy}
          className="justify-center px-2 py-1.5 text-xs"
          icon={<FolderIcon className="h-4 w-4" />}
        >
          {picking ? "Opening…" : "Choose folder…"}
        </Button>
        <div className="flex gap-1">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !folder.trim()}
            className="px-3 py-1.5 text-xs"
            icon={<PlusIcon className="h-4 w-4" />}
          >
            Add
          </Button>
          <Button
            variant="ghost"
            onClick={onClose}
            className="px-3 py-1.5 text-xs"
            icon={<XMarkIcon className="h-4 w-4" />}
          >
            Cancel
          </Button>
        </div>
      </form>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </Modal>
  );
}

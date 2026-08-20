import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveBoxIcon,
  ArrowUturnLeftIcon,
  ArrowLeftIcon,
  CheckIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Editor } from "./Editor";
import { FrontmatterForm } from "./FrontmatterForm";
import { useFacets } from "./hooks";
import { DiffView } from "./DiffView";
import { Modal } from "./Modal";
import { ConfirmDialog } from "./ConfirmDialog";
import { DeleteDialog } from "./DeleteDialog";
import { Button } from "./Button";
import { api, type DocView, type MemoryInput } from "./api";

export function EditorPanel({
  wikiId,
  doc,
  onDone,
  onDeleted,
}: {
  wikiId: string;
  doc: DocView;
  onDone: (newId: string | null) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const facets = useFacets(wikiId);
  const [body, setBody] = useState(doc.body);
  const [memory, setMemory] = useState<MemoryInput>(doc.memory as MemoryInput);
  const [showDiff, setShowDiff] = useState(false);
  const [pendingArchive, setPendingArchive] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(doc.id);
  const [error, setError] = useState<string | null>(null);
  const gated = doc.category === "self_improvement";

  const finish = async () => {
    setSaving(true);
    setError(null);
    const result = await api.editDoc(wikiId, doc.id, {
      body,
      memory,
      userRequested: gated ? consent : undefined,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.message ?? result.error ?? "save failed");
      return;
    }
    await queryClient.invalidateQueries();
    setShowDiff(false);
    setSavedId(result.id ?? doc.id);
    if (result.shared) {
      setBanner("Staged in the shared repo — commit and push it there to share.");
      return;
    }
    onDone(result.id ?? doc.id);
  };

  const toggleArchive = async () => {
    setError(null);
    const result = await api.archiveDoc(wikiId, doc.id, doc.active);
    if (!result.ok) {
      setError(result.message ?? result.error ?? "archive failed");
      return;
    }
    await queryClient.invalidateQueries();
    onDone(doc.id);
  };

  const remove = async () => {
    setPendingDelete(false);
    setError(null);
    const result = await api.deleteDoc(wikiId, doc.id);
    if (!result.ok) {
      setError(result.message ?? result.error ?? "delete failed");
      return;
    }
    await queryClient.invalidateQueries();
    onDeleted();
  };

  return (
    <div className="p-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          Editing <span className="font-mono text-slate-700 dark:text-slate-200">{doc.name}</span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => (doc.active ? setPendingArchive(true) : toggleArchive())}
            icon={
              doc.active ? (
                <ArchiveBoxIcon className="h-4 w-4" />
              ) : (
                <ArrowUturnLeftIcon className="h-4 w-4" />
              )
            }
          >
            {doc.active ? "Archive" : "Restore"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setPendingDelete(true)}
            icon={<TrashIcon className="h-4 w-4" />}
          >
            Delete
          </Button>
          <Button
            variant="ghost"
            onClick={() => onDone(null)}
            icon={<XMarkIcon className="h-4 w-4" />}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => setShowDiff(true)}
            icon={<CheckIcon className="h-4 w-4" />}
          >
            Save…
          </Button>
        </div>
      </div>
      {error && <div className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      {banner && (
        <div className="mb-3 flex items-center justify-between rounded bg-amber-50 p-2 text-sm text-amber-800">
          <span>{banner}</span>
          <Button
            variant="row"
            onClick={() => onDone(savedId)}
            className="font-medium text-amber-800 hover:underline"
            icon={<CheckIcon className="h-4 w-4" />}
          >
            done
          </Button>
        </div>
      )}
      <FrontmatterForm
        category={doc.category}
        memory={memory}
        onChange={setMemory}
        facets={facets.data}
      />
      <div className="mt-4">
        <Editor initialMarkdown={doc.body} value={body} onChange={setBody} />
      </div>
      {showDiff && (
        <Modal
          label="review changes"
          title="Review changes"
          onClose={() => setShowDiff(false)}
          align="center"
          width="max-w-2xl"
        >
          <DiffView oldText={doc.body} newText={body} />
          {gated && (
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              I confirm this behavioral-lesson (self_improvement) edit.
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setShowDiff(false)}
              icon={<ArrowLeftIcon className="h-4 w-4" />}
            >
              Back
            </Button>
            <Button
              variant="primary"
              onClick={finish}
              disabled={saving || (gated && !consent)}
              icon={<CheckIcon className="h-4 w-4" />}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </Modal>
      )}
      {pendingArchive && (
        <ConfirmDialog
          label="archive document"
          title="Archive this document?"
          message={`Archive “${doc.name}”? It is hidden from active recall but not deleted — you can restore it later.`}
          confirmLabel="Archive"
          confirmIcon={<ArchiveBoxIcon className="h-4 w-4" />}
          danger
          onConfirm={() => {
            setPendingArchive(false);
            toggleArchive();
          }}
          onCancel={() => setPendingArchive(false)}
        />
      )}
      {pendingDelete && (
        <DeleteDialog name={doc.name} onConfirm={remove} onCancel={() => setPendingDelete(false)} />
      )}
    </div>
  );
}

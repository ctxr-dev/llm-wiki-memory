import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Editor } from "./Editor";
import { FrontmatterForm } from "./FrontmatterForm";
import { DiffView } from "./DiffView";
import { api, type DocView, type MemoryInput } from "./api";

export function EditorPanel({
  wikiId,
  doc,
  onDone,
}: {
  wikiId: string;
  doc: DocView;
  onDone: (newId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState(doc.body);
  const [memory, setMemory] = useState<MemoryInput>(doc.memory as MemoryInput);
  const [showDiff, setShowDiff] = useState(false);
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

  return (
    <div className="p-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm text-slate-500">
          Editing <span className="font-mono text-slate-700">{doc.name}</span>
        </div>
        <div className="flex gap-2">
          <button onClick={toggleArchive} className="text-sm text-slate-500 hover:text-slate-800">
            {doc.active ? "Archive" : "Restore"}
          </button>
          <button
            onClick={() => onDone(null)}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={() => setShowDiff(true)}
            className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
          >
            Save…
          </button>
        </div>
      </div>
      {error && <div className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      {banner && (
        <div className="mb-3 flex items-center justify-between rounded bg-amber-50 p-2 text-sm text-amber-800">
          <span>{banner}</span>
          <button onClick={() => onDone(savedId)} className="font-medium hover:underline">
            done
          </button>
        </div>
      )}
      <FrontmatterForm category={doc.category} memory={memory} onChange={setMemory} />
      <div className="mt-4">
        <Editor initialMarkdown={doc.body} value={body} onChange={setBody} />
      </div>
      {showDiff && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setShowDiff(false)}
        >
          <div
            className="w-full max-w-2xl rounded-lg bg-white p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-2 font-semibold">Review changes</div>
            <DiffView oldText={doc.body} newText={body} />
            {gated && (
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I confirm this behavioral-lesson (self_improvement) edit.
              </label>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setShowDiff(false)} className="text-sm text-slate-500">
                Back
              </button>
              <button
                onClick={finish}
                disabled={saving || (gated && !consent)}
                className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-40"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

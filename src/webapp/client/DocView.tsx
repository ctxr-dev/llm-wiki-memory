import { useEffect, useMemo, useState } from "react";
import { useDoc, useRelated } from "./hooks";
import { Markdown } from "./Markdown";
import { FrontmatterCard } from "./FrontmatterCard";
import { Toc } from "./Toc";
import { RelatedPanel } from "./RelatedPanel";
import { EditorPanel } from "./EditorPanel";
import { extractToc } from "./headings";

export function DocView({
  wikiId,
  docId,
  onOpen,
}: {
  wikiId: string;
  docId: string;
  onOpen: (id: string) => void;
}) {
  const doc = useDoc(wikiId, docId);
  const related = useRelated(wikiId, docId);
  const [editing, setEditing] = useState(false);
  const toc = useMemo(() => (doc.data ? extractToc(doc.data.body) : []), [doc.data]);

  useEffect(() => setEditing(false), [docId]);

  if (doc.isPending) return <div className="p-6 text-slate-400">Loading…</div>;
  if (doc.error || !doc.data) {
    return <div className="p-6 text-red-600">{String(doc.error ?? "Not found")}</div>;
  }
  if (editing) {
    return (
      <EditorPanel
        wikiId={wikiId}
        doc={doc.data}
        onDone={(newId) => {
          setEditing(false);
          if (newId && newId !== docId) onOpen(newId);
        }}
      />
    );
  }
  return (
    <div className="flex gap-6 p-6">
      <article className="min-w-0 flex-1">
        <div className="mb-2 flex justify-end">
          <button
            onClick={() => setEditing(true)}
            className="rounded border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:border-slate-300"
          >
            Edit
          </button>
        </div>
        <FrontmatterCard doc={doc.data} />
        <Markdown body={doc.data.body} />
      </article>
      <aside className="hidden w-56 shrink-0 space-y-6 lg:block">
        <Toc items={toc} />
        <RelatedPanel related={related.data ?? []} onOpen={onOpen} />
      </aside>
    </div>
  );
}

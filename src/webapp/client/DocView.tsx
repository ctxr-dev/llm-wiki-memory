import { useEffect, useMemo, useState } from "react";
import { Button } from "./Button";
import { useDoc, useRelated } from "./hooks";
import { Markdown } from "./Markdown";
import { FrontmatterCard } from "./FrontmatterCard";
import { MetaBlock } from "./MetaBlock";
import { Toc } from "./Toc";
import { RelatedPanel } from "./RelatedPanel";
import { EditorPanel } from "./EditorPanel";
import { CollapsibleColumn } from "./CollapsibleColumn";
import { extractToc } from "./headings";
import { splitBodyMeta } from "./bodyMeta";
import type { Facet } from "./api";

export function DocView({
  wikiId,
  docId,
  onOpen,
  onChipFilter,
}: {
  wikiId: string;
  docId: string;
  onOpen: (id: string) => void;
  onChipFilter: (facet: Facet) => void;
}) {
  const doc = useDoc(wikiId, docId);
  const related = useRelated(wikiId, docId);
  const [editing, setEditing] = useState(false);
  const toc = useMemo(() => (doc.data ? extractToc(doc.data.body) : []), [doc.data]);
  const meta = useMemo(() => (doc.data ? splitBodyMeta(doc.data.body) : null), [doc.data]);

  useEffect(() => setEditing(false), [docId]);

  if (doc.isPending) return <div className="p-6 text-slate-400 dark:text-slate-500">Loading…</div>;
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
    <div className="flex items-start gap-6 p-6">
      <article className="min-w-0 flex-1">
        <div className="mb-2 flex justify-end">
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </div>
        <FrontmatterCard doc={doc.data} onChip={onChipFilter} />
        {meta && meta.metaList.length > 0 ? (
          <>
            <Markdown body={meta.heading ?? ""} />
            <MetaBlock lines={meta.metaList} />
            <Markdown body={meta.prose} />
          </>
        ) : (
          <Markdown body={doc.data.body} />
        )}
      </article>
      <CollapsibleColumn
        as="aside"
        side="right"
        ariaLabel="table of contents and related"
        railLabel="TOC & Related Docs"
        expandedWidthClass="w-56"
        collapseBelowPx={768}
        className="sticky top-0 max-h-screen self-start"
        header={<span />}
      >
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-1 pb-2">
          <Toc items={toc} />
          <RelatedPanel related={related.data ?? []} onOpen={onOpen} />
        </div>
      </CollapsibleColumn>
    </div>
  );
}

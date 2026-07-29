import { useMemo } from "react";
import { useDoc, useRelated, useWikis } from "./hooks";
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
  editing,
  onEditDone,
  onDeleted,
  showArchived,
  onOpen,
  onOpenRef,
  onChipFilter,
}: {
  wikiId: string;
  docId: string;
  editing: boolean;
  onEditDone: (newId: string | null) => void;
  onDeleted: () => void;
  showArchived: boolean;
  onOpen: (id: string) => void;
  onOpenRef?: (wikiId: string, docId: string) => void;
  onChipFilter: (facet: Facet) => void;
}) {
  const doc = useDoc(wikiId, docId);
  const related = useRelated(wikiId, docId, showArchived);
  const wikis = useWikis();
  const wikiList = wikis.data ?? [];
  const toc = useMemo(() => (doc.data ? extractToc(doc.data.body) : []), [doc.data]);
  const meta = useMemo(() => (doc.data ? splitBodyMeta(doc.data.body) : null), [doc.data]);

  if (doc.isPending) return <div className="p-6 text-slate-400 dark:text-slate-500">Loading…</div>;
  if (doc.error || !doc.data) {
    return <div className="p-6 text-red-600">{String(doc.error ?? "Not found")}</div>;
  }
  if (editing) {
    return <EditorPanel wikiId={wikiId} doc={doc.data} onDone={onEditDone} onDeleted={onDeleted} />;
  }
  return (
    <div className="flex min-h-full items-start gap-6 p-6">
      <article className="min-w-0 flex-1">
        <FrontmatterCard doc={doc.data} onChip={onChipFilter} />
        {meta && meta.metaList.length > 0 ? (
          <>
            <Markdown body={meta.heading ?? ""} wikis={wikiList} onOpenRef={onOpenRef} />
            <MetaBlock lines={meta.metaList} />
            <Markdown body={meta.prose} wikis={wikiList} onOpenRef={onOpenRef} />
          </>
        ) : (
          <Markdown body={doc.data.body} wikis={wikiList} onOpenRef={onOpenRef} />
        )}
      </article>
      <CollapsibleColumn
        as="aside"
        side="right"
        ariaLabel="table of contents and related"
        railLabel="TOC & Related Docs"
        expandedWidthClass="w-56"
        collapseBelowPx={768}
        className="sticky top-0"
        collapsedClassName="self-stretch"
        expandedClassName="max-h-screen self-start"
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

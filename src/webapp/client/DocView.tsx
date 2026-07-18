import { useMemo } from "react";
import { useDoc, useRelated } from "./hooks";
import { Markdown } from "./Markdown";
import { FrontmatterCard } from "./FrontmatterCard";
import { Toc } from "./Toc";
import { RelatedPanel } from "./RelatedPanel";
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
  const toc = useMemo(() => (doc.data ? extractToc(doc.data.body) : []), [doc.data]);

  if (doc.isPending) return <div className="p-6 text-slate-400">Loading…</div>;
  if (doc.error || !doc.data) {
    return <div className="p-6 text-red-600">{String(doc.error ?? "Not found")}</div>;
  }
  return (
    <div className="flex gap-6 p-6">
      <article className="min-w-0 flex-1">
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

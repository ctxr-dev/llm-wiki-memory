import { useEffect, useState, type ReactNode } from "react";
import { useNav, useNavChildren } from "./hooks";

export function NavPanel({
  wikiId,
  onOpenDoc,
}: {
  wikiId: string;
  onOpenDoc: (id: string) => void;
}) {
  const [category, setCategory] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const nav = useNav(wikiId);
  const children = useNavChildren(wikiId, category ?? "", path, false);

  useEffect(() => {
    setCategory(null);
    setPath("");
  }, [wikiId]);

  const shell = (body: ReactNode) => (
    <div className="w-64 shrink-0 overflow-y-auto border-r border-slate-200 p-2">{body}</div>
  );

  if (!category) {
    return shell(
      <>
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
          Categories
        </div>
        {nav.data?.map((entry) => (
          <button
            key={entry.category}
            onClick={() => {
              setCategory(entry.category);
              setPath("");
            }}
            className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-slate-100"
          >
            <span>{entry.label}</span>
            <span className="text-xs text-slate-400">{entry.count}</span>
          </button>
        ))}
      </>,
    );
  }

  const segments = path ? path.split("/") : [];
  const goUp = () =>
    segments.length === 0 ? setCategory(null) : setPath(segments.slice(0, -1).join("/"));

  return shell(
    <>
      <button onClick={goUp} className="mb-2 px-2 text-xs text-slate-500 hover:text-slate-800">
        ← {segments.length ? segments[segments.length - 1] : category}
      </button>
      {children.data?.dirs.map((dir) => (
        <button
          key={dir.name}
          onClick={() => setPath(path ? `${path}/${dir.name}` : dir.name)}
          className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-slate-100"
        >
          <span className="truncate">{dir.label}</span>
          <span className="ml-2 text-xs text-slate-400">{dir.count}</span>
        </button>
      ))}
      {children.data?.docs.map((doc) => (
        <button
          key={doc.id}
          onClick={() => onOpenDoc(doc.id)}
          className="block w-full truncate rounded px-2 py-1 text-left text-sm text-slate-600 hover:bg-slate-100"
        >
          {doc.name}
        </button>
      ))}
    </>,
  );
}

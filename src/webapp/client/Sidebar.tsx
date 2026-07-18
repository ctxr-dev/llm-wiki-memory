import { useWikis } from "./hooks";

export function Sidebar({
  activeId,
  onSelect,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const wikis = useWikis();
  return (
    <nav className="w-56 shrink-0 overflow-y-auto border-r border-slate-200 p-2">
      <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Wikis
      </div>
      {wikis.data?.map((wiki) => (
        <button
          key={wiki.id}
          onClick={() => onSelect(wiki.id)}
          className={`block w-full truncate rounded px-2 py-1 text-left text-sm ${
            wiki.id === activeId ? "bg-slate-200 font-medium" : "hover:bg-slate-100"
          }`}
          title={wiki.mountDir}
        >
          {wiki.label}
          <span className="ml-1 text-xs text-slate-400">
            {wiki.kind === "home" ? "home" : "repo"}
          </span>
        </button>
      ))}
    </nav>
  );
}

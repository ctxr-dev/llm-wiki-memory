import { useQuery } from "@tanstack/react-query";
import { fetchHealth } from "./health";

export function App() {
  const { data, isPending, error } = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
  });

  if (isPending) {
    return <main className="p-8 text-slate-500">Loading memory…</main>;
  }
  if (error) {
    return <main className="p-8 text-red-600">{String(error)}</main>;
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold text-slate-900">llm-wiki-memory</h1>
      <dl className="mt-4 grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
        <dt className="text-slate-500">Wiki root</dt>
        <dd className="font-mono text-slate-800">{data.wikiRoot}</dd>
        <dt className="text-slate-500">Embed backend</dt>
        <dd className="font-mono text-slate-800">{data.embedBackend}</dd>
        <dt className="text-slate-500">Levels</dt>
        <dd className="text-slate-800">{data.levels.length}</dd>
      </dl>
      <h2 className="mt-6 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Categories
      </h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {data.categories.map((category) => (
          <li
            key={category}
            className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700"
          >
            {category}
          </li>
        ))}
      </ul>
    </main>
  );
}

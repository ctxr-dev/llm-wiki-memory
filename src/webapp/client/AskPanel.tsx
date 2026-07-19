import { useState } from "react";
import { useAsk } from "./hooks";
import { Markdown } from "./Markdown";

export function AskPanel({
  wikiId,
  onOpenDoc,
  onClose,
}: {
  wikiId: string;
  onOpenDoc: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [question, setQuestion] = useState("");
  const ask = useAsk(wikiId, question);
  const answer = ask.data?.answer ?? null;
  const sources = ask.data?.sources ?? [];
  const open = (id: string) => {
    onOpenDoc(id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-16"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-white dark:bg-slate-800 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <form
          className="flex gap-2 border-b border-slate-100 dark:border-slate-800 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            setQuestion(draft);
          }}
        >
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask your memory…"
            className="flex-1 rounded border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-sm outline-none"
          />
          <button className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white">Ask</button>
        </form>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {ask.isFetching && <div className="text-slate-400 dark:text-slate-500">Searching…</div>}
          {answer && (
            <div className="mb-4">
              <button
                onClick={() => open(answer.id)}
                className="mb-1 block text-sm font-semibold text-sky-700 hover:underline"
              >
                {answer.name}
              </button>
              <div className="rounded border border-slate-100 dark:border-slate-800 p-3">
                <Markdown body={answer.content} />
              </div>
            </div>
          )}
          {sources.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Sources
              </div>
              <ul className="space-y-1">
                {sources.map((source) => (
                  <li key={source.id}>
                    <button
                      onClick={() => open(source.id)}
                      className="text-left text-sm text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
                    >
                      {source.name}{" "}
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        {source.category} · {source.score.toFixed(2)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ask.data && !answer && question.trim() && (
            <div className="text-slate-400 dark:text-slate-500">No matches found.</div>
          )}
        </div>
      </div>
    </div>
  );
}

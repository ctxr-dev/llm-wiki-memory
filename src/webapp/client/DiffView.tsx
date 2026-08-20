import { diffLines } from "diff";

export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = diffLines(oldText, newText);
  if (oldText === newText) {
    return (
      <div className="text-sm text-slate-400 dark:text-slate-500">No changes to the body.</div>
    );
  }
  return (
    <pre className="max-h-72 overflow-auto rounded border border-slate-200 dark:border-slate-700 p-2 font-mono text-xs leading-5">
      {parts.flatMap((part, partIndex) =>
        part.value
          .replace(/\n$/, "")
          .split("\n")
          .map((line, lineIndex) => (
            <div
              key={`${partIndex}-${lineIndex}`}
              className={
                part.added
                  ? "bg-green-50 text-green-800"
                  : part.removed
                    ? "bg-red-50 text-red-800"
                    : "text-slate-500 dark:text-slate-400"
              }
            >
              <span className="select-none opacity-60">
                {part.added ? "+ " : part.removed ? "- " : "  "}
              </span>
              {line || " "}
            </div>
          )),
      )}
    </pre>
  );
}

import { useMemo, useState } from "react";
import { isLossless } from "./losslessGuard";
import { LexicalEditor } from "./LexicalEditor";
import { CodeMirrorSource } from "./CodeMirrorSource";

export function Editor({
  initialMarkdown,
  value,
  onChange,
}: {
  initialMarkdown: string;
  value: string;
  onChange: (markdown: string) => void;
}) {
  const lossless = useMemo(() => isLossless(initialMarkdown), [initialMarkdown]);
  const [mode, setMode] = useState<"wysiwyg" | "source">(lossless ? "wysiwyg" : "source");

  const tab = (target: "wysiwyg" | "source", label: string, disabled = false) => (
    <button
      onClick={() => setMode(target)}
      disabled={disabled}
      className={`rounded px-2 py-0.5 ${
        mode === target ? "bg-slate-200 font-medium" : "hover:bg-slate-100"
      } disabled:opacity-40`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs">
        {tab("wysiwyg", "Rich", !lossless)}
        {tab("source", "Source")}
        {!lossless && (
          <span className="text-amber-600">
            rich editing off — this document uses markdown the editor can’t round-trip losslessly
          </span>
        )}
      </div>
      {mode === "wysiwyg" ? (
        <LexicalEditor key={initialMarkdown} initialMarkdown={value} onChange={onChange} />
      ) : (
        <CodeMirrorSource value={value} onChange={onChange} />
      )}
    </div>
  );
}

import { useCallback, useMemo, useState } from "react";
import { LexicalEditor } from "./LexicalEditor";
import { CodeMirrorSource } from "./CodeMirrorSource";
import { deliteralize, isEditableLossless, literalize } from "./markdownLiteral";

export function Editor({
  initialMarkdown,
  value,
  onChange,
}: {
  initialMarkdown: string;
  value: string;
  onChange: (markdown: string) => void;
}) {
  /**
   * Blocks the editor cannot represent ride along as literal fences, so rich editing
   * is offered for every document. `safe` is a last-resort assertion that the encoding
   * truly round-trips THIS input: nothing in a real corpus fails it, but anything that
   * did would keep its content instead of being mangled.
   */
  const safe = useMemo(() => isEditableLossless(initialMarkdown), [initialMarkdown]);
  const [mode, setMode] = useState<"wysiwyg" | "source">("wysiwyg");
  const richMarkdown = useMemo(() => literalize(value), [value]);
  const onRichChange = useCallback(
    (markdown: string) => onChange(deliteralize(markdown)),
    [onChange],
  );

  const tab = (target: "wysiwyg" | "source", label: string, disabled = false) => (
    <button
      onClick={() => setMode(target)}
      disabled={disabled}
      className={`cursor-pointer rounded px-2 py-0.5 ${
        mode === target
          ? "bg-slate-200 dark:bg-slate-700 font-medium"
          : "hover:bg-slate-100 dark:hover:bg-slate-800"
      } disabled:opacity-40`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs">
        {tab("wysiwyg", "Rich", !safe)}
        {tab("source", "Source")}
        {!safe && (
          <span className="text-amber-600">
            rich editing off — this document cannot be re-encoded without changing it
          </span>
        )}
      </div>
      {mode === "wysiwyg" && safe ? (
        <LexicalEditor
          key={initialMarkdown}
          initialMarkdown={richMarkdown}
          onChange={onRichChange}
        />
      ) : (
        <CodeMirrorSource value={value} onChange={onChange} />
      )}
    </div>
  );
}

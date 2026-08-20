import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { currentTheme } from "./theme";

export function CodeMirrorSource({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <CodeMirror
      value={value}
      height="26rem"
      theme={currentTheme() === "dark" ? "dark" : "light"}
      extensions={[markdown()]}
      onChange={onChange}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
      className="overflow-hidden rounded border border-slate-200 text-sm dark:border-slate-700"
    />
  );
}

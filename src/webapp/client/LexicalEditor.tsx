import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { EDITOR_NODES, TRANSFORMERS } from "./lexicalConfig";

export function LexicalEditor({
  initialMarkdown,
  onChange,
}: {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
}) {
  const initialConfig = {
    namespace: "wiki-editor",
    nodes: EDITOR_NODES,
    onError: (error: Error) => {
      throw error;
    },
    editorState: () => $convertFromMarkdownString(initialMarkdown, TRANSFORMERS),
  };
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative rounded border border-slate-200">
        <RichTextPlugin
          contentEditable={
            <ContentEditable className="md-body min-h-[26rem] px-3 py-2 outline-none" />
          }
          placeholder={
            <div className="pointer-events-none absolute left-3 top-2 text-slate-400">Write…</div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
        <OnChangePlugin
          onChange={(state) => state.read(() => onChange($convertToMarkdownString(TRANSFORMERS)))}
        />
      </div>
    </LexicalComposer>
  );
}

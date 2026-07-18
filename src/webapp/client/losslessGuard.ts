import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { EDITOR_NODES, TRANSFORMERS } from "./lexicalConfig";

export function roundTripMarkdown(markdown: string): string {
  const editor = createHeadlessEditor({
    nodes: EDITOR_NODES,
    onError: (error) => {
      throw error;
    },
  });
  let output = "";
  editor.update(() => $convertFromMarkdownString(markdown, TRANSFORMERS), { discrete: true });
  editor.getEditorState().read(() => {
    output = $convertToMarkdownString(TRANSFORMERS);
  });
  return output;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

export function isLossless(markdown: string): boolean {
  try {
    return normalize(roundTripMarkdown(markdown)) === normalize(markdown);
  } catch {
    return false;
  }
}

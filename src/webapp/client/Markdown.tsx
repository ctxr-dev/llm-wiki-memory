import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { CodeBlock } from "./CodeBlock";
import { Mermaid } from "./Mermaid";

export function Markdown({ body }: { body: string }) {
  return (
    <div className="md-body min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSlug]}
        components={{
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            const text = String(children).replace(/\n$/, "");
            if (lang === "mermaid") return <Mermaid chart={text} />;
            const isBlock = lang !== undefined || text.includes("\n");
            if (isBlock) return <CodeBlock code={text} lang={lang ?? "text"} />;
            return (
              <code className="rounded bg-slate-100 px-1 py-0.5 text-[0.9em]" {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

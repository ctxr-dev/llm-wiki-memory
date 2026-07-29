import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { CodeBlock } from "./CodeBlock";
import { Mermaid } from "./Mermaid";
import { resolveRef } from "./refs";
import type { Wiki } from "./api";

const SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "brain"],
  },
};

type OpenRef = (wikiId: string, docId: string) => void;

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

const REF_TOKEN = /[A-Za-z0-9._/-]+:[A-Za-z0-9._/-]+\.md\b/g;

function linkifyText(value: string, wikis: Wiki[]): MdNode[] | null {
  REF_TOKEN.lastIndex = 0;
  const parts: MdNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_TOKEN.exec(value))) {
    const token = match[0];
    if (!resolveRef(wikis, token)) continue;
    if (match.index > last) parts.push({ type: "text", value: value.slice(last, match.index) });
    parts.push({ type: "link", url: token, children: [{ type: "text", value: token }] });
    last = match.index + token.length;
  }
  if (parts.length === 0) return null;
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

function walkRefs(node: MdNode, wikis: Wiki[]): void {
  if (node.type === "link" || !Array.isArray(node.children)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replaced = linkifyText(child.value, wikis);
      if (replaced) {
        next.push(...replaced);
        continue;
      }
    } else {
      walkRefs(child, wikis);
    }
    next.push(child);
  }
  node.children = next;
}

export function Markdown({
  body,
  wikis = [],
  onOpenRef,
}: {
  body: string;
  wikis?: Wiki[];
  onOpenRef?: OpenRef;
}) {
  const remarkRefs = () => (tree: unknown) => walkRefs(tree as MdNode, wikis);
  return (
    <div className="md-body min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkRefs]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeSlug]}
        urlTransform={(url) => (resolveRef(wikis, url) ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            const resolved = href ? resolveRef(wikis, href) : null;
            if (resolved) {
              return (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenRef?.(resolved.wikiId, resolved.docId);
                  }}
                  className="text-emerald-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-emerald-400"
                >
                  {children}
                </a>
              );
            }
            return <a href={href}>{children}</a>;
          },
          code({ className, children }) {
            const lang = /language-(\w+)/.exec(className || "")?.[1];
            const text = String(children).replace(/\n$/, "");
            if (lang === "mermaid") return <Mermaid chart={text} />;
            const isBlock = lang !== undefined || text.includes("\n");
            if (isBlock) return <CodeBlock code={text} lang={lang ?? "text"} />;
            return (
              <code className="rounded bg-slate-100 dark:bg-slate-800 px-1 py-0.5 text-[0.9em]">
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

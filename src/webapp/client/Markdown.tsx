import { useEffect } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { CodeBlock } from "./CodeBlock";
import { Mermaid } from "./Mermaid";
import { resolveRef, resolveRefHref } from "./refs";
import { rehypeDefTokens } from "./rehypeDefTokens";
import { DEF_TOKEN_ATTR, hasDefTokenClass } from "./defTokens";
import { cancelDefinitionFlash } from "./defFlash";
import { DefTokenLink, PlainLink, WikiRefLink } from "./mdAnchors";
import { DiagramFrame } from "./DiagramViewer";
import { SANITIZE_SCHEMA, isSafeDataImage } from "./sanitizeSchema";
import {
  DIAGRAM_NATURAL_ATTR,
  isDiagramBlockNode,
  parseNatural,
  rehypeDiagramBlocks,
} from "./diagramBlocks";
import type { OpenRef } from "./mdAnchors";
import type { Wiki } from "./api";

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

function transformUrl(wikis: Wiki[], url: string, key: string): string {
  if (resolveRefHref(wikis, url)) return url;
  if (key === "src" && isSafeDataImage(url)) return url;
  return defaultUrlTransform(url);
}

const REF_TOKEN = /[A-Za-z0-9._/-]+:[A-Za-z0-9._/-]+\.md\b/g;

const ANCHOR_NODE_TYPES = new Set(["link", "linkReference"]);

type HastElement = { type: string; tagName?: string; children?: HastElement[] };

function holdsFencedCode(node: unknown): boolean {
  const children = (node as HastElement | undefined)?.children ?? [];
  const elements = children.filter((child) => child.type === "element");
  return elements.length === 1 && elements[0].tagName === "code";
}

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

function linkifyInlineCode(node: MdNode, wikis: Wiki[]): MdNode | null {
  const whole = (node.value ?? "").trim();
  if (!whole || !resolveRef(wikis, whole)) return null;
  return { type: "link", url: whole, children: [node] };
}

function walkRefs(node: MdNode, wikis: Wiki[]): void {
  if (ANCHOR_NODE_TYPES.has(node.type) || !Array.isArray(node.children)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replaced = linkifyText(child.value, wikis);
      if (replaced) {
        next.push(...replaced);
        continue;
      }
    } else if (child.type === "inlineCode") {
      const linked = linkifyInlineCode(child, wikis);
      if (linked) {
        next.push(linked);
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
  useEffect(() => cancelDefinitionFlash, []);
  const remarkRefs = () => (tree: unknown) => walkRefs(tree as MdNode, wikis);
  return (
    <div className="md-body min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkRefs]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, SANITIZE_SCHEMA],
          rehypeSlug,
          rehypeDefTokens,
          rehypeDiagramBlocks,
        ]}
        urlTransform={(url, key) => transformUrl(wikis, url, key)}
        components={{
          a({ href, className, children, node, ...rest }) {
            const resolved = resolveRefHref(wikis, href);
            if (resolved) {
              return (
                <WikiRefLink {...rest} wikis={wikis} resolved={resolved} onOpenRef={onOpenRef}>
                  {children}
                </WikiRefLink>
              );
            }
            if (hasDefTokenClass(className)) {
              const token = node?.properties?.[DEF_TOKEN_ATTR];
              return (
                <DefTokenLink {...rest} href={href} token={typeof token === "string" ? token : ""}>
                  {children}
                </DefTokenLink>
              );
            }
            return (
              <PlainLink {...rest} href={href}>
                {children}
              </PlainLink>
            );
          },
          pre({ children, node }) {
            if (holdsFencedCode(node)) return <pre>{children}</pre>;
            return (
              <DiagramFrame
                label="diagram"
                natural={null}
                preview={
                  <pre data-diagram-preview="" className="overflow-x-auto">
                    {children}
                  </pre>
                }
                full={<pre data-diagram-full="">{children}</pre>}
              />
            );
          },
          div({ children, node, ...rest }) {
            if (!isDiagramBlockNode(node)) return <div {...rest}>{children}</div>;
            const natural = parseNatural(node?.properties?.[DIAGRAM_NATURAL_ATTR]);
            return (
              <DiagramFrame
                label="diagram"
                natural={natural}
                preview={
                  <div data-diagram-preview="" className="md-diagram overflow-x-auto">
                    {children}
                  </div>
                }
                full={
                  <div data-diagram-full="" className={natural ? "md-diagram-full" : ""}>
                    {children}
                  </div>
                }
              />
            );
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

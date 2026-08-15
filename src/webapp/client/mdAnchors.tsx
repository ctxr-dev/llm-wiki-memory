import { ArrowTopRightOnSquareIcon, LinkIcon } from "@heroicons/react/24/outline";
import type { ComponentPropsWithoutRef, MouseEvent } from "react";
import { formatRef, wikiById } from "./refs";
import type { ResolvedRef } from "./refs";
import { refToHash } from "./hash-route";
import { DEF_TOKEN_CLASS } from "./defTokens";
import { anchorTargetId, flashDefinition, scrollToAnchor } from "./defFlash";
import type { Wiki } from "./api";

export type OpenRef = (wikiId: string, docId: string) => void;

type AnchorProps = Omit<ComponentPropsWithoutRef<"a">, "className">;

const EXTERNAL_HREF = /^https?:/i;

const MIDDLE_BUTTON = 1;

const NEW_BROWSER_TAB = { target: "_blank", rel: "noopener noreferrer" } as const;

const ANCHOR_ICON_CLASS = "my-auto mx-[3px] h-[0.9em] w-[0.9em] p-0";

const ANCHOR_BOX_CLASS = "m-auto inline-flex py-0 pl-0 pr-[5px] align-middle leading-[20px]";

export const WIKI_REF_CLASS = `wiki-ref ${ANCHOR_BOX_CLASS} break-words rounded bg-indigo-100 font-medium text-indigo-800 no-underline ring-1 ring-indigo-200 hover:bg-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800 dark:hover:bg-indigo-900`;

export const DEF_TOKEN_LINK_CLASS = `${DEF_TOKEN_CLASS} cursor-pointer font-medium text-amber-700 underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-amber-400`;

export const PLAIN_LINK_CLASS =
  "plain-link text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-400 dark:hover:text-sky-300";

export const EXTERNAL_LINK_CLASS = `${PLAIN_LINK_CLASS} external-link ${ANCHOR_BOX_CLASS}`;

function isPlainPrimaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function isExternalHref(href: string | undefined): boolean {
  return href !== undefined && EXTERNAL_HREF.test(href);
}

function isFragmentHref(href: string | undefined): boolean {
  return href !== undefined && href.startsWith("#");
}

function inPageJumpHandlers(jump: () => void) {
  return {
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      jump();
    },
    onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== MIDDLE_BUTTON) return;
      event.preventDefault();
      jump();
    },
  };
}

export function WikiRefLink({
  wikis,
  resolved,
  onOpenRef,
  children,
  ...rest
}: AnchorProps & { wikis: Wiki[]; resolved: ResolvedRef; onOpenRef?: OpenRef }) {
  const wiki = wikiById(wikis, resolved.wikiId);
  const wikiRef = wiki ? formatRef(wiki, resolved.docId) : resolved.docId;
  const wikiName = wiki?.label ?? resolved.wikiId;
  return (
    <a
      {...rest}
      href={refToHash(wikiRef)}
      data-wiki-ref={wikiRef}
      title={`Open in ${wikiName} — Cmd-click for a browser tab`}
      className={WIKI_REF_CLASS}
      onClick={(event) => {
        if (!isPlainPrimaryClick(event) || !onOpenRef) return;
        event.preventDefault();
        onOpenRef(resolved.wikiId, resolved.docId);
      }}
    >
      <LinkIcon aria-hidden="true" className={ANCHOR_ICON_CLASS} />
      {children}
    </a>
  );
}

export function DefTokenLink({ href, token, children, ...rest }: AnchorProps & { token: string }) {
  return (
    <a
      {...rest}
      href={href}
      data-def-token={token}
      title={`Jump to where ${token} is defined`}
      className={DEF_TOKEN_LINK_CLASS}
      {...inPageJumpHandlers(() => flashDefinition(anchorTargetId(href)))}
    >
      {children}
    </a>
  );
}

function FragmentLink({ href, children, ...rest }: AnchorProps) {
  return (
    <a
      {...rest}
      href={href}
      className={PLAIN_LINK_CLASS}
      {...inPageJumpHandlers(() => scrollToAnchor(anchorTargetId(href)))}
    >
      {children}
    </a>
  );
}

export function PlainLink({ href, children, ...rest }: AnchorProps) {
  if (isFragmentHref(href)) {
    return (
      <FragmentLink href={href} {...rest}>
        {children}
      </FragmentLink>
    );
  }
  if (isExternalHref(href)) {
    return (
      <a {...rest} href={href} {...NEW_BROWSER_TAB} className={EXTERNAL_LINK_CLASS}>
        {children}
        <ArrowTopRightOnSquareIcon aria-hidden="true" className={ANCHOR_ICON_CLASS} />
      </a>
    );
  }
  return (
    <a {...(href ? NEW_BROWSER_TAB : {})} {...rest} href={href} className={PLAIN_LINK_CLASS}>
      {children}
    </a>
  );
}

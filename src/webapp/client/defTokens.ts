export type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export const DEF_TOKEN_CLASS = "def-token-ref";
export const DEF_TOKEN_ATTR = "data-def-token";
export const DEF_TOKEN_FLASH_CLASS = "def-token-flash";
export const DEF_TOKEN_FLASH_MS = 1000;

const TOKEN_BODY = "[A-Z]{1,3}[0-9]{1,3}";
const HEADING_SEPARATOR = "[\\s\\u2014:.)]";

export const DEF_TOKEN_PATTERN = `\\b${TOKEN_BODY}\\b`;

const WHOLE_TOKEN = new RegExp(`^${TOKEN_BODY}$`);
const LEADING_TOKEN = new RegExp(`^(${TOKEN_BODY})(?=${HEADING_SEPARATOR}|$)`);

export function isDefToken(text: string): boolean {
  return WHOLE_TOKEN.test(text.trim());
}

export function headingDefToken(text: string): string | null {
  const match = LEADING_TOKEN.exec(text.trim());
  return match ? match[1] : null;
}

export type DefTokenMatch = { token: string; index: number };

export function findDefTokenMatches(value: string): DefTokenMatch[] {
  const scanner = new RegExp(DEF_TOKEN_PATTERN, "g");
  const found: DefTokenMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(value))) found.push({ token: match[0], index: match.index });
  return found;
}

export function defAnchorId(token: string): string {
  return `def-${token.toLowerCase()}`;
}

export function uniqueAnchorId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function defTokenAnchor(token: string, targetId: string): HastNode {
  return {
    type: "element",
    tagName: "a",
    properties: {
      href: `#${targetId}`,
      className: [DEF_TOKEN_CLASS],
      [DEF_TOKEN_ATTR]: token,
    },
    children: [{ type: "text", value: token }],
  };
}

export function hasDefTokenClass(className: string | undefined): boolean {
  return className ? className.split(/\s+/).includes(DEF_TOKEN_CLASS) : false;
}

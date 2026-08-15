import { DEF_TOKEN_FLASH_CLASS, DEF_TOKEN_FLASH_MS } from "./defTokens";

const NATIVELY_FOCUSABLE = new Set(["A", "AREA", "BUTTON", "INPUT", "SELECT", "TEXTAREA"]);

type PendingFlash = { element: Element; timer: number };

let pendingFlash: PendingFlash | null = null;

export function anchorTargetId(href: string | undefined): string {
  if (!href || !href.startsWith("#")) return "";
  const raw = href.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function makeProgrammaticallyFocusable(target: HTMLElement): void {
  if (NATIVELY_FOCUSABLE.has(target.tagName) || target.hasAttribute("tabindex")) return;
  target.setAttribute("tabindex", "-1");
}

export function scrollToAnchor(targetId: string): HTMLElement | null {
  const target = targetId ? document.getElementById(targetId) : null;
  if (!target) return null;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  makeProgrammaticallyFocusable(target);
  target.focus({ preventScroll: true });
  return target;
}

export function cancelDefinitionFlash(): void {
  if (!pendingFlash) return;
  window.clearTimeout(pendingFlash.timer);
  pendingFlash.element.classList.remove(DEF_TOKEN_FLASH_CLASS);
  pendingFlash = null;
}

function replayFlashAnimation(target: HTMLElement): void {
  target.classList.remove(DEF_TOKEN_FLASH_CLASS);
  target.getBoundingClientRect();
  target.classList.add(DEF_TOKEN_FLASH_CLASS);
}

export function flashDefinition(targetId: string): void {
  const target = scrollToAnchor(targetId);
  if (!target) return;
  cancelDefinitionFlash();
  replayFlashAnimation(target);
  pendingFlash = {
    element: target,
    timer: window.setTimeout(cancelDefinitionFlash, DEF_TOKEN_FLASH_MS),
  };
}

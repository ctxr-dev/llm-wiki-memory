import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const CARD_WIDTH = 288;

export function HoverCard({
  children,
  card,
  side = "right",
  className = "",
}: {
  children: ReactNode;
  card: ReactNode;
  side?: "left" | "right";
  className?: string;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const open = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const left = side === "right" ? rect.right + 8 : rect.left - CARD_WIDTH - 8;
      const top = Math.min(rect.top, window.innerHeight - 240);
      setPosition({ top: Math.max(8, top), left: Math.max(8, left) });
    }, 140);
  };
  const close = () => {
    if (timer.current) clearTimeout(timer.current);
    setPosition(null);
  };

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  return (
    <div
      ref={anchor}
      className={className}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
    >
      {children}
      {position !== null &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: position.top, left: position.left, width: CARD_WIDTH }}
            className="pointer-events-none fixed z-50 max-h-[80vh] overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-xl dark:border-slate-700 dark:bg-slate-800"
          >
            {card}
          </div>,
          document.body,
        )}
    </div>
  );
}

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
  side?: "left" | "right" | "bottom";
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
      const clampX = (x: number) => Math.max(8, Math.min(x, window.innerWidth - CARD_WIDTH - 8));
      if (side === "bottom") {
        setPosition({ top: rect.bottom + 8, left: clampX(rect.left) });
        return;
      }
      const left = side === "right" ? rect.right + 8 : rect.left - CARD_WIDTH - 8;
      const top = Math.min(rect.top, window.innerHeight - 240);
      setPosition({ top: Math.max(8, top), left: clampX(left) });
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

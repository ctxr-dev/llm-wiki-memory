import { useRef, useState, type PointerEvent, type MouseEvent, type RefObject } from "react";

const DRAG_THRESHOLD = 4;

export type PanOrigin = {
  pointerX: number;
  pointerY: number;
  scrollLeft: number;
  scrollTop: number;
};

export type ScrollTarget = { scrollLeft: number; scrollTop: number };

export function panTarget(origin: PanOrigin, pointerX: number, pointerY: number): ScrollTarget {
  return {
    scrollLeft: origin.scrollLeft - (pointerX - origin.pointerX),
    scrollTop: origin.scrollTop - (pointerY - origin.pointerY),
  };
}

export function movedBeyondThreshold(
  origin: PanOrigin,
  pointerX: number,
  pointerY: number,
): boolean {
  return (
    Math.abs(pointerX - origin.pointerX) >= DRAG_THRESHOLD ||
    Math.abs(pointerY - origin.pointerY) >= DRAG_THRESHOLD
  );
}

export function usePan(targetRef: RefObject<HTMLElement | null>) {
  const origin = useRef<PanOrigin | null>(null);
  const dragged = useRef(false);
  const [panning, setPanning] = useState(false);

  const release = (pointerId: number) => {
    const target = targetRef.current;
    if (target?.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
    origin.current = null;
    setPanning(false);
  };

  return {
    panning,
    cursorClass: panning ? "cursor-grabbing" : "cursor-grab",
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const target = targetRef.current;
        if (!target) return;
        event.preventDefault();
        target.setPointerCapture?.(event.pointerId);
        origin.current = {
          pointerX: event.clientX,
          pointerY: event.clientY,
          scrollLeft: target.scrollLeft,
          scrollTop: target.scrollTop,
        };
        dragged.current = false;
        setPanning(true);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const target = targetRef.current;
        const start = origin.current;
        if (!target || !start) return;
        const next = panTarget(start, event.clientX, event.clientY);
        target.scrollLeft = next.scrollLeft;
        target.scrollTop = next.scrollTop;
        if (movedBeyondThreshold(start, event.clientX, event.clientY)) dragged.current = true;
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => release(event.pointerId),
      onPointerCancel: (event: PointerEvent<HTMLElement>) => release(event.pointerId),
      onClickCapture: (event: MouseEvent<HTMLElement>) => {
        if (!dragged.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onContextMenu: (event: MouseEvent<HTMLElement>) => event.preventDefault(),
    },
  };
}

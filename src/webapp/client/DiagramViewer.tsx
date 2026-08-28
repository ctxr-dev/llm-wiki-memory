import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowsPointingOutIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  ArrowsPointingInIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { Button } from "./Button";
import { usePan } from "./diagramPan";

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
const ZOOM_STEP = 1.2;
const VIEWPORT_MARGIN = 96;

export type Size = { width: number; height: number };

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function fitZoom(natural: Size, available: Size): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  if (available.width <= 0 || available.height <= 0) return 1;
  return clampZoom(Math.min(available.width / natural.width, available.height / natural.height));
}

function numeric(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function contentBox(element: HTMLElement | null): Size | null {
  if (!element) return null;
  const style = window.getComputedStyle(element);
  const width = element.clientWidth - numeric(style.paddingLeft) - numeric(style.paddingRight);
  const height = element.clientHeight - numeric(style.paddingTop) - numeric(style.paddingBottom);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function svgNaturalSize(svg: string): Size | null {
  const viewBox = /viewBox="([\d.\-\s]+)"/i.exec(svg)?.[1];
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [, , width, height] = parts;
  return width > 0 && height > 0 ? { width, height } : null;
}

export function zoomFromWheel(event: {
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}): number | null {
  if (!event.ctrlKey && !event.metaKey) return null;
  return event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
}

function viewportSize(): Size {
  return {
    width: Math.max(1, window.innerWidth - VIEWPORT_MARGIN),
    height: Math.max(1, window.innerHeight - VIEWPORT_MARGIN),
  };
}

function availableSize(element: HTMLElement | null): Size {
  return contentBox(element) ?? viewportSize();
}

export function DiagramOverlay({
  label,
  natural,
  onClose,
  children,
}: {
  label: string;
  natural: Size | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [measured, setMeasured] = useState<Size | null>(natural);
  const pan = usePan(scrollRef);

  useEffect(() => {
    if (natural) {
      setMeasured(natural);
      return undefined;
    }
    const content = contentRef.current;
    if (!content) return undefined;
    const read = () => {
      const { scrollWidth, scrollHeight } = content;
      if (scrollWidth <= 0 || scrollHeight <= 0) return;
      setMeasured((prev) =>
        prev && prev.width === scrollWidth && prev.height === scrollHeight
          ? prev
          : { width: scrollWidth, height: scrollHeight },
      );
    };
    read();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(content);
    return () => observer.disconnect();
  }, [natural]);

  const fitToViewport = useCallback(() => {
    if (measured) setZoom(fitZoom(measured, availableSize(scrollRef.current)));
  }, [measured]);

  useEffect(() => {
    fitToViewport();
    surfaceRef.current?.focus();
  }, [fitToViewport]);

  useEffect(() => {
    window.addEventListener("resize", fitToViewport);
    return () => window.removeEventListener("resize", fitToViewport);
  }, [fitToViewport]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "+" || event.key === "=") setZoom((z) => clampZoom(z * ZOOM_STEP));
      if (event.key === "-") setZoom((z) => clampZoom(z / ZOOM_STEP));
      if (event.key === "0") fitToViewport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, fitToViewport]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const onWheel = (event: globalThis.WheelEvent) => {
      const zoomBy = zoomFromWheel(event);
      if (zoomBy === null) return;
      event.preventDefault();
      setZoom((z) => clampZoom(z * zoomBy));
    };
    const options = { passive: false, capture: true } as const;
    scroller.addEventListener("wheel", onWheel, options);
    return () => scroller.removeEventListener("wheel", onWheel, options);
  }, []);

  const scaled = measured
    ? { width: measured.width * zoom, height: measured.height * zoom }
    : undefined;

  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 flex flex-col bg-white outline-none dark:bg-slate-900"
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
        <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            aria-label="zoom out"
            className="px-2 leading-none"
            onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))}
            icon={<MagnifyingGlassMinusIcon className="h-5 w-5" />}
          />
          <span
            aria-live="polite"
            className="w-14 text-center text-xs tabular-nums text-slate-500 dark:text-slate-400"
          >
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            aria-label="zoom in"
            className="px-2 leading-none"
            onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))}
            icon={<MagnifyingGlassPlusIcon className="h-5 w-5" />}
          />
          <Button
            variant="ghost"
            aria-label="fit to window"
            className="px-2 leading-none"
            onClick={fitToViewport}
            icon={<ArrowsPointingInIcon className="h-5 w-5" />}
          />
          <Button
            variant="ghost"
            aria-label="close diagram"
            className="px-2 leading-none"
            onClick={onClose}
            icon={<XMarkIcon className="h-5 w-5" />}
          />
        </div>
      </div>
      <div
        ref={scrollRef}
        {...pan.handlers}
        className={`min-h-0 flex-1 touch-none overflow-auto p-6 ${pan.cursorClass}`}
      >
        <div style={scaled}>
          <div
            ref={contentRef}
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
              width: natural?.width,
              height: natural?.height,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DiagramFrame({
  label,
  natural,
  preview,
  full,
}: {
  label: string;
  natural: Size | null;
  preview: ReactNode;
  full: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group relative my-4">
      {preview}
      <Button
        variant="ghost"
        aria-label={`open ${label} full screen`}
        onClick={() => setOpen(true)}
        className="absolute right-2 top-2 bg-white/90 px-2 leading-none opacity-0 shadow-sm ring-1 ring-slate-200 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 dark:bg-slate-800/90 dark:ring-slate-600"
        icon={<ArrowsPointingOutIcon className="h-5 w-5" />}
      />
      {open ? (
        <DiagramOverlay label={label} natural={natural} onClose={() => setOpen(false)}>
          {full}
        </DiagramOverlay>
      ) : null}
    </div>
  );
}

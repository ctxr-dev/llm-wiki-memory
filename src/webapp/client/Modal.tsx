import { useEffect, useRef, type ReactNode, type KeyboardEvent } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { Button } from "./Button";

type ModalProps = {
  label: string;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  align?: "top" | "center";
  width?: string;
};

export function Modal({
  label,
  title,
  onClose,
  children,
  align = "top",
  width = "max-w-md",
}: ModalProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") onClose();
  };
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface && !surface.contains(document.activeElement)) surface.focus();
  }, []);
  const overlayAlign = align === "center" ? "items-center" : "sm:items-start sm:pt-32";
  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-black/30 ${overlayAlign}`}
      onClick={onClose}
    >
      <div
        ref={surfaceRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`flex w-full ${width} flex-col gap-3 bg-white p-4 shadow-xl outline-none dark:bg-slate-800 sm:rounded-lg`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {title !== undefined ? (
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h2>
            <Button
              variant="ghost"
              onClick={onClose}
              aria-label="close"
              className="px-2 leading-none"
              icon={<XMarkIcon className="h-5 w-5" />}
            />
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

import { type ReactNode } from "react";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Modal } from "./Modal";
import { Button } from "./Button";

type ConfirmDialogProps = {
  label: string;
  title?: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmIcon?: ReactNode;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  label,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmIcon,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal label={label} title={title} onClose={onCancel} align="center" width="max-w-sm">
      <p className="text-sm text-slate-600 dark:text-slate-300">{message}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} icon={<XMarkIcon className="h-4 w-4" />}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          icon={confirmIcon ?? <CheckIcon className="h-4 w-4" />}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

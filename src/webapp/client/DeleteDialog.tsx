import { useState } from "react";
import { TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { Modal } from "./Modal";
import { Button } from "./Button";

export function DeleteDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const armed = text.trim().toLowerCase() === "delete";
  return (
    <Modal
      label="delete document"
      title="Delete this document?"
      onClose={onCancel}
      align="center"
      width="max-w-sm"
    >
      <p className="text-sm text-slate-600 dark:text-slate-300">
        This permanently deletes <span className="font-medium">{name}</span> and cannot be undone
        from the app.
      </p>
      <label className="flex flex-col gap-1 text-sm text-slate-700 dark:text-slate-200">
        <span>
          Enter <span className="font-mono font-semibold">delete</span> in the input below to
          confirm:
        </span>
        <input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && armed) onConfirm();
          }}
          placeholder="delete"
          className="rounded border border-slate-200 bg-transparent px-2 py-1 text-sm text-slate-800 outline-none dark:border-slate-700 dark:text-slate-100"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} icon={<XMarkIcon className="h-4 w-4" />}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          disabled={!armed}
          icon={<TrashIcon className="h-4 w-4" />}
        >
          Delete
        </Button>
      </div>
    </Modal>
  );
}

import { useEffect, useRef } from "react";

import { useDeleteCase } from "../../api/queries.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";

/**
 * `DELETE /cases/{id}` is a hard delete, not an archive - files, clauses,
 * embeddings, extractions, flags and Q&A turns all go, and the content-addressed
 * blob is swept if nothing else references it. The confirmation names what goes
 * rather than asking "are you sure?", because the answer depends entirely on
 * knowing that.
 *
 * Uses the native `<dialog>`, which gives modality, focus trapping and Escape
 * without a library.
 */
export function DeleteCaseDialog({
  caseId,
  title,
  open,
  onClose,
  onDeleted,
}: {
  caseId: string;
  title: string;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const remove = useDeleteCase();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto max-w-md rounded-lg p-6 backdrop:bg-slate-900/40"
    >
      <h2 className="text-lg font-semibold text-slate-900">Delete “{title}”?</h2>
      <p className="mt-3 text-sm text-slate-600">
        This permanently deletes the uploaded files, their extracted text and embeddings, every
        extraction and red flag, and any questions you asked. It cannot be undone.
      </p>

      {remove.error && (
        <p className="mt-4 rounded border border-severity-red-border bg-severity-red-surface px-3 py-2 text-sm text-severity-red">
          {remove.error.message}
        </p>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
          Keep it
        </Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate(caseId, {
              onSuccess: () => {
                onClose();
                onDeleted?.();
              },
            });
          }}
        >
          {remove.isPending && <Spinner />}
          Delete permanently
        </Button>
      </div>
    </dialog>
  );
}

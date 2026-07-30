import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  ConflictError,
  PayloadTooLargeError,
  RateLimitError,
  UnsupportedMediaError,
} from "../../api/errors.js";
import { createCase } from "../../api/endpoints.js";
import { queryKeys } from "../../api/queries.js";
import { uploadDocument } from "../../api/upload.js";
import { RateLimitedNotice } from "../../components/states/rate-limited.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardTitle } from "../../components/ui/card.js";
import { Spinner } from "../../components/ui/spinner.js";

/** FR-1.1. Checked here for a fast, specific message; the server is authoritative. */
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ACCEPT = ".pdf,.docx,application/pdf," + DOCX_MIME;

function accepted(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".pdf") || name.endsWith(".docx");
}

function messageFor(error: unknown): string | null {
  if (error instanceof PayloadTooLargeError) return "That file is over the 25 MB limit.";
  if (error instanceof UnsupportedMediaError) return "Only PDF and DOCX files can be analyzed.";
  if (error instanceof ConflictError) return `A case holds at most ${String(MAX_FILES)} documents.`;
  if (error instanceof RateLimitError) return null; // rendered with a countdown instead
  if (error instanceof Error) return error.message;
  return error === null || error === undefined ? null : "Upload failed.";
}

export function UploadCard() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);

  async function send(files: File[]) {
    setError(null);

    const chosen = files.slice(0, MAX_FILES);
    const bad = chosen.find((f) => !accepted(f));
    if (bad) return setError(new UnsupportedMediaError(bad.name));
    const tooBig = chosen.find((f) => f.size > MAX_BYTES);
    if (tooBig) return setError(new PayloadTooLargeError(tooBig.name));
    if (chosen.length === 0) return;

    setBusy(true);
    try {
      // One case per upload batch: the comparison view works across documents
      // inside a case, so dropping two offers together is the useful default.
      const title =
        chosen.length === 1
          ? (chosen[0]?.name ?? "Untitled")
          : `${String(chosen.length)} documents`;
      const created = await createCase(title);

      for (const file of chosen) {
        await uploadDocument(created.id, file, { onProgress: setProgress });
      }

      await client.invalidateQueries({ queryKey: queryKeys.cases });
      await navigate(`/cases/${created.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const detail = messageFor(error);

  return (
    <Card>
      <CardTitle>Analyze your own document</CardTitle>
      <p className="mt-2 text-sm text-slate-600">
        PDF or DOCX, up to 25 MB and {MAX_FILES} documents. Deleted automatically after 24 hours.
      </p>

      <div
        className={
          "mt-4 rounded-lg border-2 border-dashed px-4 py-8 text-center transition " +
          (dragging ? "border-slate-500 bg-slate-50" : "border-slate-300")
        }
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void send(Array.from(e.dataTransfer.files));
        }}
      >
        <label htmlFor={inputId} className="cursor-pointer text-sm text-slate-600">
          Drop files here, or{" "}
          <span className="font-medium text-slate-900 underline">choose from your computer</span>
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            void send(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </div>

      {busy && (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-slate-600">
          <Spinner />
          {progress === null
            ? "Uploaded — the server is reading the document…"
            : `Uploading ${String(Math.round(progress * 100))}%`}
        </p>
      )}

      {error instanceof RateLimitError && (
        <div className="mt-4">
          <RateLimitedNotice error={error} action="Uploading" />
        </div>
      )}
      {detail !== null && (
        <p className="mt-4 rounded border border-severity-red-border bg-severity-red-surface px-3 py-2 text-sm text-severity-red">
          {detail}
        </p>
      )}

      <Button
        variant="secondary"
        className="mt-5 w-full"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        Choose files
      </Button>
    </Card>
  );
}

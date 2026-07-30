/**
 * The one request in the app that is not `fetch`.
 *
 * `fetch` still cannot report upload progress - a 25 MB scan over a slow link
 * would otherwise show a frozen spinner with no way to tell stalled from slow -
 * so this uses `XMLHttpRequest` and reuses the same status mapping so the
 * caller catches the same typed errors as everywhere else.
 */
import { documentUploadSchema } from "@contractix/shared/schemas";

import { apiUrl } from "./client.js";
import {
  ConflictError,
  HttpError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  ResponseShapeError,
  SessionError,
  UnsupportedMediaError,
} from "./errors.js";

export interface UploadOptions {
  /** 0-1, or null once the body is sent and the server is parsing. */
  onProgress?: (fraction: number | null) => void;
  signal?: AbortSignal;
}

function errorFor(status: number, path: string, body: string): Error {
  switch (status) {
    case 401: {
      // A session that expired mid-upload is the interesting case; the body
      // shape matches sessionErrorSchema, but reading it here is not worth a
      // parse when the shell only branches on `kind`.
      const expired = body.includes("session_expired");
      return new SessionError(
        expired ? "session_expired" : "no_session",
        expired ? "Your session expired." : "You do not have a session yet.",
      );
    }
    case 404:
      return new NotFoundError(path);
    case 409:
      return new ConflictError(path);
    case 413:
      return new PayloadTooLargeError(path);
    case 415:
      return new UnsupportedMediaError(path);
    case 429:
      return new RateLimitError({
        scope: "tenant",
        limit: null,
        windowSeconds: null,
        retryAfterSeconds: 3600,
        message: "Uploads are limited to 10 per hour on the anonymous demo.",
      });
    default:
      return new HttpError(status, body.slice(0, 300) || `Upload failed: ${String(status)}`);
  }
}

export function uploadDocument(
  caseId: string,
  file: File,
  options: UploadOptions = {},
): Promise<{ document: { id: string; filename: string }; deduplicated: boolean }> {
  const path = `/cases/${caseId}/documents`;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);

    xhr.open("POST", apiUrl(path));
    xhr.withCredentials = true;
    xhr.responseType = "text";

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) options.onProgress?.(e.loaded / e.total);
    });
    // The bytes are up; everything after this is server-side parsing, whose
    // duration this request cannot see. Reporting null beats a bar stuck at 100%.
    xhr.upload.addEventListener("load", () => {
      options.onProgress?.(null);
    });

    xhr.addEventListener("load", () => {
      if (xhr.status !== 200 && xhr.status !== 201) {
        reject(errorFor(xhr.status, path, xhr.responseText));
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        reject(new HttpError(xhr.status, "Upload response was not JSON"));
        return;
      }
      const parsed = documentUploadSchema.safeParse(json);
      if (!parsed.success) {
        reject(new ResponseShapeError(path, parsed.error));
        return;
      }
      resolve(parsed.data);
    });

    xhr.addEventListener("error", () => {
      reject(new HttpError(0, "Upload failed - the network dropped the request"));
    });
    xhr.addEventListener("abort", () => {
      reject(new DOMException("Upload aborted", "AbortError"));
    });

    options.signal?.addEventListener("abort", () => {
      xhr.abort();
    });

    xhr.send(form);
  });
}

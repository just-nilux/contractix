import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Content-addressed blob store on local disk (PRD v1; S3-compatible later).
 * Layout: {root}/{sha256}{ext} plus JSON sidecars {root}/{sha256}.{name}.json
 * (e.g. parsed blocks with bboxes for the Phase-3 highlighter).
 */
export class LocalBlobStore {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  blobPath(sha256: string, ext: string): string {
    return path.join(this.root, `${sha256}${ext}`);
  }

  async put(bytes: Uint8Array, ext: string): Promise<{ sha256: string; path: string }> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dest = this.blobPath(sha256, ext);
    try {
      await fs.access(dest);
    } catch {
      // Write-then-rename keeps the store free of torn blobs on crash.
      const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, dest);
    }
    return { sha256, path: dest };
  }

  async get(sha256: string, ext: string): Promise<Buffer> {
    return fs.readFile(this.blobPath(sha256, ext));
  }

  /** Streams a blob to an HTTP response without buffering 25 MB per request. */
  createReadStream(sha256: string, ext: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(
      createReadStream(this.blobPath(sha256, ext)),
    ) as ReadableStream<Uint8Array>;
  }

  async exists(sha256: string, ext: string): Promise<boolean> {
    try {
      await fs.access(this.blobPath(sha256, ext));
      return true;
    } catch {
      return false;
    }
  }

  async writeSidecar(sha256: string, name: string, data: unknown): Promise<void> {
    const dest = path.join(this.root, `${sha256}.${name}.json`);
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, dest);
  }

  async readSidecar<T>(sha256: string, name: string): Promise<T> {
    const raw = await fs.readFile(path.join(this.root, `${sha256}.${name}.json`), "utf8");
    return JSON.parse(raw) as T;
  }
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case "application/pdf":
      return ".pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    default:
      throw new Error(`no extension mapping for mime ${mime}`);
  }
}

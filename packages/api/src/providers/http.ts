export interface PostJsonOptions {
  attempts?: number;
  baseDelayMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal JSON POST with exponential backoff. Free-tier rate limits (Jina:
 * 100 RPM) surface as 429s during corpus ingestion; honoring Retry-After
 * beats hammering.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: PostJsonOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelay = opts.baseDelayMs ?? 1_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: Error = new Error("unreachable");
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
    if (res.ok) return (await res.json()) as T;

    const text = await res.text().catch(() => "");
    lastError = new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
    if (!RETRYABLE.has(res.status)) throw lastError;

    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      await sleep(retryAfter * 1_000);
    }
  }
  throw lastError;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * POST that consumes a Server-Sent Events response (the Anthropic streaming
 * Messages API). Retry/backoff applies **only to establishing the stream** —
 * once bytes are flowing a retry would silently replay a partial turn, so a
 * mid-stream failure propagates. Non-JSON `data:` payloads are skipped rather
 * than thrown on, since SSE permits comments and keep-alives.
 */
export async function postSse(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  onEvent: (ev: SseEvent) => void,
  opts: PostJsonOptions = {},
): Promise<void> {
  const attempts = opts.attempts ?? 5;
  const baseDelay = opts.baseDelayMs ?? 1_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: Error = new Error("unreachable");
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1));

    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastError = new Error(`${url} -> ${res.status}: ${text.slice(0, 300)}`);
      if (!RETRYABLE.has(res.status)) throw lastError;
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1_000);
      continue;
    }
    if (!res.body) throw new Error(`${url} -> 200 with no body`);

    await consumeSse(res.body, onEvent);
    return;
  }
  throw lastError;
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (frame: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
    }
    if (data.length === 0) return;
    const raw = data.join("\n");
    if (raw === "[DONE]") return;
    try {
      onEvent({ event, data: JSON.parse(raw) });
    } catch {
      // Keep-alives and comments are not JSON; ignore rather than kill the turn.
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // Frames are blank-line delimited; tolerate CRLF.
      while ((sep = buffer.search(/\r?\n\r?\n/u)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/u, "");
        flush(frame);
      }
    }
    if (buffer.trim().length > 0) flush(buffer);
  } finally {
    reader.releaseLock();
  }
}

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

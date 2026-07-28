import { createSseParser, type SseFrame } from "./sse.js";

/**
 * Turns a response body into a stream of frames.
 *
 * Split out from `postSse` so tests can drive it with a hand-built
 * `ReadableStream` and no fetch at all.
 *
 * Uses `TextDecoder` with `{ stream: true }` rather than piping through
 * `TextDecoderStream`: it behaves identically for our purposes and does not
 * depend on a global that jsdom may or may not provide. The decoder must be
 * reused across reads, because a multi-byte character can straddle a chunk
 * boundary - the German corpus makes that a certainty, not a curiosity.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) {
        yield* parser.flush();
        return;
      }
      if (value) yield* parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Closes the socket when the consumer stops early - an unmounted component
    // must not leave a generation running and billing.
    await reader.cancel().catch(() => undefined);
  }
}

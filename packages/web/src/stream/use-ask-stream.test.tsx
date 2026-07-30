import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PostSseModule from "./post-sse.js";
import { type SseFrame } from "./sse.js";

const postSse = vi.hoisted(() => vi.fn());
vi.mock("./post-sse.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PostSseModule>()),
  postSse,
}));

const { useAskStream } = await import("./use-ask-stream.js");

/** A stream that yields nothing until `release()`, then ends. */
function pausableStream() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  async function* run(_path: string, opts: { signal?: AbortSignal } = {}) {
    await gate;
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    // Yields nothing: these tests are about `running`, not about frames. The
    // empty loop is what makes this an async *generator* rather than a promise.
    for (const frame of [] as SseFrame[]) yield frame;
  }

  return { run, release: () => release() };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useAskStream", () => {
  beforeEach(() => {
    postSse.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tracks a question from asked to finished", async () => {
    const first = pausableStream();
    postSse.mockImplementation(first.run);

    const { result } = renderHook(() => useAskStream("case-1"), { wrapper });

    act(() => {
      result.current.ask("Wie lang ist die Probezeit?");
    });
    expect(result.current.running).toBe(true);
    await waitFor(() => {
      expect(result.current.turns).toHaveLength(1);
    });

    act(() => {
      first.release();
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });
  });

  /**
   * `stop()` clears `abortRef` synchronously, so a second question can start
   * while the stopped task is still unwinding. Its `finally` must not report
   * the *newer* stream as finished — that would hide the Stop button and
   * re-enable Ask on a request still in flight.
   */
  it("does not let a stopped request clear a newer request's running state", async () => {
    const stopped = pausableStream();
    const live = pausableStream();
    postSse.mockImplementationOnce(stopped.run).mockImplementationOnce(live.run);

    const { result } = renderHook(() => useAskStream("case-1"), { wrapper });

    act(() => {
      result.current.ask("first");
    });
    await waitFor(() => {
      expect(result.current.turns).toHaveLength(1);
    });

    act(() => {
      result.current.stop();
    });
    expect(result.current.running).toBe(false);

    // The second question starts before the first task has unwound.
    act(() => {
      result.current.ask("second");
    });
    expect(result.current.running).toBe(true);

    // Now let the stopped task run its `finally`.
    act(() => {
      stopped.release();
    });
    await waitFor(() => {
      expect(result.current.turns).toHaveLength(2);
    });

    // The live request is still in flight, and the UI must still say so.
    expect(result.current.running).toBe(true);

    act(() => {
      live.release();
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });
  });

  it("refuses a second question while one is in flight", async () => {
    const first = pausableStream();
    postSse.mockImplementation(first.run);

    const { result } = renderHook(() => useAskStream("case-1"), { wrapper });

    act(() => {
      result.current.ask("first");
    });
    act(() => {
      result.current.ask("second");
    });

    await waitFor(() => {
      expect(result.current.turns).toHaveLength(1);
    });
    expect(postSse).toHaveBeenCalledTimes(1);

    act(() => {
      first.release();
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });
  });
});

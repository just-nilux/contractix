import { narrativeStreamEventSchema } from "@contractix/shared/schemas";
import { describe, expect, it, vi } from "vitest";

import { parseStreamFrame } from "./post-sse.js";
import { readSse } from "./read-sse.js";
import { type SseFrame } from "./sse.js";

/**
 * The underlying source's `cancel` is what actually fires when a reader cancels
 * — and it is the only spec-defined observable for it, since `reader.cancel()`
 * deliberately does *not* release the lock. For a fetch body, this callback
 * running is the socket closing.
 */
function streamOf(
  chunks: (string | Uint8Array)[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
    ...(onCancel ? { cancel: onCancel } : {}),
  });
}

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const frames: SseFrame[] = [];
  for await (const frame of readSse(stream, signal)) frames.push(frame);
  return frames;
}

describe("readSse", () => {
  it("yields frames as they complete across chunk boundaries", async () => {
    const frames = await collect(
      streamOf(['event: token\ndata: {"text":"a', '"}\n\n', "event: restart\ndata: {}\n\n"]),
    );

    expect(frames).toEqual([
      { event: "token", data: '{"text":"a"}' },
      { event: "restart", data: "{}" },
    ]);
  });

  it("decodes a multi-byte character split across two chunks", async () => {
    // "ä" is two bytes in UTF-8. A per-chunk decoder would emit a replacement
    // character here — and the German corpus guarantees this case.
    const bytes = new TextEncoder().encode('event: token\ndata: {"text":"Kündigungsfrist"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "ü"

    const frames = await collect(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));

    expect(frames).toEqual([{ event: "token", data: '{"text":"Kündigungsfrist"}' }]);
  });

  it("yields nothing and closes the body when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = vi.fn();
    const stream = streamOf(["event: token\ndata: {}\n\n"], cancelled);

    expect(await collect(stream, controller.signal)).toEqual([]);
    expect(cancelled).toHaveBeenCalled();
  });

  it("closes the body when the consumer stops early", async () => {
    const cancelled = vi.fn();
    const stream = streamOf(["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"], cancelled);

    for await (const frame of readSse(stream)) {
      expect(frame.event).toBe("a");
      break; // an unmounted component must not leave a generation billing
    }

    expect(cancelled).toHaveBeenCalled();
  });
});

describe("parseStreamFrame", () => {
  it("injects the event name as the discriminator for a bare done body", () => {
    // `done` carries the response object with no `type` field of its own.
    const done = {
      turnId: "018f4b3e-7c2a-7000-8000-000000000001",
      markdown: "# Report",
      disclaimer: "x",
      citations: [],
      couldNotVerify: [],
      grounded: true,
      corrected: false,
      promptVersion: "1",
      createdAt: "2026-07-28T10:00:00.000Z",
      trace: {},
    };

    const parsed = parseStreamFrame(narrativeStreamEventSchema, {
      event: "done",
      data: JSON.stringify(done),
    });

    expect(parsed).toMatchObject({ type: "done", markdown: "# Report" });
  });

  it("passes through a frame that already carries its own type", () => {
    const parsed = parseStreamFrame(narrativeStreamEventSchema, {
      event: "token",
      data: '{"type":"token","text":"hello"}',
    });

    expect(parsed).toEqual({ type: "token", text: "hello" });
  });

  it("ignores a heartbeat rather than failing the stream", () => {
    expect(
      parseStreamFrame(narrativeStreamEventSchema, { event: "heartbeat", data: "" }),
    ).toBeNull();
  });

  it("ignores an event variant this client does not know", () => {
    expect(
      parseStreamFrame(narrativeStreamEventSchema, { event: "invented_later", data: "{}" }),
    ).toBeNull();
  });

  it("ignores a frame whose payload does not match its schema", () => {
    expect(
      parseStreamFrame(narrativeStreamEventSchema, { event: "token", data: '{"text":42}' }),
    ).toBeNull();
  });
});

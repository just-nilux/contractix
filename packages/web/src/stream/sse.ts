/**
 * A Server-Sent Events frame parser: pure, no DOM, no fetch.
 *
 * `EventSource` handles the one GET stream, but `ask` and `narrative` are POSTs
 * with a JSON body, which `EventSource` cannot issue - so those streams have to
 * be read and framed by hand. Keeping the framing here, separate from the
 * reading, is what lets it be tested by feeding it strings split at every
 * awkward boundary rather than by standing up a server.
 *
 * Implements the WHATWG event-stream subset the API actually produces, and one
 * detail worth stating because it looks like a bug: a frame whose data field is
 * present but empty *does* dispatch. That is the shape of Hono's heartbeat
 * (`event: heartbeat` + an empty `data:`), so heartbeats arrive as frames and
 * are discarded by name rather than never arriving at all. A frame with no data
 * field at all dispatches nothing, per spec.
 */

export interface SseFrame {
  /** The event name; `message` when the stream did not name one. */
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface SseParser {
  /** Feed a decoded chunk; returns whichever frames completed inside it. */
  push(chunk: string): SseFrame[];
  /** Called at end of stream: emits a final frame that lacked its blank line. */
  flush(): SseFrame[];
}

const LINE_BREAK = /\r\n|\n|\r/;

export function createSseParser(): SseParser {
  let buffer = "";
  let seenFirstChunk = false;
  let eventType = "";
  let data = "";
  let lastId: string | undefined;
  let retry: number | undefined;

  function dispatch(out: SseFrame[]): void {
    // Spec: an empty data buffer means "no event", not "an event with no data".
    if (data === "") {
      eventType = "";
      return;
    }
    out.push({
      event: eventType === "" ? "message" : eventType,
      // Every data line contributed a trailing newline; the last one is not part
      // of the payload.
      data: data.endsWith("\n") ? data.slice(0, -1) : data,
      ...(lastId === undefined ? {} : { id: lastId }),
      ...(retry === undefined ? {} : { retry }),
    });
    eventType = "";
    data = "";
  }

  function handleLine(line: string, out: SseFrame[]): void {
    if (line === "") return dispatch(out);
    if (line.startsWith(":")) return; // comment / keep-alive padding

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        eventType = value;
        break;
      case "data":
        data += value + "\n";
        break;
      case "id":
        if (!value.includes("\0")) lastId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored, which is how the format evolves
    }
  }

  return {
    push(chunk: string): SseFrame[] {
      let text = chunk;
      if (!seenFirstChunk && text.length > 0) {
        seenFirstChunk = true;
        if (text.startsWith("﻿")) text = text.slice(1);
      }
      buffer += text;

      const out: SseFrame[] = [];
      for (;;) {
        const match = LINE_BREAK.exec(buffer);
        if (!match) break;
        // A lone CR at the very end may yet turn out to be the first half of a
        // CRLF, so it is not a line terminator until the next chunk says so.
        if (match[0] === "\r" && match.index === buffer.length - 1) break;
        handleLine(buffer.slice(0, match.index), out);
        buffer = buffer.slice(match.index + match[0].length);
      }
      return out;
    },

    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      // The spec discards an incomplete trailing line. We emit it instead: a
      // server that closes cleanly after its last frame without a final blank
      // line has still told us everything, and dropping it would lose a `done`.
      if (buffer !== "") {
        handleLine(buffer, out);
        buffer = "";
      }
      dispatch(out);
      return out;
    },
  };
}

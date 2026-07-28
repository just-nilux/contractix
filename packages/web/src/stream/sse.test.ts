import { describe, expect, it } from "vitest";

import { createSseParser, type SseFrame } from "./sse.js";

/** Feeds the whole text one character at a time - the worst chunking possible. */
function pushByCharacter(text: string): SseFrame[] {
  const parser = createSseParser();
  const frames: SseFrame[] = [];
  for (const ch of text) frames.push(...parser.push(ch));
  frames.push(...parser.flush());
  return frames;
}

function pushWhole(text: string): SseFrame[] {
  const parser = createSseParser();
  return [...parser.push(text), ...parser.flush()];
}

describe("createSseParser", () => {
  it("parses a named event", () => {
    expect(pushWhole('event: token\ndata: {"text":"hi"}\n\n')).toEqual([
      { event: "token", data: '{"text":"hi"}' },
    ]);
  });

  it("defaults the event name to message", () => {
    expect(pushWhole("data: bare\n\n")).toEqual([{ event: "message", data: "bare" }]);
  });

  it("joins multi-line data with newlines", () => {
    expect(pushWhole("event: x\ndata: one\ndata: two\n\n")).toEqual([
      { event: "x", data: "one\ntwo" },
    ]);
  });

  it("dispatches a heartbeat, whose data field is present but empty", () => {
    // Hono writes `writeSSE({ data: "", event: "heartbeat" })`. If this did not
    // dispatch, a heartbeat would be indistinguishable from a dead connection.
    expect(pushWhole("event: heartbeat\ndata: \n\n")).toEqual([{ event: "heartbeat", data: "" }]);
  });

  it("dispatches nothing for an event with no data field at all", () => {
    expect(pushWhole("event: lonely\n\n")).toEqual([]);
  });

  it("ignores comment lines", () => {
    expect(pushWhole(": keep-alive\nevent: x\ndata: y\n\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it("ignores unknown fields", () => {
    expect(pushWhole("event: x\nfuture: 1\ndata: y\n\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it("carries id and retry when the stream sends them", () => {
    expect(pushWhole("id: 7\nretry: 2500\nevent: x\ndata: y\n\n")).toEqual([
      { event: "x", data: "y", id: "7", retry: 2500 },
    ]);
  });

  it("ignores a non-numeric retry", () => {
    expect(pushWhole("retry: soon\ndata: y\n\n")).toEqual([{ event: "message", data: "y" }]);
  });

  it("strips exactly one leading space from a value", () => {
    expect(pushWhole("data:  two spaces\n\n")).toEqual([{ event: "message", data: " two spaces" }]);
  });

  it("treats a field with no colon as an empty value", () => {
    expect(pushWhole("data\nevent: x\ndata: y\n\n")).toEqual([{ event: "x", data: "\ny" }]);
  });

  it("strips a leading BOM once", () => {
    expect(pushWhole("﻿event: x\ndata: y\n\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("handles %s line endings", (_name, eol) => {
    const text = ["event: x", "data: y", "", ""].join(eol);
    expect(pushWhole(text)).toEqual([{ event: "x", data: "y" }]);
  });

  it("does not split a CRLF that straddles two chunks", () => {
    const parser = createSseParser();
    // The \r ends the chunk; treating it as a terminator now would produce a
    // spurious blank line and dispatch the frame twice.
    expect(parser.push("event: x\r")).toEqual([]);
    expect(parser.push("\ndata: y\r\n\r\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it("produces the same frames however the bytes are chunked", () => {
    const text =
      'event: token\ndata: {"text":"a"}\n\n' +
      "event: heartbeat\ndata: \n\n" +
      'event: done\ndata: {"markdown":"x"}\n\n';

    expect(pushByCharacter(text)).toEqual(pushWhole(text));
    expect(pushWhole(text)).toEqual([
      { event: "token", data: '{"text":"a"}' },
      { event: "heartbeat", data: "" },
      { event: "done", data: '{"markdown":"x"}' },
    ]);
  });

  it("emits a final frame that the server did not terminate with a blank line", () => {
    // Losing this would mean losing a `done` on an abrupt but complete close.
    expect(pushWhole("event: done\ndata: {}\n")).toEqual([{ event: "done", data: "{}" }]);
  });

  it("emits nothing from a flush with no pending data", () => {
    const parser = createSseParser();
    expect(parser.push("event: x\ndata: y\n\n")).toHaveLength(1);
    expect(parser.flush()).toEqual([]);
  });
});

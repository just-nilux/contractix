import { type Narrative, type NarrativeStreamEvent } from "@contractix/shared/schemas";
import { describe, expect, it } from "vitest";

import {
  initialNarrativeState,
  narrativeReducer,
  type NarrativeState,
} from "./narrative-reducer.js";

const DONE: Narrative = {
  turnId: "018f4b3e-7c2a-7000-8000-000000000001",
  markdown: "# The corrected report",
  disclaimer: "Informational analysis…",
  citations: [],
  couldNotVerify: ["One unverifiable claim."],
  grounded: true,
  corrected: true,
  promptVersion: "1",
  createdAt: "2026-07-28T10:00:00.000Z",
  trace: {
    model: "claude-sonnet-5",
    stopReason: "end_turn",
    citableClauseIds: [],
    promptVersion: "1",
    corrections: [{ attempt: 1, uncited: ["One unverifiable claim."], unresolvedMarkers: [] }],
    inputFields: 12,
    inputFlags: 3,
    stubbed: false,
  },
};

function run(events: NarrativeStreamEvent[]): NarrativeState {
  return events.reduce(narrativeReducer, initialNarrativeState);
}

describe("narrativeReducer", () => {
  it("accumulates tokens", () => {
    const state = run([
      { type: "token", text: "# Report\n" },
      { type: "token", text: "The base salary is " },
    ]);

    expect(state.status).toBe("streaming");
    expect(state.markdown).toBe("# Report\nThe base salary is ");
  });

  it("records why the validator rejected a draft", () => {
    const state = run([
      { type: "token", text: "draft" },
      { type: "retry", reason: "2 sentences carried no citation" },
    ]);

    expect(state.status).toBe("correcting");
    expect(state.retryReason).toBe("2 sentences carried no citation");
    // Not cleared yet: `retry` announces the correction, `restart` performs it.
    expect(state.markdown).toBe("draft");
  });

  it("discards the rejected draft on restart", () => {
    const state = run([
      { type: "token", text: "the rejected draft" },
      { type: "retry", reason: "uncited claim" },
      { type: "restart" },
      { type: "token", text: "the corrected draft" },
    ]);

    // Appending instead of discarding would show both drafts concatenated,
    // which reads as one confused report rather than as a correction.
    expect(state.markdown).toBe("the corrected draft");
    expect(state.corrected).toBe(true);
  });

  it("replaces the buffer with the validated text on done", () => {
    const state = run([
      { type: "token", text: "partial and possibly stale" },
      { type: "done", ...DONE },
    ]);

    // The route's contract: what is on screen must be the text whose citations
    // were actually validated, not whatever happened to accumulate.
    expect(state.markdown).toBe("# The corrected report");
    expect(state.status).toBe("done");
    expect(state.result?.couldNotVerify).toEqual(["One unverifiable claim."]);
  });

  it("keeps the corrected flag when the stream restarted but done says otherwise", () => {
    const state = run([{ type: "restart" }, { type: "done", ...DONE, corrected: false }]);

    expect(state.corrected).toBe(true);
  });

  it("discards a partial report on error", () => {
    const state = run([
      { type: "token", text: "half a report" },
      { type: "error", message: "the provider dropped the stream" },
    ]);

    // A half-written report whose citations were never validated is worse than
    // no report.
    expect(state.status).toBe("error");
    expect(state.markdown).toBe("");
    expect(state.error).toBe("the provider dropped the stream");
  });

  it("survives the full correction sequence in order", () => {
    const state = run([
      { type: "token", text: "a" },
      { type: "retry", reason: "r" },
      { type: "restart" },
      { type: "token", text: "b" },
      { type: "done", ...DONE },
    ]);

    expect(state).toMatchObject({
      status: "done",
      markdown: "# The corrected report",
      corrected: true,
      retryReason: "r",
    });
  });
});

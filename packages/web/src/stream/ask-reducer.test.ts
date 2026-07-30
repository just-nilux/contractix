import { type AskResponse } from "@contractix/shared/schemas";
import { describe, expect, it } from "vitest";

import { type AskAction, askReducer, type AskState, initialAskState } from "./ask-reducer.js";

const RESPONSE: AskResponse = {
  turnId: "018f4b3e-7c2a-7000-8000-000000000001",
  question: "Wie lang ist die Probezeit?",
  answer: "Die Probezeit beträgt sechs Monate. [[doc:2:§3]]",
  disclaimer: "Informational analysis…",
  citations: [],
  couldNotVerify: [],
  grounded: true,
  corrected: false,
  usage: { inputTokens: 900, outputTokens: 120, costEur: 0.0031, latencyMs: 4200 },
  trace: {
    model: "claude-sonnet-5",
    stopReason: "end_turn",
    citableClauseIds: ["doc:2:§3"],
    turns: 2,
    steps: [],
    corrections: [],
  },
};

const asked: AskAction = { type: "asked", id: "t1", question: "Wie lang ist die Probezeit?" };

function run(actions: AskAction[]): AskState {
  return actions.reduce(askReducer, initialAskState);
}

describe("askReducer", () => {
  it("accumulates tokens into the turn in flight", () => {
    const state = run([
      asked,
      { type: "token", text: "Die Probezeit " },
      { type: "token", text: "beträgt sechs Monate." },
    ]);

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.status).toBe("streaming");
    expect(state.turns[0]?.answer).toBe("Die Probezeit beträgt sechs Monate.");
  });

  it("pairs a tool result with its call and records what it surfaced", () => {
    const state = run([
      asked,
      { type: "tool_call", name: "search_clauses", input: { query: "Probezeit" } },
      { type: "tool_result", name: "search_clauses", ok: true, clauseCount: 8 },
    ]);

    expect(state.turns[0]?.activity).toEqual([
      { name: "search_clauses", input: { query: "Probezeit" }, ok: true, clauseCount: 8 },
    ]);
  });

  it("closes the oldest open call when the same tool is called twice", () => {
    const state = run([
      asked,
      { type: "tool_call", name: "search_clauses", input: { query: "a" } },
      { type: "tool_call", name: "search_clauses", input: { query: "b" } },
      { type: "tool_result", name: "search_clauses", ok: true, clauseCount: 3 },
    ]);

    expect(state.turns[0]?.activity[0]?.clauseCount).toBe(3);
    expect(state.turns[0]?.activity[1]?.ok).toBeNull();
  });

  /**
   * The asymmetry worth a test of its own: `ask` disables streaming on the
   * corrective turn, so unlike `narrative` there is no `restart` frame and no
   * second stream of tokens. Clearing the buffer here would blank the screen
   * for the rest of the request.
   */
  it("keeps the rejected draft visible on retry, because no restart is coming", () => {
    const state = run([
      asked,
      { type: "token", text: "Die Probezeit beträgt drei Monate." },
      { type: "retry", reason: "one sentence carried no citation" },
    ]);

    expect(state.turns[0]?.status).toBe("correcting");
    expect(state.turns[0]?.answer).toBe("Die Probezeit beträgt drei Monate.");
    expect(state.turns[0]?.retryReason).toBe("one sentence carried no citation");
  });

  it("replaces the draft with the validated answer on done rather than appending", () => {
    const state = run([
      asked,
      { type: "token", text: "Die Probezeit beträgt drei Monate." },
      { type: "retry", reason: "uncited" },
      { ...RESPONSE, type: "done", corrected: true },
    ]);

    expect(state.turns[0]?.status).toBe("done");
    expect(state.turns[0]?.answer).toBe(RESPONSE.answer);
    expect(state.turns[0]?.answer).not.toContain("drei Monate");
    expect(state.turns[0]?.result?.corrected).toBe(true);
    expect(state.turns[0]?.result?.usage.costEur).toBe(0.0031);
  });

  it("keeps the question but discards the partial answer on error", () => {
    const state = run([
      asked,
      { type: "token", text: "half an answer" },
      { type: "error", message: "The upstream model is unavailable." },
    ]);

    expect(state.turns[0]?.question).toBe("Wie lang ist die Probezeit?");
    expect(state.turns[0]?.answer).toBe("");
    expect(state.turns[0]?.error).toBe("The upstream model is unavailable.");
  });

  it("drops a turn whose request never ran, so a 429 leaves no ghost", () => {
    const state = run([asked, { type: "dropped" }]);
    expect(state.turns).toEqual([]);
  });

  it("closes a cancelled turn instead of leaving it streaming forever", () => {
    const state = run([asked, { type: "token", text: "half" }, { type: "cancelled" }]);

    expect(state.turns[0]?.status).toBe("error");
    expect(state.turns[0]?.answer).toBe("");
  });

  it("leaves a finished turn alone when a later cancel arrives", () => {
    const state = run([asked, { ...RESPONSE, type: "done" }, { type: "cancelled" }]);
    expect(state.turns[0]?.status).toBe("done");
    expect(state.turns[0]?.answer).toBe(RESPONSE.answer);
  });

  it("appends a second question without touching the first", () => {
    const state = run([
      asked,
      { ...RESPONSE, type: "done" },
      { type: "asked", id: "t2", question: "And the notice period?" },
      { type: "token", text: "Three months." },
    ]);

    expect(state.turns).toHaveLength(2);
    expect(state.turns[0]?.status).toBe("done");
    expect(state.turns[0]?.answer).toBe(RESPONSE.answer);
    expect(state.turns[1]?.answer).toBe("Three months.");
  });

  it("ignores stream events that arrive with no turn open", () => {
    expect(run([{ type: "token", text: "orphan" }])).toEqual(initialAskState);
  });
});

import { type AskResponse } from "@contractix/shared/schemas";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CitationProvider } from "../../citations/citation-context.js";
import { type AskTurn } from "../../stream/ask-reducer.js";
import { ChatTurn } from "./chat-turn.js";

const DOC = "018f4b3e-7c2a-7000-8000-0000000000d1";
const MARKER = `${DOC}:2:§3`;

const RESPONSE: AskResponse = {
  turnId: "018f4b3e-7c2a-7000-8000-000000000001",
  question: "Wie lang ist die Probezeit?",
  answer: `Die Probezeit beträgt sechs Monate. [[${MARKER}]]`,
  disclaimer: "Informational analysis…",
  citations: [
    {
      clauseId: "018f4b3e-7c2a-7000-8000-00000000000a",
      serializedClauseId: MARKER,
      documentId: DOC,
      page: 2,
      charStart: 100,
      charEnd: 134,
      verbatimAnchor: "Die Probezeit beträgt sechs Monate.",
    },
  ],
  couldNotVerify: [],
  grounded: true,
  corrected: false,
  usage: { inputTokens: 900, outputTokens: 120, costEur: 0.0031, latencyMs: 4200 },
  trace: {
    model: "claude-sonnet-5",
    stopReason: "end_turn",
    citableClauseIds: [MARKER],
    turns: 2,
    steps: [],
    corrections: [],
  },
};

function turn(overrides: Partial<AskTurn> = {}): AskTurn {
  return {
    id: "t1",
    question: "Wie lang ist die Probezeit?",
    status: "done",
    answer: RESPONSE.answer,
    activity: [],
    retryReason: null,
    result: RESPONSE,
    error: null,
    ...overrides,
  };
}

function renderTurn(t: AskTurn) {
  return render(
    <CitationProvider>
      <ul>
        <ChatTurn turn={t} />
      </ul>
    </CitationProvider>,
  );
}

describe("ChatTurn", () => {
  it("renders the answer with its marker resolved to a clickable clause", () => {
    renderTurn(turn());

    expect(screen.getByText("Wie lang ist die Probezeit?")).toBeInTheDocument();
    // The marker became a chip, not literal `[[...]]` text.
    expect(screen.getByRole("button", { name: "p2" })).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(MARKER, "u"))).not.toBeInTheDocument();
    expect(screen.getByText(/Every claim tied to a clause/u)).toBeInTheDocument();
  });

  it("shows live tool activity while the agent is working", () => {
    renderTurn(
      turn({
        status: "streaming",
        answer: "",
        result: null,
        activity: [
          { name: "search_clauses", input: { query: "Probezeit" }, ok: true, clauseCount: 8 },
          { name: "get_clause", input: {}, ok: null, clauseCount: null },
        ],
      }),
    );

    expect(screen.getByText("Searching the clauses")).toBeInTheDocument();
    expect(screen.getByText("— 8 clauses")).toBeInTheDocument();
    expect(screen.getByText("Reading a clause")).toBeInTheDocument();
  });

  /**
   * Mid-stream the citation list does not exist yet, so a marker that matches
   * nothing says nothing — flagging it would paint a live answer amber.
   */
  it("does not call a marker unresolved while the answer is still streaming", () => {
    renderTurn(turn({ status: "streaming", answer: `Sechs Monate. [[${MARKER}]]`, result: null }));

    expect(screen.queryByText("unresolved")).not.toBeInTheDocument();
    expect(screen.getByText("cited")).toBeInTheDocument();
  });

  it("surfaces claims the validator could not tie to a clause (FR-5.2)", () => {
    renderTurn(
      turn({
        result: {
          ...RESPONSE,
          grounded: false,
          couldNotVerify: ["Vesting is usually four years.", "Vesting is usually four years."],
        },
      }),
    );

    expect(screen.getByText(/could not be tied to a clause/u)).toBeInTheDocument();
    // Both, not deduplicated away: the model repeating itself is information.
    expect(screen.getAllByText("Vesting is usually four years.")).toHaveLength(2);
    expect(screen.getByText(/Some claims unverified/u)).toBeInTheDocument();
  });

  it("says why it is re-checking rather than looking stalled", () => {
    renderTurn(
      turn({
        status: "correcting",
        answer: "Die Probezeit beträgt drei Monate.",
        retryReason: "one sentence carried no citation",
        result: null,
      }),
    );

    expect(screen.getByText(/Re-checking citations/u)).toBeInTheDocument();
    expect(screen.getByText(/one sentence carried no citation/u)).toBeInTheDocument();
    // The rejected draft stays on screen: there is no second stream of tokens.
    expect(screen.getByText(/drei Monate/u)).toBeInTheDocument();
  });

  it("shows an error instead of a half-written answer", () => {
    renderTurn(
      turn({ status: "error", answer: "", error: "The model is unavailable.", result: null }),
    );

    expect(screen.getByText("The model is unavailable.")).toBeInTheDocument();
  });
});

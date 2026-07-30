import { type AskResponse } from "@contractix/shared/schemas";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CitationProvider, useCitations } from "../../citations/citation-context.js";
import { type CitationTarget } from "../../citations/types.js";
import { TraceDrawer } from "./trace-drawer.js";

const DOC = "018f4b3e-7c2a-7000-8000-0000000000d1";
const CLAUSE = "018f4b3e-7c2a-7000-8000-00000000000a";
const MARKER = `${DOC}:2:§3`;

function response(overrides: Partial<AskResponse> = {}): AskResponse {
  return {
    turnId: "018f4b3e-7c2a-7000-8000-000000000001",
    question: "Wie lang ist die Probezeit?",
    answer: `Sechs Monate. [[${MARKER}]]`,
    disclaimer: "Informational analysis…",
    citations: [],
    couldNotVerify: [],
    grounded: true,
    corrected: false,
    usage: { inputTokens: 912, outputTokens: 120, costEur: 0.0031, latencyMs: 4200 },
    trace: {
      model: "claude-sonnet-5",
      stopReason: "end_turn",
      citableClauseIds: [MARKER],
      turns: 2,
      steps: [
        {
          turn: 1,
          tool: "search_clauses",
          input: { query: "Probezeit" },
          ok: true,
          clauseCount: 1,
          durationMs: 340,
          clauses: [
            {
              clauseId: CLAUSE,
              serializedClauseId: MARKER,
              documentId: DOC,
              clauseRef: "2:§3",
              page: 2,
              heading: "Probezeit",
            },
          ],
        },
      ],
      corrections: [],
    },
    ...overrides,
  };
}

/** Reports what the citation context was asked to open. */
function Probe({ onTarget }: { onTarget: (t: CitationTarget | null) => void }) {
  const { target } = useCitations();
  onTarget(target);
  return null;
}

function renderDrawer(
  r: AskResponse,
  onTarget: (t: CitationTarget | null) => void = () => undefined,
) {
  return render(
    <CitationProvider>
      <Probe onTarget={onTarget} />
      <TraceDrawer response={r} onClose={() => undefined} />
    </CitationProvider>,
  );
}

describe("TraceDrawer", () => {
  it("shows each tool call with its duration, arguments and clauses", () => {
    renderDrawer(response());

    expect(screen.getByText("search_clauses")).toBeInTheDocument();
    expect(screen.getByText(/340 ms/u)).toBeInTheDocument();
    expect(screen.getByText('{"query":"Probezeit"}')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Probezeit · p2/u })).toBeInTheDocument();
    expect(screen.getByText(/1 clause was citable/u)).toBeInTheDocument();
  });

  it("opens the viewer at the clause a step surfaced", async () => {
    let target: CitationTarget | null = null;
    renderDrawer(response(), (t) => {
      target = t;
    });

    await userEvent.click(screen.getByRole("button", { name: /Probezeit · p2/u }));

    expect(target).toEqual({
      documentId: DOC,
      clauseId: CLAUSE,
      page: 2,
      // The trace records which clause, not which span: the viewer resolves the
      // whole clause from its own frozen offsets.
      charStart: null,
      charEnd: null,
      verbatimAnchor: null,
    });
  });

  it("shows what the validator rejected when the retry fired", () => {
    renderDrawer(
      response({
        corrected: true,
        grounded: true,
        trace: {
          ...response().trace,
          corrections: [
            {
              turn: 2,
              uncited: ["Vesting is usually four years."],
              unresolvedMarkers: [`${DOC}:9:§99`],
            },
          ],
        },
      }),
    );

    expect(screen.getByText(/What the validator rejected/u)).toBeInTheDocument();
    expect(screen.getByText("Vesting is usually four years.")).toBeInTheDocument();
    expect(screen.getByText(`${DOC}:9:§99`)).toBeInTheDocument();
    expect(screen.getByText(/regenerated once/u)).toBeInTheDocument();
  });

  it("omits the rejection section when the first answer held", () => {
    renderDrawer(response());
    expect(screen.queryByText(/What the validator rejected/u)).not.toBeInTheDocument();
  });

  it("reports tokens and cost", () => {
    renderDrawer(response());

    expect(screen.getByText("912")).toBeInTheDocument();
    expect(screen.getByText("€0.0031")).toBeInTheDocument();
    expect(screen.getByText(/4,200 ms/u)).toBeInTheDocument();
  });

  /**
   * A keyless deployment spends nothing, and rendering €0.0000 as if it were a
   * measurement would be the first dishonest number in this codebase.
   */
  it("says so instead of pricing a keyless answer at zero", () => {
    renderDrawer(
      response({ usage: { inputTokens: 0, outputTokens: 0, costEur: 0, latencyMs: 12 } }),
    );

    expect(screen.getByText(/without a model key/u)).toBeInTheDocument();
    expect(screen.queryByText("€0.0000")).not.toBeInTheDocument();
  });

  it("says the agent used no tools rather than showing an empty list", () => {
    renderDrawer(response({ trace: { ...response().trace, steps: [], citableClauseIds: [] } }));

    expect(screen.getByText(/answered without calling a tool/u)).toBeInTheDocument();
    expect(screen.getByText(/0 clauses were citable/u)).toBeInTheDocument();
  });
});

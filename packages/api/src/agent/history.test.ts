import { describe, expect, it } from "vitest";

import {
  MAX_HISTORY_ANSWER_CHARS,
  type PriorTurn,
  stripMarkers,
  toHistoryMessages,
} from "./history.js";

const DOC = "6a2f1c3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
const MARKER = `${DOC}:2:§3`;

function textOf(message: { content: { type: string }[] }): string {
  const block = message.content[0];
  return block && "text" in block ? (block as { text: string }).text : "";
}

describe("stripMarkers", () => {
  /**
   * The whole point: ADR-0010 point 4 says a marker resolves only against a
   * clause a tool surfaced *this* request. Replaying old ids would have the
   * model cite them, the validator reject them, and the single corrective
   * regeneration spent undoing a problem we handed it.
   */
  it("removes clause markers", () => {
    expect(stripMarkers(`Die Probezeit beträgt sechs Monate. [[${MARKER}]]`)).toBe(
      "Die Probezeit beträgt sechs Monate.",
    );
  });

  it("removes the non-document marker kinds too", () => {
    expect(stripMarkers("Statutory maximum is six months. [[statute:§622 BGB]]")).toBe(
      "Statutory maximum is six months.",
    );
    expect(stripMarkers("Market standard is 4y/1y. [[context:market]] [[caveat]]")).toBe(
      "Market standard is 4y/1y.",
    );
  });

  it("closes the punctuation gap a mid-sentence marker leaves", () => {
    expect(stripMarkers(`Sechs Monate [[${MARKER}]], danach zwei Wochen.`)).toBe(
      "Sechs Monate, danach zwei Wochen.",
    );
  });

  it("leaves prose without markers untouched", () => {
    expect(stripMarkers("Nothing to strip here.")).toBe("Nothing to strip here.");
  });

  it("keeps paragraph breaks but collapses the gaps", () => {
    expect(stripMarkers(`One. [[${MARKER}]]\n\n\n\nTwo. [[${MARKER}]]`)).toBe("One.\n\nTwo.");
  });
});

describe("toHistoryMessages", () => {
  const turns: PriorTurn[] = [
    { question: "Wie lang ist die Probezeit?", answer: `Sechs Monate. [[${MARKER}]]` },
    { question: "Und die Kündigungsfrist?", answer: `Zwei Wochen. [[${MARKER}]]` },
  ];

  it("alternates user and assistant in the order they happened", () => {
    const messages = toHistoryMessages(turns);

    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(textOf(messages[0]!)).toBe("Wie lang ist die Probezeit?");
    expect(textOf(messages[1]!)).toBe("Sechs Monate.");
    expect(textOf(messages[3]!)).toBe("Zwei Wochen.");
  });

  it("carries no clause id into the replayed conversation", () => {
    const rendered = toHistoryMessages(turns).map(textOf).join("\n");
    expect(rendered).not.toContain("[[");
    expect(rendered).not.toContain(MARKER);
  });

  it("emits nothing but text — old tool_use ids belong to a conversation the provider lost", () => {
    for (const message of toHistoryMessages(turns)) {
      expect(message.content.every((b) => b.type === "text")).toBe(true);
    }
  });

  it("marks a truncated answer as an excerpt rather than cutting it silently", () => {
    const long = "x".repeat(MAX_HISTORY_ANSWER_CHARS + 500);
    const [, assistant] = toHistoryMessages([{ question: "q", answer: long }]);

    const text = textOf(assistant!);
    expect(text).toContain("earlier answer truncated");
    expect(text.length).toBeLessThan(long.length);
  });

  it("drops a turn whose answer was nothing but markers", () => {
    expect(toHistoryMessages([{ question: "q", answer: `[[${MARKER}]]` }])).toEqual([]);
  });

  it("returns nothing for the first question of a conversation", () => {
    expect(toHistoryMessages([])).toEqual([]);
  });
});

/**
 * Conversation memory for the Q&A loop.
 *
 * Without this, every question is answered in isolation: "and the notice
 * period?" has nothing to attach "and" to, even though the UI renders a
 * transcript that implies otherwise.
 *
 * **History is read from `qa_turns`, never accepted from the client.** The
 * client already holds a transcript, and taking it over the wire would be
 * cheaper — but it would also let a request assert what the assistant
 * previously said, which is a free hand at steering the model through text it
 * did not write. The server wrote those rows; the server can read them back.
 *
 * **Markers are stripped from prior answers.** ADR-0010 point 4 is that a
 * `[[clause_id]]` resolves only if a tool surfaced that clause *in the same
 * request*. Replaying old answers verbatim would put ids in front of the model
 * that are not citable this time round; it would copy them, the validator would
 * reject them, and the one corrective regeneration would be spent undoing a
 * problem we handed it. Stripping keeps the prose and drops the claim.
 */
import { and, desc, eq } from "drizzle-orm";

import { type Db } from "../db/client.js";
import { qaTurns } from "../db/schema/index.js";
import { type LlmMessage } from "../providers/index.js";
import { MARKER_RE } from "./grounding.js";

/**
 * Six exchanges. Enough for "and the notice period?" to reach back through a
 * couple of follow-ups, and bounded because every one of them is re-sent - and
 * re-billed - on each subsequent question.
 */
export const MAX_HISTORY_TURNS = 6;

/** Long enough to carry the substance of an answer, short enough to bound the bill. */
export const MAX_HISTORY_ANSWER_CHARS = 1_200;

export interface PriorTurn {
  question: string;
  answer: string;
}

/**
 * Drops `[[...]]` markers and tidies the punctuation they leave behind, so a
 * replayed answer reads as prose rather than as a citation-shaped hole.
 */
export function stripMarkers(text: string): string {
  return (
    text
      .replace(MARKER_RE, "")
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+([.,;:!?)\]])/gu, "$1")
      // A marker at the end of a line leaves the space that preceded it.
      .replace(/[ \t]+$/gmu, "")
      .replace(/\n{3,}/gu, "\n\n")
      .trim()
  );
}

function truncate(answer: string): string {
  if (answer.length <= MAX_HISTORY_ANSWER_CHARS) return answer;
  // Marked rather than silently cut, so the model treats it as an excerpt of
  // what it said and not as the whole of it.
  return `${answer.slice(0, MAX_HISTORY_ANSWER_CHARS).trimEnd()}… [earlier answer truncated]`;
}

/**
 * Prior exchanges as plain user/assistant text, oldest first.
 *
 * Text only: the tool calls of an earlier request are not replayed, because
 * their `tool_use` ids belong to a conversation the provider no longer has, and
 * the clauses they surfaced are not citable now in any case.
 */
export function toHistoryMessages(turns: readonly PriorTurn[]): LlmMessage[] {
  return turns.flatMap((turn): LlmMessage[] => {
    const answer = truncate(stripMarkers(turn.answer));
    if (answer === "") return [];
    return [
      { role: "user", content: [{ type: "text", text: turn.question }] },
      { role: "assistant", content: [{ type: "text", text: answer }] },
    ];
  });
}

/**
 * The case's recent Q&A exchanges, oldest first.
 *
 * `kind = "ask"` only: a narrative report is an agent-written generation in the
 * same table, but it is not something the reader said, and replaying it as a
 * conversational turn would put a whole report in the model's mouth.
 */
export async function loadConversation(
  db: Db,
  params: { caseId: string; tenantId: string; limit?: number },
): Promise<PriorTurn[]> {
  const rows = await db
    .select({ question: qaTurns.question, answer: qaTurns.answer })
    .from(qaTurns)
    .where(
      and(
        eq(qaTurns.caseId, params.caseId),
        eq(qaTurns.tenantId, params.tenantId),
        eq(qaTurns.kind, "ask"),
      ),
    )
    // Newest first so the LIMIT keeps the *recent* turns, then reversed: the
    // model needs them in the order they happened.
    .orderBy(desc(qaTurns.createdAt))
    .limit(params.limit ?? MAX_HISTORY_TURNS);

  return rows.reverse();
}

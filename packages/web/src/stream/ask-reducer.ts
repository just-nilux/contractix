import { type AgentStreamEvent, type AskResponse } from "@contractix/shared/schemas";

/**
 * The chat transcript's state machine.
 *
 * **The one thing to know: `ask` has no `restart`.** The agent disables
 * streaming on its corrective turn, so after a `retry` frame no further tokens
 * arrive - the corrected answer comes only inside `done`. The narrative stream
 * is the opposite: its regeneration *is* streamed, which is why that reducer
 * clears its buffer on `restart` and this one has nothing to clear on.
 *
 * So `retry` keeps the streamed text and marks the turn `correcting`, and
 * `done` replaces it outright. A reducer that appended `done.answer` would show
 * the rejected draft glued to the corrected one, with nothing on screen saying
 * which half was which.
 */
export interface ToolActivity {
  name: string;
  input: unknown;
  /** Null while the call is still running. */
  ok: boolean | null;
  clauseCount: number | null;
}

export interface AskTurn {
  id: string;
  question: string;
  status: "streaming" | "correcting" | "done" | "error";
  /** Answer so far; authoritative only once `status` is "done". */
  answer: string;
  activity: ToolActivity[];
  /** Why the grounding validator rejected the first answer, if it did. */
  retryReason: string | null;
  result: AskResponse | null;
  error: string | null;
}

export interface AskState {
  turns: AskTurn[];
}

export const initialAskState: AskState = { turns: [] };

/**
 * Client-side events. A turn can begin and end without the server ever having
 * streamed anything - the composer opens it, and a 429 or the Stop button can
 * close it - so these are actions the wire does not carry.
 */
export type AskClientEvent =
  | { type: "asked"; id: string; question: string }
  /** The request never ran (a 429 before the stream opened): leave no trace of it. */
  | { type: "dropped" }
  /** The reader stopped it mid-answer. */
  | { type: "cancelled" };

export type AskAction = AgentStreamEvent | AskClientEvent;

function newTurn(id: string, question: string): AskTurn {
  return {
    id,
    question,
    status: "streaming",
    answer: "",
    activity: [],
    retryReason: null,
    result: null,
    error: null,
  };
}

/** Applies `patch` to the turn in flight; a no-op when none is. */
function updateLast(state: AskState, patch: (turn: AskTurn) => AskTurn): AskState {
  if (state.turns.length === 0) return state;
  const turns = state.turns.slice();
  turns[turns.length - 1] = patch(turns[turns.length - 1]!);
  return { turns };
}

export function askReducer(state: AskState, action: AskAction): AskState {
  switch (action.type) {
    case "asked":
      return { turns: [...state.turns, newTurn(action.id, action.question)] };

    case "dropped":
      return { turns: state.turns.slice(0, -1) };

    case "cancelled":
      // Discard the partial answer for the same reason `error` does: its
      // citations were never validated.
      return updateLast(state, (t) =>
        t.status === "done"
          ? t
          : { ...t, status: "error", answer: "", error: "You stopped this answer." },
      );

    case "token":
      return updateLast(state, (t) => ({ ...t, answer: t.answer + action.text }));

    case "tool_call":
      return updateLast(state, (t) => ({
        ...t,
        activity: [
          ...t.activity,
          { name: action.name, input: action.input, ok: null, clauseCount: null },
        ],
      }));

    case "tool_result":
      return updateLast(state, (t) => {
        // Close the *oldest* open call of that name: the model may issue
        // several in one turn, and the route emits their results in the order
        // the loop executed them.
        const i = t.activity.findIndex((a) => a.name === action.name && a.ok === null);
        if (i === -1) return t;
        const activity = t.activity.slice();
        activity[i] = { ...activity[i]!, ok: action.ok, clauseCount: action.clauseCount };
        return { ...t, activity };
      });

    case "retry":
      // Keep `answer`: see the note above - there is no `restart` coming, and
      // the corrected text arrives whole inside `done`.
      return updateLast(state, (t) => ({
        ...t,
        status: "correcting",
        retryReason: action.reason,
      }));

    case "done": {
      const { type: _type, ...response } = action;
      return updateLast(state, (t) => ({
        ...t,
        status: "done",
        answer: response.answer,
        result: response,
        error: null,
      }));
    }

    case "error":
      // Discard the partial answer, keep the question. A half-answer whose
      // citations were never validated is worse than none.
      return updateLast(state, (t) => ({
        ...t,
        status: "error",
        answer: "",
        error: action.message,
      }));
  }
}

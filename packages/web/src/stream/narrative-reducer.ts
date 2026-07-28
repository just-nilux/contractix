import { type Narrative, type NarrativeStreamEvent } from "@contractix/shared/schemas";

/**
 * The narrative stream's state machine.
 *
 * Pure and separate from the hook because `restart` is easy to get quietly
 * wrong: unlike `ask`, the corrective regeneration is *streamed*, so a client
 * that only appends ends up showing the rejected draft and the corrected one
 * concatenated - which reads as a single confused report rather than as a
 * correction. `restart` means discard.
 *
 * `done` replaces the buffer outright rather than trusting what accumulated.
 * The route's own documentation says so, and it is the only way to be sure the
 * text on screen is the text whose citations were validated.
 */
export interface NarrativeState {
  status: "idle" | "streaming" | "correcting" | "done" | "error";
  /** Markdown so far; authoritative only once `status` is "done". */
  markdown: string;
  /** Why the grounding validator rejected a draft, if it did. */
  retryReason: string | null;
  corrected: boolean;
  result: Narrative | null;
  error: string | null;
}

export const initialNarrativeState: NarrativeState = {
  status: "idle",
  markdown: "",
  retryReason: null,
  corrected: false,
  result: null,
  error: null,
};

export function narrativeReducer(
  state: NarrativeState,
  event: NarrativeStreamEvent,
): NarrativeState {
  switch (event.type) {
    case "token":
      return { ...state, status: "streaming", markdown: state.markdown + event.text };

    case "retry":
      // The draft was rejected; the corrected one is about to stream.
      return { ...state, status: "correcting", retryReason: event.reason };

    case "restart":
      return { ...state, status: "streaming", markdown: "", corrected: true };

    case "done": {
      const { type: _type, ...narrative } = event;
      return {
        ...state,
        status: "done",
        markdown: narrative.markdown,
        corrected: state.corrected || narrative.corrected,
        result: narrative,
        error: null,
      };
    }

    case "error":
      // Discard the partial text: a half-written report whose citations were
      // never validated is worse than no report.
      return { ...state, status: "error", markdown: "", error: event.message };
  }
}

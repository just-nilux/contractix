import { useEffect, useRef, useState } from "react";

import { DISCLAIMER } from "@contractix/shared/schemas";

import { Button } from "./ui/button.js";

const ACK_KEY = "ctx.disclaimer.ack";

/**
 * Bump when the wording changes materially - an acknowledgement is only
 * meaningful for the text that was actually shown, so a new version re-prompts.
 */
const VERSION = "1";

function alreadyAcknowledged(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === VERSION;
  } catch {
    // Private mode, or storage disabled. Prompting again is the safe failure.
    return false;
  }
}

/**
 * FR-7.6: "prominent, non-dismissable-on-first-run disclaimer".
 *
 * Non-dismissable is taken literally - there is no close button, `Escape` is
 * cancelled, and the backdrop is inert. The only exit is the acknowledgement,
 * because the point is that nobody reads a red-flag report about their own
 * salary without first being told it is not legal advice.
 *
 * The native `<dialog>` provides modality, the inert backdrop and focus
 * containment without a library; the one behaviour that has to be overridden is
 * its default Escape-to-close.
 *
 * The body text is the same `DISCLAIMER` the API returns on every report,
 * answer and narrative, so the promise made here and the one repeated next to
 * each output cannot drift apart.
 */
export function DisclaimerGate() {
  const [acknowledged, setAcknowledged] = useState(alreadyAcknowledged);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (acknowledged) return;
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, [acknowledged]);

  if (acknowledged) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="disclaimer-title"
      // Escape fires `cancel` before `close`; cancelling it is what makes the
      // dialog genuinely non-dismissable rather than merely lacking a button.
      onCancel={(e) => {
        e.preventDefault();
      }}
      className="m-auto max-w-lg rounded-lg p-7 backdrop:bg-slate-900/50"
    >
      <h2 id="disclaimer-title" className="text-xl font-semibold text-slate-900">
        Before you start
      </h2>

      <p className="mt-4 text-slate-700">{DISCLAIMER}</p>

      <ul className="mt-4 space-y-2 text-sm text-slate-600">
        <li>
          Contractix reports what a document says and how it compares to statutory and market norms.
          It does not tell you whether to sign.
        </li>
        <li>
          Statutory references point at public sources so you can check them. They are not a
          determination about your situation.
        </li>
        <li>
          For a decision that matters, take the cited clauses to a qualified lawyer or tax adviser.
        </li>
      </ul>

      {/* No autoFocus: `showModal()` already moves focus into the dialog and
          onto its first focusable element, which is this button. */}
      <Button
        className="mt-7 w-full"
        onClick={() => {
          try {
            localStorage.setItem(ACK_KEY, VERSION);
          } catch {
            // Storage refused; the acknowledgement still holds for this visit.
          }
          setAcknowledged(true);
        }}
      >
        I understand
      </Button>
    </dialog>
  );
}

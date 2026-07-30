import { type ReactNode } from "react";

import { useCitations } from "./citation-context.js";
import { type CitationTarget } from "./types.js";

/**
 * The one control that opens a clause in the viewer.
 *
 * Four surfaces cite clauses - the report, the narrative, search, and the trace
 * drawer - and each had, or was about to have, its own button writing out the
 * same `open({documentId, clauseId, page, charStart, charEnd, verbatimAnchor})`
 * literal.
 *
 * Behaviour only: the label and the styling are the caller's, because a
 * full-width search result and an inline `p2` chip genuinely do not look alike,
 * and a shared base class would only be something they each had to override.
 */
export function ClauseLink({
  target,
  title,
  className,
  children,
}: {
  target: CitationTarget;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const { open } = useCitations();

  return (
    <button
      type="button"
      {...(title === undefined ? {} : { title })}
      {...(className === undefined ? {} : { className })}
      onClick={() => {
        open(target);
      }}
    >
      {children}
    </button>
  );
}

import { createContext, type PropsWithChildren, useContext, useMemo, useState } from "react";

import { type CitationTarget } from "./types.js";

interface CitationContextValue {
  target: CitationTarget | null;
  open: (target: CitationTarget) => void;
  close: () => void;
}

const CitationContext = createContext<CitationContextValue | null>(null);

/**
 * Which citation the viewer is showing.
 *
 * Context rather than a prop chain because a citation chip can appear anywhere -
 * a flag card, a terms-table row, a narrative sentence, a search hit - and all
 * of them open the same viewer. One target at a time, because the viewer shows
 * one document at a time.
 */
export function CitationProvider({ children }: PropsWithChildren) {
  const [target, setTarget] = useState<CitationTarget | null>(null);

  const value = useMemo<CitationContextValue>(
    () => ({
      target,
      open: setTarget,
      close: () => {
        setTarget(null);
      },
    }),
    [target],
  );

  return <CitationContext.Provider value={value}>{children}</CitationContext.Provider>;
}

export function useCitations(): CitationContextValue {
  const value = useContext(CitationContext);
  if (!value) throw new Error("useCitations must be used inside a CitationProvider");
  return value;
}

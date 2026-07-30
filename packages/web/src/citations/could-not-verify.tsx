/**
 * FR-5.2: assertions the grounding validator could not tie to a retrieved
 * clause are surfaced, never quietly dropped. An unverifiable claim the reader
 * can see is safer than one silently removed.
 *
 * Shared by the narrative report and the chat panel because the contract is the
 * same on both paths - and a second copy of it would be free to drift into
 * hiding what this exists to show.
 */
export function CouldNotVerify({ claims }: { claims: readonly string[] }) {
  if (claims.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-severity-amber-border bg-severity-amber-surface p-4">
      <h3 className="text-sm font-medium text-severity-amber">
        Claims that could not be tied to a clause
      </h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
        {claims.map((claim, i) => (
          // Indexed: the model can and does repeat a sentence, and a duplicate
          // key would drop the repeat rather than show it.
          <li key={`${String(i)}:${claim}`}>{claim}</li>
        ))}
      </ul>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { searchCase } from "../../api/endpoints.js";
import { useCitations } from "../../citations/citation-context.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";

/**
 * Hybrid clause search over the case.
 *
 * Worth its own surface for two reasons. It answers "where does the contract
 * actually say that?" without spending a model call, which is the question a
 * reader asks constantly while working through a report. And every hit carries
 * `charStart`/`charEnd` from the same frozen offsets a citation does, so it
 * opens the viewer through the identical path - which makes it the one citation
 * entry point that works even when a document was classified as `other` and has
 * no extracted terms or fired rules to cite.
 */
export function CaseSearch({ caseId }: { caseId: string }) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const { open } = useCitations();

  const { data, isFetching } = useQuery({
    queryKey: ["case", caseId, "search", query],
    queryFn: ({ signal }) => searchCase(caseId, query, { topK: 8 }, { signal }),
    enabled: query.length > 0,
    staleTime: 5 * 60_000,
  });

  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold tracking-tight text-slate-900">Search the clauses</h2>
      <p className="mt-1 text-sm text-slate-500">
        Vector, full-text and trigram search fused together. Every hit opens at the clause it came
        from.
      </p>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Search this case
        </label>
        <input
          id={inputId}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          placeholder="Kündigungsfrist, vesting cliff, liquidation preference…"
          className="min-w-0 flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <Button type="submit" disabled={draft.trim().length === 0}>
          Search
        </Button>
      </form>

      {isFetching && (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-slate-500">
          <Spinner /> Searching…
        </p>
      )}

      {data && !isFetching && (
        <ul className="mt-4 space-y-2">
          {data.results.length === 0 && (
            <li className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
              Nothing matched “{data.query}” in this case.
            </li>
          )}
          {data.results.map((hit) => (
            <li key={hit.chunkId}>
              <button
                type="button"
                onClick={() => {
                  open({
                    documentId: hit.documentId,
                    clauseId: hit.clauseId,
                    page: hit.page,
                    charStart: hit.charStart,
                    charEnd: hit.charEnd,
                    verbatimAnchor: null,
                  });
                }}
                className="w-full rounded-lg border border-slate-200 px-4 py-3 text-left hover:border-slate-400 hover:bg-slate-50"
              >
                <span className="flex items-baseline justify-between gap-4">
                  <span className="truncate text-sm font-medium text-slate-900">
                    {hit.heading ?? hit.clausePath}
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {hit.clauseRef} · page {hit.page}
                  </span>
                </span>
                <span className="mt-1 block line-clamp-2 text-sm text-slate-600">
                  {hit.snippet}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

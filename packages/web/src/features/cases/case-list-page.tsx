import { useState } from "react";
import { Link } from "react-router";

import { useCases } from "../../api/queries.js";
import { Button } from "../../components/ui/button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { DeleteCaseDialog } from "./delete-case-dialog.js";

/** PRD §9 flow 4: the case list, with the hard delete it promises. */
export function CaseListPage() {
  const { data, isPending } = useCases();
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  if (isPending) {
    return (
      <p role="status" className="flex items-center gap-2 py-16 text-slate-500">
        <Spinner /> Loading your cases…
      </p>
    );
  }

  const cases = data?.cases ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Your cases</h1>

      {cases.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
          No cases in this session yet.{" "}
          <Link to="/" className="font-medium text-slate-900 underline">
            Start with the demo corpus
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {cases.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <Link to={`/cases/${c.id}`} className="min-w-0 flex-1 hover:underline">
                <span className="block truncate font-medium text-slate-900">{c.title}</span>
                <span className="text-sm text-slate-500">
                  {c.documentCount} {c.documentCount === 1 ? "document" : "documents"}
                </span>
              </Link>
              <Button
                variant="ghost"
                className="text-severity-red"
                onClick={() => {
                  setPendingDelete({ id: c.id, title: c.title });
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {pendingDelete && (
        <DeleteCaseDialog
          caseId={pendingDelete.id}
          title={pendingDelete.title}
          open
          onClose={() => {
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The entry point for PRD §9 flow 1. The demo card, the upload card and the
 * existing-cases strip land with the API client; this is the copy that frames
 * them.
 */
export function LandingPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-4xl font-semibold tracking-tight text-balance text-slate-900">
        Read the offer the way the person who drafted it did.
      </h1>
      <p className="mt-5 text-lg text-slate-600">
        Contractix extracts every material term from an employment offer, VSOP or term sheet, checks
        it against statutory and market norms, and shows you the traps — with a citation to the
        exact clause behind every claim. German and English.
      </p>
      <p className="mt-4 text-sm text-slate-500">
        Nothing is inferred. A term the document does not contain is reported as not found.
      </p>
    </div>
  );
}

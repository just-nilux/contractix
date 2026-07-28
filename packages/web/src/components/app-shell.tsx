import { Link, Outlet } from "react-router";

import { DISCLAIMER } from "@contractix/shared/schemas";

import { DisclaimerGate } from "./disclaimer-gate.js";

/**
 * Header, routed content, and the persistent half of FR-7.6.
 *
 * The disclaimer band renders the same `DISCLAIMER` string the API returns on
 * every report, answer and narrative, imported from the shared schemas rather
 * than retyped here - a disclaimer that drifts between the chrome and the
 * output is worse than one that only appears once. The blocking first-run gate
 * is the other half and mounts above `Outlet`.
 */
export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900">
      {/* Above everything: FR-7.6 wants this seen before any analysis is. */}
      <DisclaimerGate />

      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            Contractix
          </Link>
          <nav className="text-sm">
            <Link to="/cases" className="text-slate-600 hover:text-slate-900">
              Your cases
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-slate-50">
        <p className="mx-auto max-w-6xl px-6 py-4 text-xs text-slate-500">{DISCLAIMER}</p>
      </footer>
    </div>
  );
}

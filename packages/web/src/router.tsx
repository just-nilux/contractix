import { createBrowserRouter } from "react-router";

import { AppShell } from "./components/app-shell.js";
import { RouteErrorBoundary } from "./components/error-boundary.js";
import { NotFound } from "./components/states/not-found.js";
import { CaseListPage } from "./features/cases/case-list-page.js";
import { CasePage } from "./features/cases/case-page.js";
import { LandingPage } from "./features/landing/landing-page.js";

/**
 * Library mode, no loaders: data is React Query's job, so routes only decide
 * what renders. Routes are added as their screens land rather than stubbed
 * ahead of time - a route that resolves to "coming soon" is a worse answer than
 * a 404.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <LandingPage /> },
      { path: "cases", element: <CaseListPage /> },
      { path: "cases/:caseId", element: <CasePage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

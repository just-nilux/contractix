import { OpenAPIHono } from "@hono/zod-openapi";

import { type AppDeps } from "./deps.js";
import { caseRoutes } from "./routes/cases.js";
import { clauseRoutes } from "./routes/clauses.js";
import { documentRoutes } from "./routes/documents.js";
import { healthz } from "./routes/healthz.js";
import { searchRoutes } from "./routes/search.js";

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono();

  app.route("/", healthz);
  app.route("/", caseRoutes(deps));
  app.route("/", documentRoutes(deps));
  app.route("/", searchRoutes(deps));
  app.route("/", clauseRoutes(deps));

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Contractix API",
      version: "0.0.0",
      description:
        "Term-sheet & employment-offer diligence with clause-level citations. " +
        "Informational analysis, not legal advice.",
    },
  });

  return app;
}

import { OpenAPIHono } from "@hono/zod-openapi";

import { healthz } from "./routes/healthz.js";

export function createApp() {
  const app = new OpenAPIHono();

  app.route("/", healthz);

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

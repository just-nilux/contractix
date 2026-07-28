import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";

import { type AppEnv, sessionMiddleware } from "./auth/middleware.js";
import { rateLimit } from "./auth/rate-limit.js";
import { type AppDeps } from "./deps.js";
import { logger } from "./logger.js";
import { askRoutes } from "./routes/ask.js";
import { caseRoutes } from "./routes/cases.js";
import { clauseRoutes } from "./routes/clauses.js";
import { demoRoutes } from "./routes/demo.js";
import { documentRoutes } from "./routes/documents.js";
import { fileRoutes } from "./routes/files.js";
import { healthz } from "./routes/healthz.js";
import { narrativeRoutes } from "./routes/narrative.js";
import { progressRoutes } from "./routes/progress.js";
import { reportRoutes } from "./routes/reports.js";
import { searchRoutes } from "./routes/search.js";

export function createApp(deps: AppDeps) {
  const app = new OpenAPIHono<AppEnv>();

  // FR-8 wants request/trace ids on every log line. These field names are also
  // what the Phase-4 Prometheus exporter will scrape, so keep them stable.
  app.use("*", requestId());
  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    await next();
    logger.info(
      {
        requestId: c.get("requestId"),
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        tenantId: c.get("tenantId"),
        latencyMs: Date.now() - startedAt,
      },
      "request",
    );
  });

  // Empty CORS_ORIGINS means no CORS headers at all, which is the default:
  // Caddy serves the API and the web app from one origin, and credentialed
  // cookies plus permissive CORS is the combination worth never shipping.
  if (deps.corsOrigins.length > 0) {
    app.use("*", cors({ origin: deps.corsOrigins, credentials: true }));
  }

  // Reads the session on every request; each route then declares whether it
  // requires one (`requireTenant`) or starts one (`ensureTenant`).
  app.use("*", sessionMiddleware(deps));

  // Writes carry their own tighter, per-route limits; this is the blanket
  // ceiling on reads, which are cheap but not free. `/healthz` is exempt so a
  // monitor can never be rate-limited into reporting the API as down.
  app.use(
    "*",
    rateLimit(deps, "read", {
      skip: (c) => c.req.method !== "GET" || c.req.path === "/healthz",
    }),
  );

  app.route("/", healthz);
  app.route("/", caseRoutes(deps));
  app.route("/", demoRoutes(deps));
  app.route("/", documentRoutes(deps));
  app.route("/", fileRoutes(deps));
  app.route("/", searchRoutes(deps));
  app.route("/", clauseRoutes(deps));
  app.route("/", progressRoutes(deps));
  app.route("/", reportRoutes(deps));
  app.route("/", narrativeRoutes(deps));
  app.route("/", askRoutes(deps));

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

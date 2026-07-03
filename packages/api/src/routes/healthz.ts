import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const route = createRoute({
  method: "get",
  path: "/healthz",
  summary: "Liveness probe",
  responses: {
    200: {
      description: "Service is up",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok") }),
        },
      },
    },
  },
});

export const healthz = new OpenAPIHono().openapi(route, (c) =>
  c.json({ status: "ok" as const }, 200),
);

import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { assertEmbeddingDims } from "./db/assert.js";
import { buildAppDeps } from "./deps.js";
import { logger } from "./logger.js";

const deps = await buildAppDeps();
await assertEmbeddingDims(deps.db);
const app = createApp(deps);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "contractix api listening");
});

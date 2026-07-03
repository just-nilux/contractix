import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./logger.js";

const app = createApp();

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "contractix api listening");
});

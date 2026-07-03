import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { env } from "../config/env.js";
import * as schema from "./schema/index.js";

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle({ client: pool, schema, casing: "snake_case" });

export type Db = typeof db;

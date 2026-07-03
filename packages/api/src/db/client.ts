import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { env } from "../config/env.js";
import * as schema from "./schema/index.js";

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle({ client: pool, schema, casing: "snake_case" });

export type Db = typeof db;

/** Standalone factory (eval runner, one-off scripts) - caller owns the pool. */
export function createDb(connectionString: string): { db: Db; pool: pg.Pool } {
  const p = new pg.Pool({ connectionString });
  return { db: drizzle({ client: p, schema, casing: "snake_case" }), pool: p };
}

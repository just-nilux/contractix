import { sql } from "drizzle-orm";

import { loadModelsConfig } from "@contractix/shared";

import { type Db } from "./client.js";
import { EMBEDDING_DIMS } from "./schema/chunks.js";

/**
 * ADR-0004: the vector column's dimension is DDL-frozen. Refuse to boot when
 * models.yaml, the compiled schema constant, and the live database disagree -
 * a silent mismatch would corrupt every similarity score.
 */
export async function assertEmbeddingDims(db: Db): Promise<void> {
  const cfg = loadModelsConfig();
  if (cfg.embeddings.dimensions !== EMBEDDING_DIMS) {
    throw new Error(
      `models.yaml dimensions (${cfg.embeddings.dimensions}) != schema EMBEDDING_DIMS (${EMBEDDING_DIMS})`,
    );
  }
  const res = await db.execute(
    sql`SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
  );
  const row = res.rows[0] as { dims?: number } | undefined;
  if (row?.dims !== EMBEDDING_DIMS) {
    throw new Error(
      `database chunks.embedding has ${row?.dims ?? "unknown"} dims, expected ${EMBEDDING_DIMS}`,
    );
  }
}

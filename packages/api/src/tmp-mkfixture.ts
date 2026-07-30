/** Throwaway: builds a real layout fixture from the seeded corpus. */
import { readFile, writeFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { type Block } from "@contractix/shared";

import { db } from "./db/client.js";
import { clauses, documents } from "./db/schema/index.js";

const rows = await db.select().from(documents);
const doc = rows.find((d) => d.filename === "offer_de_senior_eng.pdf");
if (!doc) throw new Error("not seeded");

const sidecar = JSON.parse(
  await readFile(`./data/files/${doc.sha256}.blocks.json`, "utf8"),
) as Block[];

const pages = (doc.parseReport?.pages ?? []).flatMap((p) =>
  p.width && p.height ? [{ page: p.page, width: p.width, height: p.height }] : [],
);
const blocks = sidecar.flatMap((b) =>
  b.bbox
    ? [
        {
          page: b.page,
          x: b.bbox.x,
          y: b.bbox.y,
          width: b.bbox.width,
          height: b.bbox.height,
          charStart: b.charStart,
          charEnd: b.charEnd,
        },
      ]
    : [],
);

const cls = await db.select().from(clauses).where(eq(clauses.documentId, doc.id));
console.log("pages", JSON.stringify(pages));
console.log("blocks", blocks.length, "clauses", cls.length);
console.log("first 3 blocks", JSON.stringify(blocks.slice(0, 3)));
console.log(
  "clauses",
  JSON.stringify(
    cls.map((c) => ({ ref: c.clauseRef, page: c.page, s: c.charStart, e: c.charEnd })),
  ),
);

await writeFile(
  "../web/src/test/fixtures/layout-offer-de.json",
  JSON.stringify(
    {
      documentId: doc.id,
      mimeType: doc.mimeType,
      pageCount: doc.pageCount,
      geometry: true,
      pages,
      blocks,
    },
    null,
    1,
  ) + "\n",
);
process.exit(0);

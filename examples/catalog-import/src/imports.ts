import { RunStateError } from "@durlo/core";
import { config } from "./config.js";
import { adapter, catalogImportWorkflow, durlo } from "./durlo.js";
import type { CatalogImportRequest } from "./input.js";

type ImportRow = {
  id: string;
  run_id: string;
  content_hash: string;
  status: string;
  row_count: number;
  published_count: number;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
};

export async function enqueueImport(request: CatalogImportRequest, contentHash: string) {
  return durlo.transaction(async (transaction) => {
    const inserted = await transaction.client.query(
      `insert into catalog_imports (id, content_hash, status, row_count)
       values ($1, $2, 'queued', $3)
       on conflict (id) do nothing`,
      [request.importId, contentHash, request.rows.length]
    );

    if (inserted.rowCount === 1) {
      await transaction.client.query(
        `insert into catalog_import_rows (import_id, row_number, sku, name, price_cents)
         select $1, (entry.ordinality - 1)::integer,
                entry.value->>'sku', entry.value->>'name',
                (entry.value->>'priceCents')::integer
         from jsonb_array_elements($2::jsonb) with ordinality as entry(value, ordinality)`,
        [request.importId, JSON.stringify(request.rows)]
      );
    } else {
      const matching = await transaction.client.query(
        "select 1 from catalog_imports where id = $1 and content_hash = $2",
        [request.importId, contentHash]
      );
      if (matching.rowCount !== 1) {
        throw new RunStateError(`importId '${request.importId}' already has different rows`);
      }
    }

    const handle = await transaction.start(
      catalogImportWorkflow,
      { importId: request.importId, publicationDelayMs: config.publicationDelayMs },
      { idempotencyKey: `catalog:${request.importId}` }
    );
    const linked = await transaction.client.query(
      `update catalog_imports
       set run_id = coalesce(run_id, $2), updated_at = now()
       where id = $1 and (run_id is null or run_id = $2)`,
      [request.importId, handle.run.id]
    );
    if (linked.rowCount !== 1) {
      throw new Error(
        `catalog import '${request.importId}' could not be linked to run '${handle.run.id}'`
      );
    }
    return handle;
  });
}

export async function getImport(importId: string) {
  const result = await adapter.pool.query<ImportRow>(
    `select id, run_id, content_hash, status, row_count, published_count,
            created_at, updated_at, published_at
     from catalog_imports where id = $1`,
    [importId]
  );
  const catalogImport = result.rows[0];
  if (!catalogImport) return null;
  const run = await durlo.runs.getDetails(catalogImport.run_id);
  return { import: catalogImport, run };
}

export async function cancelImport(importId: string) {
  const current = await getImport(importId);
  if (!current) return null;
  const run = await durlo.runs.cancel(current.import.run_id);
  await adapter.pool.query(
    `update catalog_imports set status = 'cancelled', updated_at = now()
     where id = $1 and status <> 'published'`,
    [importId]
  );
  return run;
}

export async function retryImport(importId: string) {
  const current = await getImport(importId);
  if (!current) return null;
  const run = await durlo.runs.retry(current.import.run_id);
  await adapter.pool.query(
    `update catalog_imports set status = 'queued', updated_at = now()
     where id = $1 and status <> 'published'`,
    [importId]
  );
  return run;
}

export async function listProducts(limit: number) {
  const result = await adapter.pool.query(
    `select sku, name, price_cents, source_import_id, updated_at
     from catalog_products order by sku limit $1`,
    [limit]
  );
  return result.rows;
}

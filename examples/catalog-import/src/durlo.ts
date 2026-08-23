import { Durlo, PermanentError } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import { config } from "./config.js";
import { catalogWorkflowSchema } from "./input.js";

export const adapter = postgresAdapter({ connectionString: config.databaseUrl });
export const durlo = new Durlo({ id: "catalog-import", adapter });

export const catalogImportWorkflow = durlo.workflow({
  id: "import-catalog",
  version: config.workflowVersion,
  schema: catalogWorkflowSchema,
  retry: {
    attempts: 4,
    backoff: { type: "exponential", delay: "1s", factor: 2, maxDelay: "30s", jitter: 0.2 }
  },
  timeout: "1m",
  run: async ({ input, run, step }) => {
    const validated = await step.run("validate-source", async () => {
      const result = await adapter.pool.query<{ row_count: number }>(
        `update catalog_imports i
         set status = 'validating', updated_at = now()
         where i.id = $1
         returning (select count(*)::integer from catalog_import_rows r where r.import_id = i.id) as row_count`,
        [input.importId]
      );
      const rowCount = result.rows[0]?.row_count;
      if (!rowCount) {
        throw new PermanentError(`catalog import '${input.importId}' has no source rows`);
      }
      return { rowCount };
    });

    const prepared = await step.run("prepare-publication", async () => {
      const updated = await adapter.pool.query(
        `update catalog_imports
         set status = 'awaiting_publication', row_count = $2, updated_at = now()
         where id = $1`,
        [input.importId, validated.rowCount]
      );
      if (updated.rowCount !== 1) {
        throw new PermanentError(`catalog import '${input.importId}' was not found`);
      }
      return { productCount: validated.rowCount };
    });

    if (process.env.DURLO_EXAMPLE_PAUSE_AFTER_PREPARE === "1") {
      process.stdout.write(
        `CRASH_READY runId=${run.id} importId=${input.importId} pid=${process.pid}\n`
      );
      await new Promise<never>(() => undefined);
    }

    await step.sleep("publication-window", input.publicationDelayMs);

    const publication = await step.run("publish-catalog", async () => {
      const client = await adapter.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into catalog_products (
             sku, name, price_cents, source_import_id, source_import_created_at, updated_at
           )
           select r.sku, r.name, r.price_cents, i.id, i.created_at, now()
           from catalog_import_rows r
           join catalog_imports i on i.id = r.import_id
           where r.import_id = $1
           on conflict (sku) do update
             set name = excluded.name,
                 price_cents = excluded.price_cents,
                 source_import_id = excluded.source_import_id,
                 source_import_created_at = excluded.source_import_created_at,
                 updated_at = now()
           where (catalog_products.source_import_created_at, catalog_products.source_import_id)
              <= (excluded.source_import_created_at, excluded.source_import_id)`,
          [input.importId]
        );
        await client.query(
          `insert into catalog_publications (import_id, run_id, product_count)
           values ($1, $2, $3)
           on conflict (import_id) do nothing`,
          [input.importId, run.id, prepared.productCount]
        );
        const published = await client.query<{ published_at: Date }>(
          `select published_at from catalog_publications where import_id = $1`,
          [input.importId]
        );
        const publishedAt = published.rows[0]?.published_at;
        if (!publishedAt) throw new Error(`catalog import '${input.importId}' was not published`);
        await client.query(
          `update catalog_imports
           set status = 'published', published_count = $2, published_at = $3, updated_at = now()
           where id = $1`,
          [input.importId, prepared.productCount, publishedAt]
        );
        await client.query("commit");
        return { productCount: prepared.productCount, publishedAt: publishedAt.toISOString() };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    });

    return { importId: input.importId, ...publication };
  }
});

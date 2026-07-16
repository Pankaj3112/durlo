import { adapter } from "./durlo.js";

try {
  await adapter.migrate();
  await adapter.pool.query(`
    create table if not exists catalog_imports (
      id text primary key,
      run_id text unique,
      content_hash text not null,
      status text not null check (
        status in ('queued', 'validating', 'awaiting_publication', 'published', 'cancelled')
      ),
      row_count integer not null check (row_count > 0),
      published_count integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      published_at timestamptz
    );

    create table if not exists catalog_import_rows (
      import_id text not null references catalog_imports(id) on delete cascade,
      row_number integer not null,
      sku text not null,
      name text not null,
      price_cents integer not null check (price_cents >= 0),
      primary key (import_id, row_number),
      unique (import_id, sku)
    );

    create table if not exists catalog_products (
      sku text primary key,
      name text not null,
      price_cents integer not null check (price_cents >= 0),
      source_import_id text not null references catalog_imports(id),
      source_import_created_at timestamptz not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists catalog_publications (
      import_id text primary key references catalog_imports(id),
      run_id text not null,
      product_count integer not null,
      published_at timestamptz not null default now()
    );
  `);
  process.stdout.write("catalog import migrations applied\n");
} finally {
  await adapter.close();
}

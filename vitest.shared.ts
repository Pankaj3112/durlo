import { fileURLToPath } from "node:url";

const sourceAlias = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export const sharedVitestConfig = {
  root: sourceAlias("."),
  resolve: {
    alias: {
      "@durlo/core": sourceAlias("./packages/core/src/index.ts"),
      "@durlo/postgres": sourceAlias(
        process.env.DURLO_POSTGRES_TEST_ENTRY ?? "./packages/postgres/src/index.ts"
      ),
      durlo: sourceAlias("./packages/cli/src/index.ts")
    }
  },
  test: {
    environment: "node" as const
  }
};

export function requireTestDatabase(): void {
  if (process.env.DURLO_TEST_DATABASE_URL) return;
  throw new Error(
    "DURLO_TEST_DATABASE_URL is required for Postgres integration tests. " +
      "Run 'pnpm test:local' to use a disposable Postgres container."
  );
}

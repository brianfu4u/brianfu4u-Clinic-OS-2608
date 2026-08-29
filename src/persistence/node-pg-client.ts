import { applyMigrations, loadRepositoryMigrations } from "./migration-runner.ts";
import { createNodePgPool } from "./node-pg-pool.ts";

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL): Promise<string[]> {
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const pool = createNodePgPool(databaseUrl);
  let client;
  try {
    client = await pool.connect();
    return await applyMigrations(client, await loadRepositoryMigrations());
  } finally {
    client?.release();
    await pool.close().catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrateDatabase()
    .then((applied) => console.log(JSON.stringify({ applied, count: applied.length })))
    .catch((error: unknown) => {
      const code = error instanceof Error && error.message === "DATABASE_URL_REQUIRED"
        ? "DATABASE_URL_REQUIRED"
        : "MIGRATION_FAILED";
      console.error(code);
      process.exitCode = 1;
    });
}

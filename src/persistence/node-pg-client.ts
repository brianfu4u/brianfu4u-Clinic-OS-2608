import type { SqlClient } from "./migration-runner.ts";
import { applyMigrations, loadRepositoryMigrations } from "./migration-runner.ts";

export async function withTenantTransaction<T>(
  client: SqlClient,
  clinicId: string,
  work: (client: SqlClient) => Promise<T>,
): Promise<T> {
  if (!clinicId.trim()) throw new Error("CLINIC_ID_REQUIRED");
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL): Promise<string[]> {
  if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    return await applyMigrations(client, await loadRepositoryMigrations());
  } finally {
    await client.end().catch(() => undefined);
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

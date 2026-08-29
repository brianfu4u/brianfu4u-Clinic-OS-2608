import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SqlClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec?(sql: string): Promise<unknown>;
}

export interface Migration {
  id: string;
  sql: string;
}

const MIGRATION_ID = /^\d{4}_[a-z0-9_]+$/;
const MIGRATION_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export class MigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
  }
}

export async function loadRepositoryMigrations(): Promise<Migration[]> {
  const filenames = (await readdir(MIGRATION_DIRECTORY))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  return Promise.all(filenames.map(async (filename) => ({
    id: filename.slice(0, -4),
    sql: await readFile(join(MIGRATION_DIRECTORY, filename), "utf8"),
  })));
}

export async function applyMigrations(
  client: SqlClient,
  migrations: readonly Migration[],
): Promise<string[]> {
  const ordered = validateMigrations(migrations);
  const applied: string[] = [];

  for (const migration of ordered) {
    await client.query("BEGIN");
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migration (
          id text PRIMARY KEY,
          checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const existing = await client.query(
        "SELECT checksum FROM schema_migration WHERE id = $1",
        [migration.id],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0].checksum !== checksum) {
          throw new MigrationError(
            "MIGRATION_CHECKSUM_MISMATCH",
            `Applied migration ${migration.id} has changed.`,
          );
        }
      } else {
        if (client.exec) await client.exec(migration.sql);
        else await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migration (id, checksum) VALUES ($1, $2)",
          [migration.id, checksum],
        );
        applied.push(migration.id);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return applied;
}

function validateMigrations(migrations: readonly Migration[]): Migration[] {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (!MIGRATION_ID.test(migration.id)) {
      throw new MigrationError("UNKNOWN_MIGRATION_ID", `Invalid migration ID: ${migration.id}`);
    }
    if (seen.has(migration.id)) {
      throw new MigrationError("DUPLICATE_MIGRATION_ID", `Duplicate migration ID: ${migration.id}`);
    }
    seen.add(migration.id);
  }
  return [...migrations].sort((left, right) => left.id.localeCompare(right.id));
}

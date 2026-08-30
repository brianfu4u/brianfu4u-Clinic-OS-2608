import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Pool, type PoolClient } from "pg";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";

export const BUSINESS_TABLES = [
  "artifact",
  "evidence_fact_card",
  "workflow",
  "workflow_artifact_link",
  "expectation",
  "expectation_transition",
  "s2_verification",
  "manager_decision",
] as const;

const URL_NAMES = [
  "WO018_SOURCE_ADMIN_URL",
  "WO018_SOURCE_APP_URL",
  "WO018_RESTORE_ADMIN_URL",
  "WO018_RESTORE_APP_URL",
] as const;

export class AcceptanceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AcceptanceError";
    this.code = code;
  }
}

export type AcceptanceConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment = process.env) {
  const values = URL_NAMES.map((name) => environment[name]);
  if (values.some((value) => !value)) throw new AcceptanceError("ENVIRONMENT_REQUIRED");
  let urls: URL[];
  try {
    urls = values.map((value) => new URL(value as string));
  } catch {
    throw new AcceptanceError("ENVIRONMENT_INVALID");
  }
  const [sourceAdmin, sourceApp, restoreAdmin, restoreApp] = urls;
  for (const url of urls) {
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new AcceptanceError("ENVIRONMENT_INVALID");
    }
    if (!decodeURIComponent(url.pathname.slice(1)).endsWith("_wo018_acceptance")) {
      throw new AcceptanceError("UNSAFE_DATABASE_NAME");
    }
  }
  const databaseKey = (url: URL) => `${url.hostname}:${url.port || "5432"}/${url.pathname}`;
  if (databaseKey(sourceAdmin) === databaseKey(restoreAdmin)) {
    throw new AcceptanceError("DATABASES_MUST_DIFFER");
  }
  if (databaseKey(sourceAdmin) !== databaseKey(sourceApp) ||
      databaseKey(restoreAdmin) !== databaseKey(restoreApp)) {
    throw new AcceptanceError("ROLE_DATABASE_MISMATCH");
  }
  if (decodeURIComponent(sourceAdmin.username) === decodeURIComponent(sourceApp.username) ||
      decodeURIComponent(restoreAdmin.username) === decodeURIComponent(restoreApp.username)) {
    throw new AcceptanceError("ROLES_MUST_DIFFER");
  }
  return {
    sourceAdmin: sourceAdmin.toString(),
    sourceApp: sourceApp.toString(),
    restoreAdmin: restoreAdmin.toString(),
    restoreApp: restoreApp.toString(),
  };
}

export async function withClient<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '15s'");
    await client.query("SET lock_timeout = '3s'");
    return await operation(client);
  } finally {
    client.release();
  }
}

export async function assertDedicatedEmptyRestore(pool: Pool): Promise<void> {
  const result = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [BUSINESS_TABLES],
  );
  if (result.rows.length !== 0) throw new AcceptanceError("RESTORE_DATABASE_NOT_EMPTY");
}

export async function resetPublicSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

export async function migrate(pool: Pool): Promise<void> {
  await withClient(pool, async (client) => {
    await applyMigrations(client, await loadRepositoryMigrations());
  });
}

export async function assertRole(pool: Pool, expectedUser: string): Promise<void> {
  const result = await pool.query<{
    rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; owner: boolean;
  }>(`SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database()
                     AND d.datdba = r.oid) AS owner
        FROM pg_roles r WHERE r.rolname = current_user`);
  const row = result.rows[0];
  assert.equal(row?.rolname, expectedUser);
  assert.equal(row?.rolcanlogin, true);
  assert.equal(row?.rolsuper, false);
  assert.equal(row?.rolbypassrls, false);
  assert.equal(row?.owner, false);
}

export async function assertConnectedRolesDiffer(admin: Pool, app: Pool): Promise<void> {
  const [adminUser, appUser] = await Promise.all([
    admin.query<{ user: string }>("SELECT current_user AS user"),
    app.query<{ user: string }>("SELECT current_user AS user"),
  ]);
  if (adminUser.rows[0]?.user === appUser.rows[0]?.user) {
    throw new AcceptanceError("ROLES_MUST_DIFFER");
  }
}

export async function grantApplicationAccess(admin: Pool, appUrl: string): Promise<void> {
  const appRole = decodeURIComponent(new URL(appUrl).username);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(appRole)}`);
  const role = quoteIdentifier(appRole);
  await admin.query(`GRANT SELECT, INSERT ON TABLE artifact, evidence_fact_card,
    workflow_artifact_link, expectation_transition, s2_verification, manager_decision TO ${role}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE ON TABLE workflow, expectation TO ${role}`);
}

export async function assertRlsCatalog(admin: Pool): Promise<void> {
  const tables = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
    [BUSINESS_TABLES],
  );
  assert.equal(tables.rows.length, BUSINESS_TABLES.length);
  assert.ok(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  const policies = await admin.query<{ tablename: string; qual: string | null; with_check: string | null }>(
    `SELECT tablename, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [BUSINESS_TABLES],
  );
  assert.equal(policies.rows.length, BUSINESS_TABLES.length);
  assert.ok(policies.rows.every((row) =>
    row.qual?.includes("app.clinic_id") && row.with_check?.includes("app.clinic_id")));
}

export async function assertAppendOnlyTriggers(admin: Pool): Promise<void> {
  const required = [
    "artifact",
    "workflow_artifact_link",
    "expectation_transition",
    "s2_verification",
    "manager_decision",
  ];
  const result = await admin.query<{ table_name: string; trigger_name: string; enabled: string }>(
    `SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled AS enabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
        AND c.relname = ANY($1::text[])`,
    [required],
  );
  assert.equal(result.rows.length, required.length);
  assert.deepEqual(result.rows.map(({ table_name }) => table_name).sort(), required.sort());
  assert.ok(result.rows.every(({ enabled }) => enabled === "O" || enabled === "A"));
  assert.ok(result.rows.every(({ trigger_name }) => trigger_name.endsWith("_append_only")));
}

export async function assertNoTenantLeak(app: Pool): Promise<void> {
  const withoutTenant = await app.query("SELECT id FROM artifact");
  assert.equal(withoutTenant.rows.length, 0);
  await assert.rejects(app.query(
    `INSERT INTO artifact (clinic_id,id,kind,occurred_at,occurred_at_source,
      source_employee_id,identity_anchor,payload,created_at)
     VALUES ('WO018-A','WO018-forbidden','REGISTRATION',now(),'source','WO018-e',
      'WO018-p','{}',now())`,
  ));
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.clinic_id', 'WO018-A', true)");
    await client.query("COMMIT");
    assert.equal((await client.query("SELECT id FROM artifact")).rows.length, 0);
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.clinic_id', 'WO018-B', true)");
    await client.query("ROLLBACK");
    assert.equal((await client.query("SELECT id FROM artifact")).rows.length, 0);
  } finally {
    client.release();
  }
}

export async function runBinary(binary: string, args: string[], url: string): Promise<string> {
  const parsed = new URL(url);
  const env = {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.on("error", () => reject(new AcceptanceError("POSTGRES_BINARY_REQUIRED")));
    child.on("close", (code) => code === 0
      ? resolve(output)
      : reject(new AcceptanceError("POSTGRES_BINARY_FAILED")));
  });
}

export async function assertBinaries(): Promise<void> {
  for (const binary of ["pg_dump", "pg_restore"]) {
    const version = await runBinary(binary, ["--version"], "postgresql://unused:unused@localhost/unused");
    const major = Number(version.match(/(\d+)(?:\.\d+)?/)?.[1]);
    if (major !== 16 && major !== 17) throw new AcceptanceError("POSTGRES_VERSION_UNSUPPORTED");
  }
}

export async function dumpAndRestore(config: AcceptanceConfig, sourceAdmin: Pool): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clinic-os-wo018-"));
  const file = join(directory, "acceptance.dump");
  try {
    await runBinary("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", file], config.sourceAdmin);
    const { readFile } = await import("node:fs/promises");
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    await runBinary("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--dbname", decodeURIComponent(new URL(config.restoreAdmin).pathname.slice(1)), file], config.restoreAdmin);
    return digest;
  } finally {
    await rm(directory, { recursive: true, force: true });
    void sourceAdmin;
  }
}

export async function logicalDigests(pool: Pool): Promise<Map<string, { count: number; digest: string }>> {
  const output = new Map<string, { count: number; digest: string }>();
  for (const table of [...BUSINESS_TABLES, "schema_migration"] as const) {
    const result = await pool.query<{ value: unknown }>(
      `SELECT to_jsonb(t) AS value FROM ${quoteIdentifier(table)} t ORDER BY to_jsonb(t)::text`,
    );
    const logical = result.rows.map(({ value }) => JSON.stringify(value)).join("\n");
    output.set(table, {
      count: result.rows.length,
      digest: createHash("sha256").update(logical).digest("hex"),
    });
  }
  return output;
}

export function userFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

function quoteIdentifier(value: string): string {
  if (value === "" || value.includes("\0")) throw new AcceptanceError("ROLE_NAME_INVALID");
  return `"${value.replaceAll('"', '""')}"`;
}

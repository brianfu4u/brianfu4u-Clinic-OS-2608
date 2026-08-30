import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
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

export function installSignalCancellation(
  controller: AbortController,
  target: Pick<EventEmitter, "on" | "off"> = process,
) {
  let exitCode: number | null = null;
  const onInterrupt = () => { exitCode ??= 130; controller.abort(); };
  const onTerminate = () => { exitCode ??= 143; controller.abort(); };
  target.on("SIGINT", onInterrupt);
  target.on("SIGTERM", onTerminate);
  return {
    get exitCode() { return exitCode; },
    dispose() {
      target.off("SIGINT", onInterrupt);
      target.off("SIGTERM", onTerminate);
    },
  };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AcceptanceError("ACCEPTANCE_CANCELLED");
}

export type AcceptanceConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment = process.env) {
  const values = URL_NAMES.map((name) => environment[name]);
  if (values.some((value) => !value)) throw new AcceptanceError("ENVIRONMENT_REQUIRED");
  if (environment.WO018_ALLOW_DESTRUCTIVE_RESET !== "I_UNDERSTAND_WO018_DATABASES_WILL_BE_DROPPED") {
    throw new AcceptanceError("DESTRUCTIVE_CONFIRMATION_REQUIRED");
  }
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

export async function databaseIdentity(pool: Pool) {
  const result = await pool.query<{ system_identifier: string; database_oid: string; version: string }>(
    `SELECT (pg_control_system()).system_identifier::text AS system_identifier,
            (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
            current_setting('server_version_num') AS version`,
  );
  const row = result.rows[0];
  if (!row) throw new AcceptanceError("DATABASE_IDENTITY_UNAVAILABLE");
  return row;
}

async function connectedDatabase(pool: Pool) {
  const result = await pool.query<{ database_oid: string; database_name: string; version: string }>(
    `SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
            current_database() AS database_name,
            current_setting('server_version_num') AS version`,
  );
  const row = result.rows[0];
  if (!row) throw new AcceptanceError("DATABASE_IDENTITY_UNAVAILABLE");
  return row;
}

export async function assertDatabaseIdentities(
  sourceAdmin: Pool, sourceApp: Pool, restoreAdmin: Pool, restoreApp: Pool,
): Promise<{ sourceMajor: number; restoreMajor: number }> {
  const [sa, sp, ra, rp] = await Promise.all([
    databaseIdentity(sourceAdmin), connectedDatabase(sourceApp),
    databaseIdentity(restoreAdmin), connectedDatabase(restoreApp),
  ]);
  if (sa.database_oid !== sp.database_oid || ra.database_oid !== rp.database_oid ||
      sa.version !== sp.version || ra.version !== rp.version) {
    throw new AcceptanceError("ROLE_DATABASE_MISMATCH");
  }
  if (`${sa.system_identifier}:${sa.database_oid}` === `${ra.system_identifier}:${ra.database_oid}`) {
    throw new AcceptanceError("DATABASES_MUST_DIFFER");
  }
  const sourceMajor = Math.floor(Number(sa.version) / 10_000);
  const restoreMajor = Math.floor(Number(ra.version) / 10_000);
  if (![16, 17].includes(sourceMajor) || ![16, 17].includes(restoreMajor)) {
    throw new AcceptanceError("POSTGRES_VERSION_UNSUPPORTED");
  }
  if (sourceMajor !== restoreMajor) throw new AcceptanceError("POSTGRES_VERSION_MISMATCH");
  return { sourceMajor, restoreMajor };
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

export async function assertDedicatedEmptyPublic(pool: Pool): Promise<void> {
  const result = await pool.query(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')
     UNION ALL
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
     UNION ALL
     SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public' AND t.typtype IN ('e','d','r','m')
     UNION ALL
     SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
      WHERE n.nspname='public'
     LIMIT 1`,
  );
  if (result.rows.length !== 0) throw new AcceptanceError("PUBLIC_SCHEMA_NOT_EMPTY");
}

export async function resetPublicSchema(pool: Pool): Promise<void> {
  await withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
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
  const policies = await admin.query<{
    tablename: string; policyname: string; permissive: string; roles: string[]; cmd: string;
    qual: string | null; with_check: string | null;
  }>(
    `SELECT tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [BUSINESS_TABLES],
  );
  assert.equal(policies.rows.length, BUSINESS_TABLES.length);
  const expectedExpression = "(clinic_id = current_setting('app.clinic_id'::text, true))";
  for (const table of BUSINESS_TABLES) {
    assert.deepEqual(policies.rows.find((row) => row.tablename === table), {
      tablename: table,
      policyname: `${table}_clinic_scope`,
      permissive: "PERMISSIVE",
      roles: ["public"],
      cmd: "ALL",
      qual: expectedExpression,
      with_check: expectedExpression,
    });
  }
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

export async function runBinary(
  binary: string, args: string[], url: string, signal?: AbortSignal, timeoutMs = 30_000,
): Promise<string> {
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
    let settled = false;
    let forcedError: AcceptanceError | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (error?: AcceptanceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve(output);
    };
    const stop = (code: string) => {
      if (settled || forcedError) return;
      forcedError = new AcceptanceError(code);
      if (!child.kill("SIGTERM")) {
        finish(forcedError);
        return;
      }
      forceTimer = setTimeout(() => {
        if (!settled && !child.kill("SIGKILL")) finish(forcedError);
      }, 2_000);
      forceTimer.unref();
    };
    const onAbort = () => stop("POSTGRES_BINARY_ABORTED");
    const timer = setTimeout(() => stop("POSTGRES_BINARY_TIMEOUT"), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.resume();
    child.on("error", () => finish(new AcceptanceError("POSTGRES_BINARY_REQUIRED")));
    child.on("close", (code) => forcedError
      ? finish(forcedError)
      : code === 0 ? finish() : finish(new AcceptanceError("POSTGRES_BINARY_FAILED")));
    if (signal?.aborted) onAbort();
  });
}

export async function assertBinaries(
  expectedMajors?: readonly number[], signal?: AbortSignal,
): Promise<{ dump: number; restore: number }> {
  const majors: number[] = [];
  for (const binary of ["pg_dump", "pg_restore"]) {
    const version = await runBinary(binary, ["--version"], "postgresql://unused:unused@localhost/unused", signal);
    const major = Number(version.match(/(\d+)(?:\.\d+)?/)?.[1]);
    if (major !== 16 && major !== 17) throw new AcceptanceError("POSTGRES_VERSION_UNSUPPORTED");
    majors.push(major);
  }
  if (majors[0] !== majors[1] || expectedMajors?.some((major) => major !== majors[0])) {
    throw new AcceptanceError("POSTGRES_VERSION_MISMATCH");
  }
  return { dump: majors[0]!, restore: majors[1]! };
}

export async function dumpAndRestore(
  config: AcceptanceConfig, sourceAdmin: Pool, signal?: AbortSignal,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clinic-os-wo018-"));
  const file = join(directory, "acceptance.dump");
  try {
    await runBinary("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", file], config.sourceAdmin, signal, 120_000);
    const { readFile } = await import("node:fs/promises");
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    await runBinary("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--dbname", decodeURIComponent(new URL(config.restoreAdmin).pathname.slice(1)), file], config.restoreAdmin, signal, 120_000);
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

export async function catalogDigest(pool: Pool): Promise<string> {
  const result = await pool.query<{ kind: string; value: string }>(
    `SELECT 'constraint' AS kind,
            c.conrelid::regclass::text || ':' || c.conname || ':' || pg_get_constraintdef(c.oid) AS value
       FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='public'
     UNION ALL
     SELECT 'policy', schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' ||
            coalesce(qual,'') || ':' || coalesce(with_check,'')
       FROM pg_policies WHERE schemaname='public'
     UNION ALL
     SELECT 'trigger', c.relname || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid)
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
      ORDER BY kind, value`,
  );
  return createHash("sha256").update(result.rows.map((row) => `${row.kind}:${row.value}`).join("\n")).digest("hex");
}

export async function assertTenantIsolationForEveryTable(admin: Pool, app: Pool): Promise<void> {
  for (const table of BUSINESS_TABLES) {
    const counts = await admin.query<{ clinic_id: string; count: number }>(
      `SELECT clinic_id, count(*)::int AS count FROM ${quoteIdentifier(table)}
        WHERE clinic_id IN ('WO018-A','WO018-B') GROUP BY clinic_id`,
    );
    assert.ok(counts.rows.some((row) => row.clinic_id === "WO018-A" && row.count > 0), `${table}: tenant A seed`);
    assert.ok(counts.rows.some((row) => row.clinic_id === "WO018-B" && row.count > 0), `${table}: tenant B seed`);
    for (const clinicId of ["WO018-A", "WO018-B"]) {
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.clinic_id',$1,true)", [clinicId]);
        const visible = await client.query<{ clinic_id: string }>(
          `SELECT clinic_id FROM ${quoteIdentifier(table)}`,
        );
        assert.ok(visible.rows.length > 0, `${table}: ${clinicId} visible`);
        assert.ok(visible.rows.every((row) => row.clinic_id === clinicId), `${table}: tenant leak`);
        if (table === "workflow" || table === "expectation") {
          const foreignClinic = clinicId === "WO018-A" ? "WO018-B" : "WO018-A";
          await assert.rejects(client.query(
            `UPDATE ${quoteIdentifier(table)} SET clinic_id=$1 WHERE clinic_id=$2`,
            [foreignClinic, clinicId],
          ), `${table}: cross-clinic RLS write must fail`);
        }
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }
  }
}

export async function assertAppendOnlyBehavior(admin: Pool): Promise<void> {
  for (const table of [
    "artifact", "workflow_artifact_link", "expectation_transition", "s2_verification", "manager_decision",
  ]) {
    await assert.rejects(admin.query(
      `UPDATE ${quoteIdentifier(table)} SET clinic_id=clinic_id WHERE clinic_id='WO018-A'`,
    ), `${table}: UPDATE must fail`);
    await assert.rejects(admin.query(
      `DELETE FROM ${quoteIdentifier(table)} WHERE clinic_id='WO018-A'`,
    ), `${table}: DELETE must fail`);
  }
}

export function userFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).username);
}

function quoteIdentifier(value: string): string {
  if (value === "" || value.includes("\0")) throw new AcceptanceError("ROLE_NAME_INVALID");
  return `"${value.replaceAll('"', '""')}"`;
}

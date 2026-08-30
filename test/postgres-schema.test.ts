import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  applyMigrations,
  isRepositorySchemaCompatible,
  loadRepositoryMigrations,
  MigrationError,
} from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

const migrations = await loadRepositoryMigrations();
const migrationSql = await readFile(
  new URL("../src/persistence/migrations/0001_trusted_core.sql", import.meta.url),
  "utf8",
) + await readFile(
  new URL("../src/persistence/migrations/0002_expectation_transition.sql", import.meta.url),
  "utf8",
) + await readFile(
  new URL("../src/persistence/migrations/0003_expectation_reevaluation.sql", import.meta.url),
  "utf8",
) + await readFile(
  new URL("../src/persistence/migrations/0004_s2_verification.sql", import.meta.url),
  "utf8",
) + await readFile(
  new URL("../src/persistence/migrations/0005_manager_decision_saga.sql", import.meta.url),
  "utf8",
) + await readFile(
  new URL("../src/persistence/migrations/0006_extraction_lineage.sql", import.meta.url),
  "utf8",
) + await readFile(
  new URL("../src/persistence/migrations/0007_extraction_operation_identity.sql", import.meta.url),
  "utf8",
);

async function migratedDb(): Promise<PGlite> {
  const db = new PGlite();
  await applyMigrations(db, migrations);
  return db;
}

async function rejectQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<void> {
  await assert.rejects(db.query(sql, params));
}

async function seedArtifact(db: PGlite, clinicId = "clinic-a", id = "artifact-a"): Promise<void> {
  await db.query(
    `INSERT INTO artifact (
      clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
      identity_anchor, payload, created_at
    ) VALUES ($1, $2, 'REGISTRATION', '2026-08-29T09:00:00Z', 'source',
      'employee-a', ' PAT-001 ', '{"source":"scan"}', '2026-08-29T09:00:01Z')`,
    [clinicId, id],
  );
}

async function seedWorkflow(db: PGlite, clinicId = "clinic-a", id = "workflow-a"): Promise<void> {
  await db.query(
    `INSERT INTO workflow (
      clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at
    ) VALUES ($1, $2, 'patient', ' PAT-001 ', 'EYE_EXAM', 'OPEN',
      '2026-08-29T09:00:01Z', '2026-08-29T09:00:01Z')`,
    [clinicId, id],
  );
}

async function seedExpectation(
  db: PGlite,
  clinicId = "clinic-a",
  id = "expectation-a",
  workflowId = "workflow-a",
): Promise<void> {
  await db.query(
    `INSERT INTO expectation (
      clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
      due_at, state, satisfied_by_artifact_id, evaluated_at
    ) VALUES ($1, $2, $3, 'REGISTRATION', 'EXAM_REPORT', '2026-08-29T09:00:00Z',
      '2026-08-29T09:15:00Z', 'OPEN', NULL, '2026-08-29T09:05:00Z')`,
    [clinicId, id, workflowId],
  );
}

async function seedOpenVerification(db: PGlite): Promise<void> {
  await db.query(`INSERT INTO expectation_transition (
    clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
    trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids
  ) VALUES ('clinic-a', 'transition-open', 'expectation-a', 'workflow-a', NULL, 'OPEN',
    '2026-08-29T09:05:00Z', 'artifact-a', NULL, '{artifact-a}')`);
  await db.query(`INSERT INTO s2_verification (
    clinic_id, id, workflow_id, expectation_id, source_transition_id, verifier_version,
    status, reason_codes, trigger_artifact_id, consequence_artifact_id,
    evidence_artifact_ids, evaluated_at
  ) VALUES ('clinic-a', 'verification-open', 'workflow-a', 'expectation-a',
    'transition-open', 'S2_V1', 'PENDING', '{CHAIN_OPEN}', 'artifact-a', NULL,
    '{artifact-a}', '2026-08-29T09:05:00Z')`);
}

test("fresh migration creates the required tables", async () => {
  const db = await migratedDb();
  try {
    const result = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    assert.deepEqual(
      result.rows.map(({ tablename }) => tablename),
      [
        "artifact",
        "evidence_extraction_attempt",
        "evidence_fact_card",
        "expectation",
        "expectation_transition",
        "manager_decision",
        "s2_verification",
        "schema_migration",
        "stored_object_ref",
        "workflow",
        "workflow_artifact_link",
      ],
    );
  } finally {
    await db.close();
  }
});

test("identical migration rerun is a no-op", async () => {
  const db = new PGlite();
  try {
    assert.deepEqual(
      await applyMigrations(db, migrations),
      [
        "0001_trusted_core",
        "0002_expectation_transition",
        "0003_expectation_reevaluation",
        "0004_s2_verification",
        "0005_manager_decision_saga",
        "0006_extraction_lineage",
        "0007_extraction_operation_identity",
      ],
    );
    assert.deepEqual(await applyMigrations(db, migrations), []);
    const ledger = await db.query("SELECT id FROM schema_migration");
    assert.equal(ledger.rows.length, 7);
  } finally {
    await db.close();
  }
});

test("repository schema compatibility accepts only the exact read-only migration ledger", async () => {
  const db = await migratedDb();
  try {
    assert.equal(await isRepositorySchemaCompatible(db), true);
    await db.query("UPDATE schema_migration SET checksum = '0' || substr(checksum, 2) WHERE id = '0001_trusted_core'");
    assert.equal(await isRepositorySchemaCompatible(db), false);
  } finally {
    await db.close();
  }
});

test("repository schema compatibility fails closed without creating a migration ledger", async () => {
  const db = new PGlite();
  try {
    assert.equal(await isRepositorySchemaCompatible(db), false);
    const ledger = await db.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migration'");
    assert.equal(ledger.rows.length, 0);
  } finally {
    await db.close();
  }
});

test("repository schema compatibility rejects missing and unknown migration entries", async () => {
  const db = await migratedDb();
  try {
    await db.query("DELETE FROM schema_migration WHERE id = '0007_extraction_operation_identity'");
    assert.equal(await isRepositorySchemaCompatible(db), false);
    await db.query("INSERT INTO schema_migration (id, checksum) VALUES ('9999_unknown', repeat('a', 64))");
    assert.equal(await isRepositorySchemaCompatible(db), false);
  } finally {
    await db.close();
  }
});

test("changed checksum for an applied migration fails closed", async () => {
  const db = new PGlite();
  try {
    await applyMigrations(db, [{ id: "0001_test", sql: "CREATE TABLE checksum_a (id text)" }]);
    await assert.rejects(
      applyMigrations(db, [{ id: "0001_test", sql: "CREATE TABLE checksum_b (id text)" }]),
      (error: unknown) => error instanceof MigrationError && error.code === "MIGRATION_CHECKSUM_MISMATCH",
    );
  } finally {
    await db.close();
  }
});

test("failed migration records no ledger row", async () => {
  const db = new PGlite();
  try {
    await applyMigrations(db, [{ id: "0001_test", sql: "CREATE TABLE migration_ok (id text)" }]);
    await assert.rejects(applyMigrations(db, [{ id: "0002_bad", sql: "NOT VALID SQL" }]));
    const result = await db.query<{ id: string }>("SELECT id FROM schema_migration ORDER BY id");
    assert.deepEqual(result.rows.map(({ id }) => id), ["0001_test"]);
  } finally {
    await db.close();
  }
});

test("unknown and duplicate migration IDs are rejected before SQL", async () => {
  const db = new PGlite();
  try {
    await assert.rejects(
      applyMigrations(db, [{ id: "bad", sql: "CREATE TABLE should_not_exist (id text)" }]),
      (error: unknown) => error instanceof MigrationError && error.code === "UNKNOWN_MIGRATION_ID",
    );
    await assert.rejects(
      applyMigrations(db, [
        { id: "0001_same", sql: "SELECT 1" },
        { id: "0001_same", sql: "SELECT 2" },
      ]),
      (error: unknown) => error instanceof MigrationError && error.code === "DUPLICATE_MIGRATION_ID",
    );
    const tables = await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'should_not_exist'");
    assert.equal(tables.rows.length, 0);
  } finally {
    await db.close();
  }
});

test("artifact preserves exact identity anchor and JSON payload", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    const result = await db.query<{ identity_anchor: string; payload: unknown }>(
      "SELECT identity_anchor, payload FROM artifact WHERE clinic_id = 'clinic-a' AND id = 'artifact-a'",
    );
    assert.equal(result.rows[0].identity_anchor, " PAT-001 ");
    assert.deepEqual(result.rows[0].payload, { source: "scan" });
  } finally {
    await db.close();
  }
});

test("artifact rejects UPDATE and DELETE", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await rejectQuery(db, "UPDATE artifact SET kind = 'OTHER'");
    await rejectQuery(db, "DELETE FROM artifact");
  } finally {
    await db.close();
  }
});

test("artifact occurred-at provenance combinations are constrained", async () => {
  const db = await migratedDb();
  try {
    const base = `INSERT INTO artifact (
      clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
      identity_anchor, payload, created_at
    ) VALUES ('clinic-a', $1, 'REGISTRATION', $2, $3, 'employee-a', NULL, '{}', NOW())`;
    await db.query(base, ["valid-null", null, "unknown"]);
    await db.query(base, ["valid-time", "2026-08-29T09:00:00Z", "source"]);
    await rejectQuery(db, base, ["bad-null", null, "source"]);
    await rejectQuery(db, base, ["bad-time", "2026-08-29T09:00:00Z", "unknown"]);
  } finally {
    await db.close();
  }
});

test("FactCard cross-tenant Artifact FK fails", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db, "clinic-a", "artifact-a");
    await rejectQuery(
      db,
      `INSERT INTO evidence_fact_card (
        clinic_id, id, artifact_id, subject_type, identity_anchor, workflow_family,
        occurred_at, fields, missing_fields, confidence, parser_version, lineage_artifact_ids
      ) VALUES ('clinic-b', 'fact-b', 'artifact-a', 'patient', ' PAT-001 ', 'EYE_EXAM',
        NOW(), '{}', '{}', 0.9, 'parser-1', '{artifact-a}')`,
    );
  } finally {
    await db.close();
  }
});

test("FactCard lineage must be non-empty and contain its source Artifact", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    const insert = `INSERT INTO evidence_fact_card (
      clinic_id, id, artifact_id, subject_type, identity_anchor, workflow_family,
      occurred_at, fields, missing_fields, confidence, parser_version, lineage_artifact_ids
    ) VALUES ('clinic-a', $1, 'artifact-a', 'patient', ' PAT-001 ', 'EYE_EXAM',
      NOW(), '{}', '{}', 0.9, 'parser-1', $2)`;
    await rejectQuery(db, insert, ["empty-lineage", []]);
    await rejectQuery(db, insert, ["missing-source", ["artifact-other"]]);
    await rejectQuery(db, insert, ["null-lineage", ["artifact-a", null]]);
  } finally {
    await db.close();
  }
});

test("patient Workflow anchor cannot be null or blank", async () => {
  const db = await migratedDb();
  try {
    const insert = `INSERT INTO workflow (
      clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at
    ) VALUES ('clinic-a', $1, 'patient', $2, 'EYE_EXAM', 'OPEN', NOW(), NOW())`;
    await rejectQuery(db, insert, ["null-anchor", null]);
    await rejectQuery(db, insert, ["blank-anchor", ""]);
    await rejectQuery(db, insert, ["space-anchor", "   "]);
    await rejectQuery(
      db,
      `INSERT INTO workflow (
        clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at
      ) VALUES ('clinic-a', 'uppercase-null-anchor', 'PATIENT', NULL, 'EYE_EXAM', 'OPEN', NOW(), NOW())`,
    );
    await rejectQuery(
      db,
      `INSERT INTO workflow (
        clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at
      ) VALUES ('clinic-a', 'uppercase-blank-anchor', 'PATIENT', '  ', 'EYE_EXAM', 'OPEN', NOW(), NOW())`,
    );
  } finally {
    await db.close();
  }
});

test("link duplicate and cross-tenant foreign keys fail", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await seedWorkflow(db);
    const insert = `INSERT INTO workflow_artifact_link (
      clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain
    ) VALUES ($1, $2, $3, $4, NOW(), 'DETERMINISTIC', '{exact_identity}')`;
    await db.query(insert, ["clinic-a", "link-a", "workflow-a", "artifact-a"]);
    await rejectQuery(db, insert, ["clinic-a", "link-b", "workflow-a", "artifact-a"]);
    await rejectQuery(db, insert, ["clinic-b", "link-c", "workflow-a", "artifact-a"]);
  } finally {
    await db.close();
  }
});

test("link rejects UPDATE and DELETE", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await seedWorkflow(db);
    await db.query(`INSERT INTO workflow_artifact_link (
      clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain
    ) VALUES ('clinic-a', 'link-a', 'workflow-a', 'artifact-a', NOW(), 'DETERMINISTIC', '{exact_identity}')`);
    await rejectQuery(db, "UPDATE workflow_artifact_link SET attached_at = NOW()");
    await rejectQuery(db, "DELETE FROM workflow_artifact_link");
  } finally {
    await db.close();
  }
});

test("expectation rejects invalid time and satisfying-evidence combinations", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await seedWorkflow(db);
    const insert = `INSERT INTO expectation (
      clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
      due_at, state, satisfied_by_artifact_id, evaluated_at
    ) VALUES ('clinic-a', $1, 'workflow-a', 'REGISTRATION', 'EXAM_REPORT',
      $2, $3, $4, $5, NOW())`;
    await rejectQuery(db, insert, ["bad-time", "2026-08-29T09:15:00Z", "2026-08-29T09:00:00Z", "OPEN", null]);
    await rejectQuery(db, insert, ["met-null", "2026-08-29T09:00:00Z", "2026-08-29T09:15:00Z", "MET", null]);
    await rejectQuery(db, insert, ["open-filled", "2026-08-29T09:00:00Z", "2026-08-29T09:15:00Z", "OPEN", "artifact-a"]);
  } finally {
    await db.close();
  }
});

test("expectation transition rejects illegal automatic paths and duplicate evaluation instants", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await seedWorkflow(db);
    await seedExpectation(db);
    const insert = `INSERT INTO expectation_transition (
      clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
      trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids
    ) VALUES ('clinic-a', $1, 'expectation-a', 'workflow-a', $2, $3, $4,
      'artifact-a', NULL, '{artifact-a}')`;
    await db.query(insert, ["open-open", "OPEN", "OPEN", "2026-08-29T09:06:00Z"]);
    await rejectQuery(db, insert, ["duplicate-time", "OPEN", "UNMET", "2026-08-29T09:06:00Z"]);
    await rejectQuery(db, insert, ["unmet-open", "UNMET", "OPEN", "2026-08-29T09:07:00Z"]);
    await rejectQuery(db, insert, ["met-open", "MET", "OPEN", "2026-08-29T09:08:00Z"]);
    await rejectQuery(db, insert, ["voided-open", "VOIDED", "OPEN", "2026-08-29T09:09:00Z"]);
  } finally {
    await db.close();
  }
});

test("manager decision rejects invalid actor, action, reason, and verification state", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await seedWorkflow(db);
    await seedExpectation(db);
    await seedOpenVerification(db);
    const insert = `INSERT INTO manager_decision (
      clinic_id, id, workflow_id, expectation_id, action, reason_code, note, actor_id,
      actor_role, decided_at, evidence_artifact_ids, verification_status, verification_reason_codes,
      verification_id, verification_source_transition_id, expectation_state,
      verification_evaluated_at
    ) VALUES ('clinic-a', $1, 'workflow-a', 'expectation-a', $2, $3, NULL,
      'manager-a', $4, '2026-08-29T09:06:00Z', '{artifact-a}', $5, '{}',
      'verification-open', 'transition-open', 'OPEN', '2026-08-29T09:05:00Z')`;
    await rejectQuery(db, insert, ["bad-role", "KEEP_OPEN", null, "EMPLOYEE", "PENDING"]);
    await rejectQuery(db, insert, ["bad-action", "AUTO_CLOSE", null, "MANAGER", "PENDING"]);
    await rejectQuery(db, insert, ["bad-reason", "VOID", "FREE_TEXT", "MANAGER", "PENDING"]);
    await rejectQuery(db, insert, ["bad-verification", "KEEP_OPEN", null, "MANAGER", "GREEN"]);
    await rejectQuery(
      db,
      `INSERT INTO manager_decision (
        clinic_id, id, workflow_id, expectation_id, action, reason_code, note, actor_id,
        actor_role, decided_at, evidence_artifact_ids, verification_status, verification_reason_codes,
        verification_id, verification_source_transition_id, expectation_state,
        verification_evaluated_at
      ) VALUES ('clinic-a', 'bad-verification-reason', 'workflow-a', 'expectation-a',
        'KEEP_OPEN', NULL, NULL, 'manager-a', 'MANAGER', '2026-08-29T09:06:00Z',
        '{artifact-a}', 'PENDING', '{MODEL_SAYS_SO}', 'verification-open',
        'transition-open', 'OPEN', '2026-08-29T09:05:00Z')`,
    );
  } finally {
    await db.close();
  }
});

test("manager decision rejects UPDATE and DELETE", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await seedWorkflow(db);
    await seedExpectation(db);
    await seedOpenVerification(db);
    await db.query(`INSERT INTO manager_decision (
      clinic_id, id, workflow_id, expectation_id, action, reason_code, note, actor_id,
      actor_role, decided_at, evidence_artifact_ids, verification_status, verification_reason_codes,
      verification_id, verification_source_transition_id, expectation_state,
      verification_evaluated_at
    ) VALUES ('clinic-a', 'decision-a', 'workflow-a', 'expectation-a', 'KEEP_OPEN', NULL,
      NULL, 'manager-a', 'MANAGER', '2026-08-29T09:06:00Z', '{artifact-a}',
      'PENDING', '{CHAIN_OPEN}', 'verification-open', 'transition-open', 'OPEN',
      '2026-08-29T09:05:00Z')`);
    await rejectQuery(db, "UPDATE manager_decision SET note = 'changed'");
    await rejectQuery(db, "DELETE FROM manager_decision");
  } finally {
    await db.close();
  }
});

test("manager decision enforces closure, evidence, and verification coherence", async () => {
  const db = await migratedDb();
  try {
    await seedArtifact(db);
    await seedWorkflow(db);
    await seedExpectation(db);
    await seedOpenVerification(db);
    const insert = `INSERT INTO manager_decision (
      clinic_id, id, workflow_id, expectation_id, action, reason_code, note, actor_id,
      actor_role, decided_at, evidence_artifact_ids, verification_status, verification_reason_codes,
      verification_id, verification_source_transition_id, expectation_state,
      verification_evaluated_at
    ) VALUES ('clinic-a', $1, 'workflow-a', 'expectation-a', $2, $3, NULL,
      'manager-a', 'MANAGER', '2026-08-29T09:06:00Z', $4, $5, $6,
      'verification-open', 'transition-open', 'OPEN', '2026-08-29T09:05:00Z')`;
    await rejectQuery(db, insert, [
      "standard-pending", "CLOSE_STANDARD", null, ["artifact-a"], "PENDING", ["CHAIN_OPEN"],
    ]);
    await rejectQuery(db, insert, [
      "verified-with-reason", "CLOSE_STANDARD", null, ["artifact-a"], "VERIFIED", ["CHAIN_OPEN"],
    ]);
    await rejectQuery(db, insert, [
      "empty-evidence", "KEEP_OPEN", null, [], "PENDING", ["CHAIN_OPEN"],
    ]);
    await rejectQuery(db, insert, [
      "null-evidence", "KEEP_OPEN", null, ["artifact-a", null], "PENDING", ["CHAIN_OPEN"],
    ]);
    await rejectQuery(db, insert, [
      "duplicate-evidence", "KEEP_OPEN", null,
      ["artifact-a", "artifact-a"], "PENDING", ["CHAIN_OPEN"],
    ]);
    await rejectQuery(db, insert, [
      "null-verification-reason", "KEEP_OPEN", null, ["artifact-a"], "PENDING", [null],
    ]);
    await rejectQuery(db, insert, [
      "fabricated-verification-reason", "KEEP_OPEN", null,
      ["artifact-a"], "PENDING", ["CHAIN_UNMET"],
    ]);
    await rejectQuery(
      db,
      `INSERT INTO manager_decision (
        clinic_id, id, workflow_id, expectation_id, action, reason_code, note, actor_id,
        actor_role, decided_at, evidence_artifact_ids, verification_status,
        verification_reason_codes, verification_id, verification_source_transition_id,
        expectation_state, verification_evaluated_at
      ) VALUES ('clinic-a', 'stale-expectation-state', 'workflow-a', 'expectation-a',
        'KEEP_OPEN', 'NEEDS_MORE_EVIDENCE', NULL, 'manager-a', 'MANAGER',
        '2026-08-29T09:06:00Z', '{artifact-a}', 'PENDING', '{CHAIN_OPEN}',
        'verification-open', 'transition-open', 'UNMET', '2026-08-29T09:05:00Z')`,
    );
    await rejectQuery(
      db,
      `INSERT INTO manager_decision (
        clinic_id, id, workflow_id, expectation_id, action, reason_code, note, actor_id,
        actor_role, decided_at, evidence_artifact_ids, verification_status,
        verification_reason_codes, verification_id, verification_source_transition_id,
        expectation_state, verification_evaluated_at
      ) VALUES ('clinic-a', 'decision-before-verification', 'workflow-a', 'expectation-a',
        'KEEP_OPEN', NULL, NULL, 'manager-a', 'MANAGER', '2026-08-29T09:04:59Z',
        '{artifact-a}', 'PENDING', '{CHAIN_OPEN}', 'verification-open', 'transition-open',
        'OPEN', '2026-08-29T09:05:00Z')`,
    );
  } finally {
    await db.close();
  }
});

test("every business table enables and forces RLS with USING and WITH CHECK", async () => {
  const db = await migratedDb();
  try {
    const tables = [
      "artifact",
      "stored_object_ref",
      "evidence_extraction_attempt",
      "evidence_fact_card",
      "workflow",
      "workflow_artifact_link",
      "expectation",
      "expectation_transition",
      "manager_decision",
      "s2_verification",
    ];
    const flags = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = ANY($1) ORDER BY relname`,
      [tables],
    );
    assert.equal(flags.rows.length, tables.length);
    assert.ok(flags.rows.every(({ relrowsecurity, relforcerowsecurity }) => relrowsecurity && relforcerowsecurity));
    const policies = await db.query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename, qual, with_check FROM pg_policies
       WHERE tablename = ANY($1) ORDER BY tablename`,
      [tables],
    );
    assert.equal(policies.rows.length, tables.length);
    for (const policy of policies.rows) {
      assert.match(policy.qual, /current_setting\('app\.clinic_id'/);
      assert.match(policy.with_check, /current_setting\('app\.clinic_id'/);
    }
  } finally {
    await db.close();
  }
});

test("migration SQL contains no hard-coded clinic, credentials, extension, or network function", () => {
  assert.doesNotMatch(migrationSql, /demo-clinic|password\s*=|create\s+extension|dblink|http_get|lo_import/i);
  assert.doesNotMatch(migrationSql, /https?:\/\//i);
});

test("tenant adapter sets exact transaction-local clinic context", async () => {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  let releases = 0;
  const pool = {
    async connect() {
      return {
        async query(sql: string, params?: readonly unknown[]) {
          calls.push({ sql, params });
          return { rows: [] };
        },
        release() {
          releases += 1;
        },
      };
    },
  };
  const result = await withTenantTransaction(pool, " clinic-verbatim ", async () => "done");
  assert.equal(result, "done");
  assert.equal(releases, 1);
  assert.deepEqual(calls, [
    { sql: "BEGIN", params: undefined },
    {
      sql: "SELECT set_config('app.clinic_id', $1, true)",
      params: [" clinic-verbatim "],
    },
    { sql: "COMMIT", params: undefined },
  ]);
});

test("db:migrate without DATABASE_URL fails safely before connection", async () => {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["src/persistence/node-pg-client.ts"], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DATABASE_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "DATABASE_URL_REQUIRED");
});

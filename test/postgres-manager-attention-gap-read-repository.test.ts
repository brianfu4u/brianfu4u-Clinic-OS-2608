import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext } from "../src/domain/contracts.ts";
import type { DatabaseConnection, DatabasePool, DatabaseQueryResult } from "../src/persistence/database-contracts.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { ManagerClosureReadRepository } from "../src/persistence/manager-closure-read-repository.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

const manager = (clinicId = "clinic-a"): ActorContext => ({ clinicId, actorId: "manager-a", role: "MANAGER" });

class Pool implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  malformedAttachment = false;
  writes = 0;

  async migrate(): Promise<void> { await applyMigrations(this.db, await loadRepositoryMigrations()); }
  async connect(): Promise<DatabaseConnection> {
    this.acquisitions += 1;
    return {
      query: async <Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
        if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(text)) this.writes += 1;
        const result = await this.db.query<Row>(text, values as unknown[]);
        if (this.malformedAttachment && /FROM workflow_artifact_link AS link/.test(text) && result.rows[0]) {
          (result.rows[0] as Record<string, unknown>).artifact_id = "";
        }
        return { rows: result.rows } as DatabaseQueryResult<Row>;
      },
      release() {},
    };
  }
  async close(): Promise<void> { await this.db.close(); }
}

async function seed(
  pool: DatabasePool,
  options: { clinic?: string; workflow?: string; kinds?: readonly string[]; duplicateIdentity?: boolean } = {},
): Promise<void> {
  const clinic = options.clinic ?? "clinic-a";
  const workflow = options.workflow ?? "workflow-a";
  const kinds = options.kinds ?? ["REGISTRATION", "PRESCRIPTION", "EXAM_REPORT", "PAYMENT"];
  await withTenantTransaction(pool, clinic, async (client) => {
    await client.query(`INSERT INTO workflow
      (clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
      VALUES ($1, $2, 'PATIENT', 'DEMO-001', 'EYE_EXAM', 'OPEN',
        '2026-08-31T09:00:00.000Z', '2026-08-31T09:00:00.000Z')`, [clinic, workflow]);
    for (const [index, kind] of kinds.entries()) {
      const id = `${workflow}:${kind}:${index}`;
      const anchor = options.duplicateIdentity && index === kinds.length - 1 ? "DEMO-002" : "DEMO-001";
      const occurredAt = `2026-08-31T09:0${index}:00.000Z`;
      await client.query(`INSERT INTO artifact
        (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id, identity_anchor, payload, created_at)
        VALUES ($1, $2, $3, $4, 'source', 'employee-private', $5, '{"private":"payload"}', $4)`,
      [clinic, id, kind, occurredAt, anchor]);
      await client.query(`INSERT INTO workflow_artifact_link
        (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
        VALUES ($1, $2, $3, $4, $5, 'DETERMINISTIC', '{exact_identity}')`,
      [clinic, `link:${id}`, workflow, id, `${occurredAt}`]);
    }
    const registrationId = `${workflow}:REGISTRATION:0`;
    await client.query(`INSERT INTO expectation
      (clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at, due_at, state,
       satisfied_by_artifact_id, evaluated_at)
      VALUES ($1, $2, $3, 'REGISTRATION', 'PRESCRIPTION', '2026-08-31T09:00:00.000Z',
       '2026-08-31T09:15:00.000Z', 'OPEN', NULL, '2026-08-31T09:00:00.000Z')`,
    [clinic, `expectation:${workflow}`, workflow]);
    await client.query(`INSERT INTO expectation_transition
      (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
       trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
      VALUES ($1, $2, $3, $4, NULL, 'OPEN', '2026-08-31T09:00:00.000Z', $5, NULL, $6)`,
    [clinic, `transition:${workflow}`, `expectation:${workflow}`, workflow, registrationId, [registrationId]]);
    await client.query(`INSERT INTO s2_verification
      (clinic_id, id, workflow_id, expectation_id, source_transition_id, verifier_version, status,
       reason_codes, trigger_artifact_id, consequence_artifact_id, evidence_artifact_ids, evaluated_at)
      VALUES ($1, $2, $3, $4, $5, 'S2_V1', 'PENDING', '{CHAIN_OPEN}', $6, NULL, $7,
       '2026-08-31T09:00:00.000Z')`,
    [clinic, `verification:${workflow}`, workflow, `expectation:${workflow}`, `transition:${workflow}`,
      registrationId, [registrationId]]);
  });
}

test("manager attention exposes only deterministic missing/conflict chains, in workflow order", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await seed(pool, { workflow: "workflow-z", kinds: ["REGISTRATION", "PRESCRIPTION"] });
    await seed(pool, { workflow: "workflow-a", kinds: ["REGISTRATION", "PRESCRIPTION", "EXAM_REPORT", "PAYMENT"], duplicateIdentity: true });
    await seed(pool, { workflow: "workflow-quiet" });
    const items = await new ManagerClosureReadRepository(pool).listManagerAttentionGaps(manager());
    assert.deepEqual(items, [
      {
        workflowId: "workflow-a", workflowFamily: "EYE_EXAM", workflowStatus: "OPEN",
        stage: "STRUCTURED_ALIGNMENT", alignmentStatus: "CONFLICT",
        reasonCodes: ["IDENTITY_CONFLICT", "CHAIN_OPEN"],
      },
      {
        workflowId: "workflow-z", workflowFamily: "EYE_EXAM", workflowStatus: "OPEN",
        stage: "STRUCTURED_ALIGNMENT", alignmentStatus: "MISSING",
        reasonCodes: ["MISSING_EXAM_REPORT", "MISSING_PAYMENT", "CHAIN_OPEN"],
      },
    ]);
    assert.deepEqual(Object.keys(items[0]).sort(), [
      "alignmentStatus", "reasonCodes", "stage", "workflowFamily", "workflowId", "workflowStatus",
    ]);
    assert.doesNotMatch(JSON.stringify(items), /payload|employee|DEMO-001|artifact|expectation|ocr|model/i);
  } finally { await pool.close(); }
});

test("manager authority and tenant scope are checked before reads", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await seed(pool, { clinic: "clinic-a", kinds: ["REGISTRATION"] });
    await seed(pool, { clinic: "clinic-b", kinds: ["REGISTRATION"] });
    const repository = new ManagerClosureReadRepository(pool);
    const before = pool.acquisitions;
    await assert.rejects(repository.listManagerAttentionGaps({ ...manager(), role: "EMPLOYEE" }));
    assert.equal(pool.acquisitions, before);
    assert.equal((await repository.listManagerAttentionGaps(manager("clinic-a"))).length, 1);
    assert.equal((await repository.listManagerAttentionGaps(manager("clinic-b"))).length, 1);
    assert.deepEqual(await repository.listManagerAttentionGaps(manager("clinic-a' OR 1=1 --")), []);
  } finally { await pool.close(); }
});

test("attention read is detached and fails closed for malformed stored rows without writes", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await seed(pool, { kinds: ["REGISTRATION"] });
    const repository = new ManagerClosureReadRepository(pool);
    const writesBeforeRead = pool.writes;
    const first = await repository.listManagerAttentionGaps(manager());
    first[0].reasonCodes.push("FAKE");
    assert.deepEqual((await repository.listManagerAttentionGaps(manager()))[0].reasonCodes,
      ["MISSING_PRESCRIPTION", "MISSING_EXAM_REPORT", "MISSING_PAYMENT", "CHAIN_OPEN"]);
    assert.equal(pool.writes, writesBeforeRead);
    pool.malformedAttachment = true;
    await assert.rejects(repository.listManagerAttentionGaps(manager()), /Stored manager closure data is malformed/);
    assert.equal(pool.writes, writesBeforeRead);
  } finally { await pool.close(); }
});

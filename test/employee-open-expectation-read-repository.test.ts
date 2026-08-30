import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import type { ActorContext } from "../src/domain/contracts.ts";
import type { DatabaseConnection, DatabasePool, DatabaseQueryResult } from "../src/persistence/database-contracts.ts";
import { EmployeeOpenExpectationReadRepository } from "../src/persistence/employee-open-expectation-read-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

class Pool implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  async migrate() { await applyMigrations(this.db, await loadRepositoryMigrations()); }
  async connect(): Promise<DatabaseConnection> {
    this.acquisitions++;
    return { query: async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      const result = await this.db.query<Row>(sql, values as unknown[] | undefined);
      return { rows: result.rows } satisfies DatabaseQueryResult<Row>;
    }, release() {} };
  }
  close() { return this.db.close(); }
}

const employee = (actorId = "employee-a", clinicId = "clinic-a"): ActorContext => ({ clinicId, actorId, role: "EMPLOYEE" });

async function seed(pool: Pool, id: string, sourceEmployeeId = "employee-a", dueAt = "2026-08-30T09:15:00.000Z") {
  await withTenantTransaction(pool, "clinic-a", async (db) => {
    await db.query(`INSERT INTO artifact (clinic_id,id,kind,occurred_at,occurred_at_source,source_employee_id,identity_anchor,payload,created_at)
      VALUES ('clinic-a',$1,'REGISTRATION','2026-08-30T09:00:00.000Z','source',$2,'DEMO-001','{}','2026-08-30T09:00:00.000Z')`, [`trigger-${id}`, sourceEmployeeId]);
    await db.query(`INSERT INTO workflow (clinic_id,id,subject_type,identity_anchor,workflow_family,status,created_at,updated_at)
      VALUES ('clinic-a',$1,'PATIENT','DEMO-001','EYE_EXAM','OPEN','2026-08-30T09:00:00.000Z','2026-08-30T09:00:00.000Z')`, [`workflow-${id}`]);
    await db.query(`INSERT INTO workflow_artifact_link (clinic_id,id,workflow_id,artifact_id,attached_at,decision_source,reasoning_chain)
      VALUES ('clinic-a',$1,$2,$3,'2026-08-30T09:00:00.000Z','DETERMINISTIC','{exact}')`, [`link-${id}`, `workflow-${id}`, `trigger-${id}`]);
    await db.query(`INSERT INTO expectation (clinic_id,id,workflow_id,trigger_kind,consequence_kind,triggered_at,due_at,state,evaluated_at)
      VALUES ('clinic-a',$1,$2,'REGISTRATION','EXAM_REPORT','2026-08-30T09:00:00.000Z',$3,'OPEN','2026-08-30T09:00:00.000Z')`, [`expectation-${id}`, `workflow-${id}`, dueAt]);
    await db.query(`INSERT INTO expectation_transition (clinic_id,id,expectation_id,workflow_id,from_state,to_state,evaluated_at,trigger_artifact_id,evidence_artifact_ids)
      VALUES ('clinic-a',$1,$2,$3,NULL,'OPEN','2026-08-30T09:00:00.000Z',$4,ARRAY[$4])`, [`transition-${id}`, `expectation-${id}`, `workflow-${id}`, `trigger-${id}`]);
  });
}

test("employee selector exposes only detached own open current EXAM_REPORT projections", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await seed(pool, "later", "employee-a", "2026-08-30T09:20:00.000Z");
    await seed(pool, "first", "employee-a", "2026-08-30T09:15:00.000Z");
    await seed(pool, "other", "employee-b", "2026-08-30T09:10:00.000Z");
    const repo = new EmployeeOpenExpectationReadRepository(pool);
    const page = await repo.listOpenExamReportExpectations(employee(), { asOf: "2026-08-30T09:05:00.000Z", limit: 1 });
    assert.deepEqual(Object.keys(page.items[0]).sort(), ["consequenceKind", "dueAt", "expectationId", "state", "workflowFamily"]);
    assert.equal(page.items[0].expectationId, "expectation-first");
    assert.ok(page.nextCursor);
    const second = await repo.listOpenExamReportExpectations(employee(), { asOf: "2026-08-30T09:05:00.000Z", cursor: page.nextCursor! });
    assert.deepEqual(second.items.map((item) => item.expectationId), ["expectation-later"]);
    page.items[0].workflowFamily = "mutated";
    assert.equal((await repo.listOpenExamReportExpectations(employee(), { asOf: "2026-08-30T09:05:00.000Z" })).items[0].workflowFamily, "EYE_EXAM");
  } finally { await pool.close(); }
});

test("selector validates before acquisition and due time remains exclusive", async () => {
  const pool = new Pool(); await pool.migrate();
  try {
    await seed(pool, "one");
    const repo = new EmployeeOpenExpectationReadRepository(pool);
    const before = pool.acquisitions;
    await assert.rejects(repo.listOpenExamReportExpectations(employee(), { asOf: "bad", limit: 1 }),
      (error: { code?: string }) => error.code === "INVALID_EXPECTATION_QUERY");
    await assert.rejects(repo.listOpenExamReportExpectations({ ...employee(), role: "MANAGER" }, { asOf: "2026-08-30T09:05:00.000Z" }),
      (error: { code?: string }) => error.code === "ROLE_SCOPE_VIOLATION");
    assert.equal(pool.acquisitions, before);
    const result = await repo.listOpenExamReportExpectations(employee(), { asOf: "2026-08-30T09:15:00.000Z" });
    assert.equal(result.items.length, 0);
  } finally { await pool.close(); }
});

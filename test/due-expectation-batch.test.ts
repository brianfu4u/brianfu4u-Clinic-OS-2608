import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { DueExpectationBatch } from "../src/application/due-expectation-batch.ts";
import type { ActorContext, Expectation, Workflow } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

const NOW = "2026-08-30T09:15:00.000Z";
const TRIGGERED_AT = "2026-08-30T09:00:00.000Z";
const EVALUATED_AT = "2026-08-30T09:05:00.000Z";

class PGlitePoolShim implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  sql: string[] = [];
  failVerificationFor: string | null = null;

  async migrate(): Promise<void> {
    await applyMigrations(this.db, await loadRepositoryMigrations());
  }

  async connect(): Promise<DatabaseConnection> {
    this.acquisitions += 1;
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<DatabaseQueryResult<Row>> => {
        this.sql.push(text);
        if (/INSERT INTO s2_verification/.test(text) && values?.[3] === this.failVerificationFor) {
          throw new DomainError("FORCED_VERIFICATION_FAILURE", "controlled failure");
        }
        const result = await this.db.query<Row>(text, values as unknown[] | undefined);
        return { rows: result.rows };
      },
      release() {},
    };
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

const manager = (clinicId = "clinic-a"): ActorContext => ({
  clinicId,
  actorId: "manager-a",
  role: "MANAGER",
});

type SeedOptions = {
  clinicId?: string;
  dueAt?: string;
  state?: Expectation["state"];
  workflowStatus?: Workflow["status"];
  linkTrigger?: boolean;
};

async function seedExpectation(pool: DatabasePool, id: string, options: SeedOptions = {}): Promise<void> {
  const clinicId = options.clinicId ?? "clinic-a";
  const dueAt = options.dueAt ?? NOW;
  const state = options.state ?? "OPEN";
  const workflowStatus = options.workflowStatus ?? "OPEN";
  const workflowId = `workflow-${id}`;
  const triggerId = `trigger-${id}`;
  const consequenceId = `report-${id}`;
  await withTenantTransaction(pool, clinicId, async (client) => {
    await client.query(
      `INSERT INTO workflow
         (clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
       VALUES ($1, $2, 'PATIENT', $3, 'EYE_EXAM', $4, $5, $5)`,
      [clinicId, workflowId, `PAT-${id}`, workflowStatus, TRIGGERED_AT],
    );
    await client.query(
      `INSERT INTO artifact
         (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
          identity_anchor, payload, created_at)
       VALUES ($1, $2, 'REGISTRATION', $3, 'source', 'employee-a', $4, '{}', $3)`,
      [clinicId, triggerId, TRIGGERED_AT, `PAT-${id}`],
    );
    if (options.linkTrigger !== false) {
      await client.query(
        `INSERT INTO workflow_artifact_link
           (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
         VALUES ($1, $2, $3, $4, $5, 'DETERMINISTIC', '{exact_identity}')`,
        [clinicId, `link-${id}`, workflowId, triggerId, TRIGGERED_AT],
      );
    }
    if (state === "MET") {
      await client.query(
        `INSERT INTO artifact
           (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
            identity_anchor, payload, created_at)
         VALUES ($1, $2, 'EXAM_REPORT', $3, 'source', 'employee-a', $4, '{}', $3)`,
        [clinicId, consequenceId, "2026-08-30T09:04:00.000Z", `PAT-${id}`],
      );
      await client.query(
        `INSERT INTO workflow_artifact_link
           (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
         VALUES ($1, $2, $3, $4, $5, 'DETERMINISTIC', '{exact_identity}')`,
        [clinicId, `link-report-${id}`, workflowId, consequenceId, "2026-08-30T09:04:00.000Z"],
      );
    }
    await client.query(
      `INSERT INTO expectation
         (clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
          due_at, state, satisfied_by_artifact_id, evaluated_at)
       VALUES ($1, $2, $3, 'REGISTRATION', 'EXAM_REPORT', $4, $5, $6, $7, $8)`,
      [clinicId, id, workflowId, TRIGGERED_AT, dueAt, state,
        state === "MET" ? consequenceId : null, EVALUATED_AT],
    );
    await client.query(
      `INSERT INTO expectation_transition
         (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)`,
      [clinicId, `transition-${id}`, id, workflowId, state, EVALUATED_AT, triggerId,
        state === "MET" ? consequenceId : null,
        state === "MET" ? [triggerId, consequenceId] : [triggerId]],
    );
  });
}

async function counts(pool: PGlitePoolShim, expectationId: string) {
  const result = await pool.db.query<{ state: string; transitions: number; verifications: number }>(
    `SELECT e.state,
       (SELECT count(*)::int FROM expectation_transition t WHERE t.expectation_id = e.id) transitions,
       (SELECT count(*)::int FROM s2_verification v WHERE v.expectation_id = e.id) verifications
     FROM expectation e WHERE e.id = $1`,
    [expectationId],
  );
  return result.rows[0];
}

test("due boundary OPEN becomes UNMET and receives PENDING S2", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "expectation-a");
    const result = await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 10, cursor: null },
    );
    assert.deepEqual(result.processed, [{ expectationId: "expectation-a" }]);
    assert.deepEqual(result.succeeded, [{
      expectationId: "expectation-a", state: "UNMET", verificationStatus: "PENDING",
    }]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(await counts(pool, "expectation-a"), {
      state: "UNMET", transitions: 2, verifications: 1,
    });
  } finally {
    await pool.close();
  }
});

test("future, non-OPEN, and terminal Workflow rows are not selected", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "future", { dueAt: "2026-08-30T09:16:00.000Z" });
    await seedExpectation(pool, "met", { state: "MET" });
    await seedExpectation(pool, "unmet", { state: "UNMET" });
    await seedExpectation(pool, "voided", { state: "VOIDED" });
    await seedExpectation(pool, "closed-workflow", { workflowStatus: "CLOSED" });
    const result = await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 10, cursor: null },
    );
    assert.deepEqual(result.processed, []);
    assert.equal(result.nextCursor, null);
  } finally {
    await pool.close();
  }
});

test("tenant and manager authority fail closed before business work", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "clinic-a-only");
    const batch = new DueExpectationBatch(pool);
    const before = pool.acquisitions;
    await assert.rejects(
      batch.processDueExpectations({ ...manager(), role: "EMPLOYEE" }, { now: NOW, limit: 1, cursor: null }),
      (error: unknown) => error instanceof DomainError && error.code === "ROLE_SCOPE_VIOLATION",
    );
    await assert.rejects(
      batch.processDueExpectations({ ...manager(), clinicId: "" }, { now: NOW, limit: 1, cursor: null }),
      (error: unknown) => error instanceof DomainError && error.code === "INVALID_ACTOR_CONTEXT",
    );
    assert.equal(pool.acquisitions, before);
    assert.deepEqual((await batch.processDueExpectations(
      manager("clinic-b"), { now: NOW, limit: 1, cursor: null },
    )).processed, []);
  } finally {
    await pool.close();
  }
});

test("time, limit, command shape, and cursor are strictly validated", async () => {
  const pool = new PGlitePoolShim();
  const batch = new DueExpectationBatch(pool);
  const invalid = [
    { now: "2026-08-30 09:15", limit: 1, cursor: null },
    { now: NOW, limit: 0, cursor: null },
    { now: NOW, limit: 101, cursor: null },
    { now: NOW, limit: 1.5, cursor: null },
    { now: NOW, limit: 1, cursor: "not-a-valid-cursor" },
    { now: NOW, limit: 1, cursor: null, clinicId: "clinic-b" },
  ];
  for (const command of invalid) await assert.rejects(
    batch.processDueExpectations(manager(), command as never),
    (error: unknown) => error instanceof DomainError,
  );
  assert.equal(pool.acquisitions, 0);
  await pool.close();
});

test("keyset pages are stable and have no duplicates", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "a", { dueAt: "2026-08-30T09:10:00.000Z" });
    await seedExpectation(pool, "b", { dueAt: "2026-08-30T09:10:00.000Z" });
    await seedExpectation(pool, "c", { dueAt: "2026-08-30T09:11:00.000Z" });
    const batch = new DueExpectationBatch(pool);
    const first = await batch.processDueExpectations(manager(), { now: NOW, limit: 2, cursor: null });
    const second = await batch.processDueExpectations(
      manager(), { now: NOW, limit: 2, cursor: first.nextCursor },
    );
    assert.deepEqual(first.processed.map((item) => item.expectationId), ["a", "b"]);
    assert.deepEqual(second.processed.map((item) => item.expectationId), ["c"]);
  } finally {
    await pool.close();
  }
});

test("same-now replay creates no new transition or Verification", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "replay");
    const batch = new DueExpectationBatch(pool);
    await batch.processDueExpectations(manager(), { now: NOW, limit: 1, cursor: null });
    assert.deepEqual((await batch.processDueExpectations(
      manager(), { now: NOW, limit: 1, cursor: null },
    )).processed, []);
    assert.deepEqual(await counts(pool, "replay"), {
      state: "UNMET", transitions: 2, verifications: 1,
    });
  } finally {
    await pool.close();
  }
});

test("controlled broken chain rolls back only that item and continues", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "broken", { linkTrigger: false });
    await seedExpectation(pool, "healthy");
    const result = await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 10, cursor: null },
    );
    assert.deepEqual(result.failed, [{
      expectationId: "broken", code: "EXPECTATION_TRIGGER_NOT_FOUND",
    }]);
    assert.equal(result.succeeded[0].expectationId, "healthy");
    assert.deepEqual((await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 10, cursor: result.nextCursor },
    )).processed, []);
    assert.deepEqual((await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 10, cursor: null },
    )).failed, [{ expectationId: "broken", code: "EXPECTATION_TRIGGER_NOT_FOUND" }]);
    assert.deepEqual(await counts(pool, "broken"), {
      state: "OPEN", transitions: 1, verifications: 0,
    });
  } finally {
    await pool.close();
  }
});

test("Verification failure rolls back that item Expectation and continues", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "a-fails");
    await seedExpectation(pool, "b-succeeds");
    pool.failVerificationFor = "a-fails";
    const result = await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 10, cursor: null },
    );
    assert.deepEqual(result.failed, [{ expectationId: "a-fails", code: "FORCED_VERIFICATION_FAILURE" }]);
    assert.equal(result.succeeded[0].expectationId, "b-succeeds");
    assert.deepEqual(await counts(pool, "a-fails"), {
      state: "OPEN", transitions: 1, verifications: 0,
    });
  } finally {
    await pool.close();
  }
});

test("SAVEPOINT names are loop-only and selected values stay bound", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    const injected = "expectation'; DROP TABLE artifact; --";
    await seedExpectation(pool, injected);
    await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 1, cursor: null },
    );
    assert.deepEqual(
      pool.sql.filter((sql) => /SAVEPOINT/.test(sql)),
      ["SAVEPOINT due_expectation_0", "RELEASE SAVEPOINT due_expectation_0"],
    );
    assert.equal(pool.sql.some((sql) => sql.includes(injected)), false);
  } finally {
    await pool.close();
  }
});

test("results are detached and controlled failures expose no database detail", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedExpectation(pool, "broken", { linkTrigger: false });
    const result = await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 1, cursor: null },
    );
    assert.deepEqual(Object.keys(result.failed[0]).sort(), ["code", "expectationId"]);
    result.failed[0].code = "MUTATED";
    const replay = await new DueExpectationBatch(pool).processDueExpectations(
      manager(), { now: NOW, limit: 1, cursor: null },
    );
    assert.equal(replay.failed[0].code, "EXPECTATION_TRIGGER_NOT_FOUND");
  } finally {
    await pool.close();
  }
});

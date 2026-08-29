import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext, Expectation } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";
import { VerificationRepository } from "../src/persistence/verification-repository.ts";

const TRIGGERED_AT = "2026-08-29T09:00:00.000Z";
const DUE_AT = "2026-08-29T09:15:00.000Z";

class PGlitePoolShim implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  failOn: RegExp | null = null;
  failAfterInsertRead = false;
  insertedVerification = false;
  reverseLinkedRows = false;
  hideWorkflow = false;
  hideSourceTransition = false;
  corruptLinkTime = false;

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
        if (this.failOn?.test(text)) throw new Error("FORCED_DATABASE_FAILURE");
        if (this.hideWorkflow && /FROM workflow WHERE/.test(text)) return { rows: [] };
        if (this.hideSourceTransition && /FROM expectation_transition/.test(text)) return { rows: [] };
        if (/INSERT INTO s2_verification/.test(text)) this.insertedVerification = true;
        if (this.failAfterInsertRead && this.insertedVerification && /FROM s2_verification/.test(text)) {
          throw new Error("FORCED_READ_FAILURE");
        }
        const result = await this.db.query<Row>(text, values as unknown[] | undefined);
        if (this.corruptLinkTime && /FROM workflow_artifact_link l/.test(text) && result.rows[0]) {
          (result.rows[0] as Record<string, unknown>).attached_at = "not-a-time";
        }
        if (this.reverseLinkedRows && /FROM workflow_artifact_link l/.test(text)) {
          result.rows.reverse();
        }
        return { rows: result.rows };
      },
      release() {},
    };
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

const actor = (clinicId = "clinic-a"): ActorContext => ({
  clinicId,
  actorId: "employee-a",
  role: "EMPLOYEE",
});

type SeedOptions = {
  clinicId?: string;
  state?: Expectation["state"];
  workflowStatus?: "OPEN" | "CLOSED" | "VOIDED";
  consequence?: boolean;
  consequenceIdentity?: string;
  consequenceKind?: string;
  consequenceOccurredAt?: string;
  consequenceAttachedAt?: string;
  linkConsequence?: boolean;
  insertTrigger?: boolean;
  linkTrigger?: boolean;
  triggerIdentity?: string;
  triggerKind?: string;
  evaluatedAt?: string;
};

async function seedProjection(pool: DatabasePool, options: SeedOptions = {}): Promise<void> {
  const clinicId = options.clinicId ?? "clinic-a";
  const state = options.state ?? "MET";
  const evaluatedAt = options.evaluatedAt ??
    (state === "OPEN" ? "2026-08-29T09:05:00.000Z" :
      state === "UNMET" ? DUE_AT : "2026-08-29T09:11:00.000Z");
  const hasConsequence = options.consequence ?? state === "MET";
  const satisfiedBy = state === "MET" ? "report-a" : null;

  await withTenantTransaction(pool, clinicId, async (client) => {
    await client.query(
      `INSERT INTO workflow
         (clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
       VALUES ($1, 'workflow-a', 'PATIENT', 'PAT-001', 'EYE_EXAM', $2,
         '2026-08-29T08:55:00Z', '2026-08-29T08:55:00Z')`,
      [clinicId, options.workflowStatus ?? "OPEN"],
    );
    if (options.insertTrigger !== false) {
      await client.query(
        `INSERT INTO artifact
           (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
            identity_anchor, payload, created_at)
         VALUES ($1, 'trigger-a', $2, $3, 'source', 'employee-a', $4, '{}', $3)`,
        [clinicId, options.triggerKind ?? "REGISTRATION", TRIGGERED_AT,
          options.triggerIdentity ?? "PAT-001"],
      );
      if (options.linkTrigger !== false) {
        await client.query(
          `INSERT INTO workflow_artifact_link
             (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
           VALUES ($1, 'link-trigger', 'workflow-a', 'trigger-a',
             '2026-08-29T09:00:01Z', 'DETERMINISTIC', '{exact_identity}')`,
          [clinicId],
        );
      }
    }
    if (hasConsequence) {
      await client.query(
        `INSERT INTO artifact
           (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
            identity_anchor, payload, created_at)
         VALUES ($1, 'report-a', $2, $3, 'source', 'employee-a', $4, '{}', $3)`,
        [clinicId, options.consequenceKind ?? "EXAM_REPORT",
          options.consequenceOccurredAt ?? "2026-08-29T09:10:00.000Z",
          options.consequenceIdentity ?? "PAT-001"],
      );
      if (options.linkConsequence !== false) {
        await client.query(
          `INSERT INTO workflow_artifact_link
             (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
           VALUES ($1, 'link-report', 'workflow-a', 'report-a', $2,
             'DETERMINISTIC', '{exact_identity}')`,
          [clinicId, options.consequenceAttachedAt ?? "2026-08-29T09:10:01.000Z"],
        );
      }
    }
    await client.query(
      `INSERT INTO expectation
         (clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
          due_at, state, satisfied_by_artifact_id, evaluated_at)
       VALUES ($1, 'expectation-a', 'workflow-a', 'REGISTRATION', 'EXAM_REPORT',
         $2, $3, $4, $5, $6)`,
      [clinicId, TRIGGERED_AT, DUE_AT, state, satisfiedBy, evaluatedAt],
    );
    await client.query(
      `INSERT INTO expectation_transition
         (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ($1, 'transition-a', 'expectation-a', 'workflow-a', NULL, $2, $3,
         'trigger-a', $4, $5)`,
      [clinicId, state, evaluatedAt, satisfiedBy,
        satisfiedBy ? ["trigger-a", satisfiedBy] : ["trigger-a"]],
    );
  });
}

async function countVerifications(pool: PGlitePoolShim): Promise<number> {
  const result = await pool.db.query<{ count: number }>("SELECT count(*)::int AS count FROM s2_verification");
  return result.rows[0].count;
}

test("MET exact chain persists VERIFIED and exact immutable lineage", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool);
    const output = await new VerificationRepository(pool).verifyCurrentExpectation(actor(), "expectation-a");
    assert.deepEqual(output.result, {
      workflowId: "workflow-a",
      expectationId: "expectation-a",
      status: "VERIFIED",
      reasonCodes: [],
      triggerArtifactId: "trigger-a",
      consequenceArtifactId: "report-a",
      evidenceArtifactIds: ["trigger-a", "report-a"],
      evaluatedAt: "2026-08-29T09:11:00.000Z",
    });
    assert.equal(output.record.verifierVersion, "S2_V1");
    assert.equal(output.record.sourceTransitionId, "transition-a");
    assert.equal(await countVerifications(pool), 1);
    await assert.rejects(pool.db.query("UPDATE s2_verification SET status = 'PENDING'"));
    await assert.rejects(pool.db.query("DELETE FROM s2_verification"));
  } finally {
    await pool.close();
  }
});

test("OPEN and UNMET projections persist deterministic PENDING reasons", async () => {
  for (const [state, reason] of [["OPEN", "CHAIN_OPEN"], ["UNMET", "CHAIN_UNMET"]] as const) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seedProjection(pool, { state });
      const output = await new VerificationRepository(pool).verifyCurrentExpectation(actor(), "expectation-a");
      assert.equal(output.result.status, "PENDING");
      assert.deepEqual(output.result.reasonCodes, [reason]);
      assert.deepEqual(output.result.evidenceArtifactIds, ["trigger-a"]);
    } finally {
      await pool.close();
    }
  }
});

test("identity, kind, time, and missing linked evidence persist CONFLICT", async () => {
  const cases: Array<[SeedOptions, string]> = [
    [{ consequenceIdentity: "PAT-OO1" }, "IDENTITY_CONFLICT"],
    [{ consequenceKind: "OTHER" }, "KIND_CONFLICT"],
    [{ consequenceOccurredAt: "2026-08-29T09:16:00.000Z" }, "TIME_CONFLICT"],
    [{ linkConsequence: false }, "CONSEQUENCE_NOT_FOUND"],
  ];
  for (const [options, reason] of cases) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seedProjection(pool, options);
      const output = await new VerificationRepository(pool).verifyCurrentExpectation(actor(), "expectation-a");
      assert.equal(output.result.status, "CONFLICT");
      assert.ok(output.result.reasonCodes.includes(reason));
    } finally {
      await pool.close();
    }
  }
});

test("only source-time-visible Links are evaluated", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool, { consequenceAttachedAt: "2026-08-29T09:12:00.000Z" });
    const output = await new VerificationRepository(pool).verifyCurrentExpectation(actor(), "expectation-a");
    assert.equal(output.result.status, "CONFLICT");
    assert.deepEqual(output.result.reasonCodes, ["CONSEQUENCE_NOT_FOUND"]);
    assert.deepEqual(output.result.evidenceArtifactIds, ["trigger-a"]);
  } finally {
    await pool.close();
  }
});

test("Artifact input order cannot change the stored result", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool);
    const repository = new VerificationRepository(pool);
    const first = await repository.verifyCurrentExpectation(actor(), "expectation-a");
    pool.reverseLinkedRows = true;
    assert.deepEqual(await repository.verifyCurrentExpectation(actor(), "expectation-a"), first);
    assert.equal(await countVerifications(pool), 1);
  } finally {
    await pool.close();
  }
});

test("source transition must match the current projection", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool, { state: "OPEN" });
    await pool.db.query(
      "UPDATE expectation SET state = 'UNMET', evaluated_at = '2026-08-29T09:15:00Z'",
    );
    await assert.rejects(
      new VerificationRepository(pool).verifyCurrentExpectation(actor(), "expectation-a"),
      (error: unknown) => error instanceof DomainError &&
        error.code === "VERIFICATION_SOURCE_TRANSITION_NOT_FOUND",
    );
    assert.equal(await countVerifications(pool), 0);
  } finally {
    await pool.close();
  }
});

test("missing and cross-clinic records fail closed", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool);
    const repository = new VerificationRepository(pool);
    await assert.rejects(
      repository.verifyCurrentExpectation(actor(), "missing"),
      (error: unknown) => error instanceof DomainError && error.code === "EXPECTATION_NOT_FOUND",
    );
    await assert.rejects(
      repository.verifyCurrentExpectation(actor("clinic-b"), "expectation-a"),
      (error: unknown) => error instanceof DomainError && error.code === "EXPECTATION_NOT_FOUND",
    );
    assert.equal(await countVerifications(pool), 0);
  } finally {
    await pool.close();
  }
});

test("missing Workflow, source transition, and malformed Link time fail closed", async () => {
  for (const mode of ["workflow", "transition", "link-time"] as const) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seedProjection(pool);
      if (mode === "workflow") pool.hideWorkflow = true;
      if (mode === "transition") pool.hideSourceTransition = true;
      if (mode === "link-time") pool.corruptLinkTime = true;
      await assert.rejects(
        new VerificationRepository(pool).verifyCurrentExpectation(actor(), "expectation-a"),
        (error: unknown) => error instanceof DomainError,
      );
      assert.equal(await countVerifications(pool), 0);
    } finally {
      await pool.close();
    }
  }
});

test("terminal Workflow permits exact replay but refuses a new Verification", async () => {
  const replayPool = new PGlitePoolShim();
  await replayPool.migrate();
  try {
    await seedProjection(replayPool);
    const repository = new VerificationRepository(replayPool);
    const first = await repository.verifyCurrentExpectation(actor(), "expectation-a");
    await replayPool.db.query("UPDATE workflow SET status = 'CLOSED'");
    const replay = await repository.verifyCurrentExpectation(actor(), "expectation-a");
    assert.deepEqual(replay, first);
    assert.equal(await countVerifications(replayPool), 1);
  } finally {
    await replayPool.close();
  }

  const newPool = new PGlitePoolShim();
  await newPool.migrate();
  try {
    await seedProjection(newPool, { workflowStatus: "CLOSED" });
    await assert.rejects(
      new VerificationRepository(newPool).verifyCurrentExpectation(actor(), "expectation-a"),
      (error: unknown) => error instanceof DomainError && error.code === "WORKFLOW_TERMINAL",
    );
    assert.equal(await countVerifications(newPool), 0);
  } finally {
    await newPool.close();
  }
});

test("replay is idempotent and backdated evidence cannot rewrite a verdict", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool, { state: "OPEN" });
    const repository = new VerificationRepository(pool);
    const first = await repository.verifyCurrentExpectation(actor(), "expectation-a");
    assert.deepEqual(await repository.verifyCurrentExpectation(actor(), "expectation-a"), first);
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(
        `INSERT INTO artifact
           (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
            identity_anchor, payload, created_at)
         VALUES ('clinic-a', 'late-report', 'EXAM_REPORT', '2026-08-29T09:04:00Z',
           'source', 'employee-a', 'PAT-001', '{}', '2026-08-29T09:06:00Z')`,
      );
      await client.query(
        `INSERT INTO workflow_artifact_link
           (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
         VALUES ('clinic-a', 'late-link', 'workflow-a', 'late-report',
           '2026-08-29T09:04:30Z', 'DETERMINISTIC', '{exact_identity}')`,
      );
    });
    await assert.rejects(
      repository.verifyCurrentExpectation(actor(), "expectation-a"),
      (error: unknown) => error instanceof DomainError && error.code === "S2_VERIFICATION_CONFLICT",
    );
    assert.equal(await countVerifications(pool), 1);
  } finally {
    await pool.close();
  }
});

test("insert and read failures roll back without a partial record", async () => {
  for (const mode of ["insert", "read"] as const) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seedProjection(pool);
      if (mode === "insert") pool.failOn = /INSERT INTO s2_verification/;
      else pool.failAfterInsertRead = true;
      await assert.rejects(
        new VerificationRepository(pool).verifyCurrentExpectation(actor(), "expectation-a"),
      );
      pool.failOn = null;
      pool.failAfterInsertRead = false;
      assert.equal(await countVerifications(pool), 0);
    } finally {
      await pool.close();
    }
  }
});

test("invalid caller input fails before acquisition and input is snapshotted", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    const repository = new VerificationRepository(pool);
    const before = pool.acquisitions;
    await assert.rejects(repository.verifyCurrentExpectation({} as ActorContext, "expectation-a"));
    await assert.rejects(repository.verifyCurrentExpectation(actor(), " "));
    assert.equal(pool.acquisitions, before);

    await seedProjection(pool);
    const context = actor();
    const pending = repository.verifyCurrentExpectation(context, "expectation-a");
    context.clinicId = "clinic-b";
    assert.equal((await pending).record.clinicId, "clinic-a");
  } finally {
    await pool.close();
  }
});

test("returned nested arrays are detached", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool);
    const repository = new VerificationRepository(pool);
    const first = await repository.verifyCurrentExpectation(actor(), "expectation-a");
    first.result.reasonCodes.push("MUTATED");
    first.record.evidenceArtifactIds.push("MUTATED");
    const replay = await repository.verifyCurrentExpectation(actor(), "expectation-a");
    assert.deepEqual(replay.result.reasonCodes, []);
    assert.deepEqual(replay.record.evidenceArtifactIds, ["trigger-a", "report-a"]);
  } finally {
    await pool.close();
  }
});

test("SQL rejects malformed verification shapes, duplicate identity, and cross-tenant lineage", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedProjection(pool);
    const base = `INSERT INTO s2_verification
      (clinic_id, id, workflow_id, expectation_id, source_transition_id,
       verifier_version, status, reason_codes, trigger_artifact_id,
       consequence_artifact_id, evidence_artifact_ids, evaluated_at)
      VALUES ('clinic-a', $1, 'workflow-a', 'expectation-a', 'transition-a',
        $2, $3, $4, $5, $6, $7, '2026-08-29T09:11:00Z')`;
    await assert.rejects(pool.db.query(base, [
      "bad-verified", "S2_V1", "VERIFIED", ["TIME_CONFLICT"],
      "trigger-a", "report-a", ["trigger-a", "report-a"],
    ]));
    await assert.rejects(pool.db.query(base, [
      "bad-conflict", "S2_V1", "CONFLICT", [], "trigger-a", null, ["trigger-a"],
    ]));
    await assert.rejects(pool.db.query(base, [
      "duplicate-evidence", "S2_V1", "PENDING", ["CHAIN_OPEN"],
      "trigger-a", null, ["trigger-a", "trigger-a"],
    ]));
    await assert.rejects(pool.db.query(base, [
      "duplicate-reason", "S2_V1", "PENDING", ["CHAIN_OPEN", "CHAIN_OPEN"],
      "trigger-a", null, ["trigger-a"],
    ]));
    await pool.db.query(base, [
      "valid", "S2_V1", "VERIFIED", [],
      "trigger-a", "report-a", ["trigger-a", "report-a"],
    ]);
    await assert.rejects(pool.db.query(base, [
      "duplicate-source-version", "S2_V1", "VERIFIED", [],
      "trigger-a", "report-a", ["trigger-a", "report-a"],
    ]));
    await assert.rejects(pool.db.query(
      `INSERT INTO s2_verification
        (clinic_id, id, workflow_id, expectation_id, source_transition_id,
         verifier_version, status, reason_codes, trigger_artifact_id,
         consequence_artifact_id, evidence_artifact_ids, evaluated_at)
       VALUES ('clinic-b', 'cross-tenant', 'workflow-a', 'expectation-a', 'transition-a',
         'S2_V1', 'VERIFIED', '{}', 'trigger-a', 'report-a',
         '{trigger-a,report-a}', '2026-08-29T09:11:00Z')`,
    ));
  } finally {
    await pool.close();
  }
});

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
import {
  ManagerDecisionRepository,
  type ManagerDecisionCommand,
} from "../src/persistence/manager-decision-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

const EVALUATED_AT = "2026-08-29T09:11:00.000Z";
const DECIDED_AT = "2026-08-29T09:12:00.000Z";

class PGlitePoolShim implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  failOn: RegExp | null = null;
  beforeConnect: (() => void) | null = null;

  async migrate(): Promise<void> {
    await applyMigrations(this.db, await loadRepositoryMigrations());
  }

  async connect(): Promise<DatabaseConnection> {
    this.acquisitions += 1;
    this.beforeConnect?.();
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<DatabaseQueryResult<Row>> => {
        if (this.failOn?.test(text)) throw new Error("FORCED_DATABASE_FAILURE");
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

const command = (
  action: ManagerDecisionCommand["action"],
  reasonCode: string | null = null,
): ManagerDecisionCommand => ({
  id: "decision-a",
  expectationId: "expectation-a",
  action,
  reasonCode,
  note: " reviewed ",
  decidedAt: DECIDED_AT,
});

async function seed(
  pool: DatabasePool,
  state: Exclude<Expectation["state"], "VOIDED">,
  options: { verification?: false | "PENDING" | "VERIFIED" | "CONFLICT"; futureLink?: boolean } = {},
): Promise<void> {
  const verification = options.verification ?? (state === "MET" ? "VERIFIED" : "PENDING");
  const report = state === "MET";
  const reasons = verification === "VERIFIED" ? [] :
    verification === "CONFLICT" ? ["IDENTITY_CONFLICT"] :
    [state === "UNMET" ? "CHAIN_UNMET" : "CHAIN_OPEN"];
  await withTenantTransaction(pool, "clinic-a", async (client) => {
    await client.query(`INSERT INTO workflow
      (clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
      VALUES ('clinic-a', 'workflow-a', 'PATIENT', 'PAT-001', 'EYE_EXAM', 'OPEN',
        '2026-08-29T08:55:00Z', '2026-08-29T08:55:00Z')`);
    await client.query(`INSERT INTO artifact
      (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
       identity_anchor, payload, created_at)
      VALUES ('clinic-a', 'trigger-a', 'REGISTRATION', '2026-08-29T09:00:00Z',
        'source', 'employee-a', 'PAT-001', '{}', '2026-08-29T09:00:00Z')`);
    await client.query(`INSERT INTO workflow_artifact_link
      (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
      VALUES ('clinic-a', 'link-trigger', 'workflow-a', 'trigger-a',
        '2026-08-29T09:00:01Z', 'DETERMINISTIC', '{exact_identity}')`);
    if (report) {
      await client.query(`INSERT INTO artifact
        (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
         identity_anchor, payload, created_at)
        VALUES ('clinic-a', 'report-a', 'EXAM_REPORT', '2026-08-29T09:10:00Z',
          'source', 'employee-a', 'PAT-001', '{}', '2026-08-29T09:10:00Z')`);
      await client.query(`INSERT INTO workflow_artifact_link
        (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
        VALUES ('clinic-a', 'link-report', 'workflow-a', 'report-a',
          '2026-08-29T09:10:01Z', 'DETERMINISTIC', '{exact_identity}')`);
    }
    if (options.futureLink) {
      await client.query(`INSERT INTO artifact
        (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
         identity_anchor, payload, created_at)
        VALUES ('clinic-a', 'future-a', 'NOTE', '2026-08-29T09:11:30Z',
          'source', 'employee-a', 'PAT-001', '{}', '2026-08-29T09:11:30Z')`);
      await client.query(`INSERT INTO workflow_artifact_link
        (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
        VALUES ('clinic-a', 'link-future', 'workflow-a', 'future-a',
          '2026-08-29T09:13:00Z', 'DETERMINISTIC', '{exact_identity}')`);
    }
    await client.query(`INSERT INTO expectation
      (clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
       due_at, state, satisfied_by_artifact_id, evaluated_at)
      VALUES ('clinic-a', 'expectation-a', 'workflow-a', 'REGISTRATION', 'EXAM_REPORT',
        '2026-08-29T09:00:00Z', '2026-08-29T09:15:00Z', $1, $2, $3)`,
      [state, report ? "report-a" : null, EVALUATED_AT]);
    await client.query(`INSERT INTO expectation_transition
      (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
       trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
      VALUES ('clinic-a', 'transition-a', 'expectation-a', 'workflow-a', NULL, $1, $2,
        'trigger-a', $3, $4)`,
      [state, EVALUATED_AT, report ? "report-a" : null,
        report ? ["trigger-a", "report-a"] : ["trigger-a"]]);
    if (verification !== false) {
      await client.query(`INSERT INTO s2_verification
        (clinic_id, id, workflow_id, expectation_id, source_transition_id, verifier_version,
         status, reason_codes, trigger_artifact_id, consequence_artifact_id,
         evidence_artifact_ids, evaluated_at)
        VALUES ('clinic-a', 'verification-a', 'workflow-a', 'expectation-a', 'transition-a',
          'S2_V1', $1, $2, 'trigger-a', $3, $4, $5)`,
        [verification, reasons, verification === "VERIFIED" ? "report-a" : null,
          verification === "VERIFIED" ? ["trigger-a", "report-a"] : ["trigger-a"], EVALUATED_AT]);
    }
  });
}

async function projections(pool: PGlitePoolShim): Promise<{
  workflow: string;
  expectation: string;
  decisions: number;
  transitions: number;
}> {
  const workflow = await pool.db.query<{ status: string }>("SELECT status FROM workflow");
  const expectation = await pool.db.query<{ state: string }>("SELECT state FROM expectation");
  const decisions = await pool.db.query<{ count: number }>("SELECT count(*)::int AS count FROM manager_decision");
  const transitions = await pool.db.query<{ count: number }>("SELECT count(*)::int AS count FROM expectation_transition");
  return {
    workflow: workflow.rows[0].status,
    expectation: expectation.rows[0].state,
    decisions: decisions.rows[0].count,
    transitions: transitions.rows[0].count,
  };
}

test("CLOSE_STANDARD persists the exact VERIFIED snapshot and closes Workflow", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seed(pool, "MET");
    const output = await new ManagerDecisionRepository(pool)
      .recordManagerDecision(manager(), command("CLOSE_STANDARD"));
    assert.equal(output.workflow.status, "CLOSED");
    assert.equal(output.expectation.state, "MET");
    assert.equal(output.decision.verificationId, "verification-a");
    assert.equal(output.decision.expectationState, "MET");
    assert.equal(output.decision.note, "reviewed");
    assert.deepEqual(output.decision.evidenceArtifactIds, ["trigger-a", "report-a"]);
    assert.deepEqual(await projections(pool), {
      workflow: "CLOSED", expectation: "MET", decisions: 1, transitions: 1,
    });
  } finally {
    await pool.close();
  }
});

test("CLOSE_STANDARD rejects non-MET or non-VERIFIED snapshots without writes", async () => {
  for (const [state, verification] of [["OPEN", "PENDING"], ["MET", "CONFLICT"]] as const) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seed(pool, state, { verification });
      await assert.rejects(
        new ManagerDecisionRepository(pool).recordManagerDecision(manager(), command("CLOSE_STANDARD")),
        (error: unknown) => error instanceof DomainError && error.code === "DECISION_NOT_ALLOWED",
      );
      assert.equal((await projections(pool)).decisions, 0);
    } finally {
      await pool.close();
    }
  }
});

test("CLOSE_EXCEPTION closes only reasoned UNMET while preserving its projection", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seed(pool, "UNMET");
    const output = await new ManagerDecisionRepository(pool).recordManagerDecision(
      manager(), command("CLOSE_EXCEPTION", "LEGITIMATE_DEVIATION"),
    );
    assert.equal(output.workflow.status, "CLOSED");
    assert.equal(output.expectation.state, "UNMET");
    assert.equal((await projections(pool)).transitions, 1);
  } finally {
    await pool.close();
  }
});

test("KEEP_OPEN supports OPEN and reasoned UNMET without hiding history", async () => {
  for (const state of ["OPEN", "UNMET"] as const) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seed(pool, state);
      const output = await new ManagerDecisionRepository(pool).recordManagerDecision(
        manager(), command("KEEP_OPEN", state === "UNMET" ? "NEEDS_MORE_EVIDENCE" : null),
      );
      assert.equal(output.workflow.status, "OPEN");
      assert.equal(output.workflow.updatedAt, DECIDED_AT);
      assert.equal(output.expectation.state, state);
    } finally {
      await pool.close();
    }
  }
});

test("VOID appends a HUMAN transition and atomically voids both projections", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seed(pool, "MET");
    const output = await new ManagerDecisionRepository(pool).recordManagerDecision(
      manager(), command("VOID", "PATIENT_CANCELLED"),
    );
    assert.equal(output.workflow.status, "VOIDED");
    assert.equal(output.expectation.state, "VOIDED");
    const transitions = await pool.db.query<{ source: string; from_state: string; to_state: string }>(
      "SELECT source, from_state, to_state FROM expectation_transition ORDER BY source",
    );
    assert.deepEqual(transitions.rows, [
      { source: "DETERMINISTIC", from_state: null, to_state: "MET" },
      { source: "HUMAN", from_state: "MET", to_state: "VOIDED" },
    ]);
  } finally {
    await pool.close();
  }
});

test("authority, strict input shape and timestamps fail before acquisition", async () => {
  const pool = new PGlitePoolShim();
  try {
    const repository = new ManagerDecisionRepository(pool);
    await assert.rejects(repository.recordManagerDecision(
      { ...manager(), role: "EMPLOYEE" }, command("KEEP_OPEN"),
    ));
    await assert.rejects(repository.recordManagerDecision(
      manager(), { ...command("KEEP_OPEN"), clinicId: "clinic-b" } as ManagerDecisionCommand,
    ));
    await assert.rejects(repository.recordManagerDecision(
      manager(), { ...command("KEEP_OPEN"), decidedAt: "2026-08-29T09:12:00" },
    ));
    assert.equal(pool.acquisitions, 0);
  } finally {
    await pool.close();
  }
});

test("wrong-clinic context and stale source projection fail without mutation", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seed(pool, "OPEN");
    const repository = new ManagerDecisionRepository(pool);
    await assert.rejects(
      repository.recordManagerDecision(manager("clinic-b"), command("KEEP_OPEN")),
      (error: unknown) => error instanceof DomainError && error.code === "EXPECTATION_NOT_FOUND",
    );
    await pool.db.query(`UPDATE expectation
      SET state = 'UNMET', evaluated_at = '2026-08-29T09:11:30Z'
      WHERE clinic_id = 'clinic-a' AND id = 'expectation-a'`);
    await assert.rejects(
      repository.recordManagerDecision(manager(), command("KEEP_OPEN", "NEEDS_MORE_EVIDENCE")),
      (error: unknown) => error instanceof DomainError &&
        error.code === "DECISION_SOURCE_TRANSITION_NOT_FOUND",
    );
    assert.equal((await projections(pool)).decisions, 0);
  } finally {
    await pool.close();
  }
});

test("altered MET satisfaction and incoherent VERIFIED evidence fail closed", async () => {
  for (const defect of ["projection", "verification"] as const) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seed(pool, "MET", { verification: defect === "projection" ? "VERIFIED" : false });
      await withTenantTransaction(pool, "clinic-a", async (client) => {
        await client.query(`INSERT INTO artifact
          (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
           identity_anchor, payload, created_at)
          VALUES ('clinic-a', 'report-b', 'EXAM_REPORT', '2026-08-29T09:10:30Z',
            'source', 'employee-a', 'PAT-001', '{}', '2026-08-29T09:10:30Z')`);
        if (defect === "projection") {
          await client.query(`UPDATE expectation SET satisfied_by_artifact_id = 'report-b'
            WHERE clinic_id = 'clinic-a' AND id = 'expectation-a'`);
        } else {
          await client.query(`INSERT INTO s2_verification
            (clinic_id, id, workflow_id, expectation_id, source_transition_id, verifier_version,
             status, reason_codes, trigger_artifact_id, consequence_artifact_id,
             evidence_artifact_ids, evaluated_at)
            VALUES ('clinic-a', 'verification-a', 'workflow-a', 'expectation-a', 'transition-a',
              'S2_V1', 'VERIFIED', '{}', 'trigger-a', 'report-b',
              '{trigger-a,report-b}', $1)`, [EVALUATED_AT]);
        }
      });
      await assert.rejects(
        new ManagerDecisionRepository(pool).recordManagerDecision(
          manager(), command("CLOSE_STANDARD"),
        ),
        (error: unknown) => error instanceof DomainError && error.code ===
          (defect === "projection"
            ? "DECISION_SOURCE_TRANSITION_NOT_FOUND"
            : "DECISION_VERIFICATION_MISMATCH"),
      );
      assert.equal((await projections(pool)).decisions, 0);
    } finally {
      await pool.close();
    }
  }
});

test("missing current Verification and decision before evaluation fail closed", async () => {
  for (const missing of [true, false]) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seed(pool, "OPEN", { verification: missing ? false : "PENDING" });
      await assert.rejects(
        new ManagerDecisionRepository(pool).recordManagerDecision(manager(), {
          ...command("KEEP_OPEN"),
          decidedAt: missing ? DECIDED_AT : "2026-08-29T09:10:59.999Z",
        }),
        (error: unknown) => error instanceof DomainError && error.code ===
          (missing ? "DECISION_VERIFICATION_NOT_FOUND" : "INVALID_DECISION_SNAPSHOT_TIME"),
      );
      assert.equal((await projections(pool)).decisions, 0);
    } finally {
      await pool.close();
    }
  }
});

test("decision lineage excludes Links not visible at decision time", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seed(pool, "OPEN", { futureLink: true });
    const output = await new ManagerDecisionRepository(pool)
      .recordManagerDecision(manager(), command("KEEP_OPEN"));
    assert.deepEqual(output.decision.evidenceArtifactIds, ["trigger-a"]);
  } finally {
    await pool.close();
  }
});

test("exact replay is idempotent after closure; conflict and later decisions fail", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seed(pool, "MET");
    const repository = new ManagerDecisionRepository(pool);
    const first = await repository.recordManagerDecision(manager(), command("CLOSE_STANDARD"));
    assert.deepEqual(await repository.recordManagerDecision(manager(), command("CLOSE_STANDARD")), first);
    await assert.rejects(repository.recordManagerDecision(manager(), {
      ...command("CLOSE_STANDARD"), note: "different",
    }), (error: unknown) => error instanceof DomainError && error.code === "DECISION_ID_CONFLICT");
    await assert.rejects(repository.recordManagerDecision(manager(), {
      ...command("CLOSE_STANDARD"), id: "decision-b",
    }), (error: unknown) => error instanceof DomainError && error.code === "WORKFLOW_TERMINAL");
    assert.equal((await projections(pool)).decisions, 1);
  } finally {
    await pool.close();
  }
});

test("decision and projection writes roll back together at every mutation stage", async () => {
  for (const failure of [
    /INSERT INTO manager_decision/,
    /INSERT INTO expectation_transition/,
    /UPDATE expectation SET/,
    /UPDATE workflow SET/,
  ]) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seed(pool, "OPEN");
      pool.failOn = failure;
      await assert.rejects(new ManagerDecisionRepository(pool).recordManagerDecision(
        manager(), command("VOID", "PATIENT_CANCELLED"),
      ));
      pool.failOn = null;
      assert.deepEqual(await projections(pool), {
        workflow: "OPEN", expectation: "OPEN", decisions: 0, transitions: 1,
      });
    } finally {
      await pool.close();
    }
  }
});

test("caller and returned mutations cannot change persisted authority or arrays", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seed(pool, "OPEN");
    const context = manager();
    const input = command("KEEP_OPEN");
    pool.beforeConnect = () => {
      context.clinicId = "clinic-b";
      input.action = "VOID";
    };
    const repository = new ManagerDecisionRepository(pool);
    const output = await repository.recordManagerDecision(context, input);
    output.decision.evidenceArtifactIds.push("forged");
    pool.beforeConnect = null;
    const replay = await repository.recordManagerDecision(manager(), command("KEEP_OPEN"));
    assert.equal(replay.decision.clinicId, "clinic-a");
    assert.equal(replay.decision.action, "KEEP_OPEN");
    assert.deepEqual(replay.decision.evidenceArtifactIds, ["trigger-a"]);
  } finally {
    await pool.close();
  }
});

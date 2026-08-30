import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext, Expectation } from "../src/domain/contracts.ts";
import type {
  DatabaseConnection, DatabasePool, DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import {
  ManagerClosureReadRepository,
} from "../src/persistence/manager-closure-read-repository.ts";
import {
  ManagerDecisionRepository, type ManagerDecisionCommand,
} from "../src/persistence/manager-decision-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

const EVALUATED_AT = "2026-08-29T09:11:00.000Z";

class PGlitePoolShim implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;
  beforeConnect: (() => void) | null = null;
  duplicateCurrentVerification = false;
  corruptWorkflowStatus = false;
  queries: Array<{ text: string; values: readonly unknown[] }> = [];

  async migrate(): Promise<void> {
    await applyMigrations(this.db, await loadRepositoryMigrations());
  }

  async connect(): Promise<DatabaseConnection> {
    this.acquisitions += 1;
    this.beforeConnect?.();
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string, values: readonly unknown[] = [],
      ): Promise<DatabaseQueryResult<Row>> => {
        this.queries.push({ text, values });
        const result = await this.db.query<Row>(text, values as unknown[]);
        if (this.corruptWorkflowStatus && /FROM workflow WHERE/.test(text) && result.rows[0]) {
          (result.rows[0] as Record<string, unknown>).status = "BROKEN";
        }
        if (this.duplicateCurrentVerification && /FROM s2_verification WHERE/.test(text) && result.rows[0]) {
          result.rows.push(structuredClone(result.rows[0]));
        }
        return { rows: result.rows };
      },
      release() {},
    };
  }

  async close(): Promise<void> { await this.db.close(); }
}

const manager = (clinicId = "clinic-a"): ActorContext => ({
  clinicId, actorId: "manager-a", role: "MANAGER",
});

type SeedOptions = {
  clinicId?: string;
  workflowId?: string;
  expectationId?: string;
  createdAt?: string;
  triggeredAt?: string;
  state?: Exclude<Expectation["state"], "VOIDED">;
  verification?: false | "PENDING" | "VERIFIED" | "CONFLICT";
  expectation?: boolean;
};

async function seed(pool: DatabasePool, options: SeedOptions = {}): Promise<void> {
  const clinic = options.clinicId ?? "clinic-a";
  const workflow = options.workflowId ?? "workflow-a";
  const expectation = options.expectationId ?? "expectation-a";
  const state = options.state ?? "OPEN";
  const verification = options.verification ?? (state === "MET" ? "VERIFIED" : "PENDING");
  const triggeredAt = options.triggeredAt ?? "2026-08-29T09:00:00.000Z";
  const report = state === "MET";
  const suffix = `${workflow}:${expectation}`;
  const triggerId = `trigger:${suffix}`;
  const reportId = `report:${suffix}`;
  const transitionId = `transition:${suffix}`;
  await withTenantTransaction(pool, clinic, async (client) => {
    await client.query(
      `INSERT INTO workflow
        (clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
       VALUES ($1, $2, 'PATIENT', $3, 'EYE_EXAM', 'OPEN', $4, $4)`,
      [clinic, workflow, `PAT-${workflow}`, options.createdAt ?? "2026-08-29T08:55:00.000Z"],
    );
    await client.query(
      `INSERT INTO artifact
        (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
         identity_anchor, payload, created_at)
       VALUES ($1, $2, 'REGISTRATION', $3, 'source', 'employee-secret', $4,
         '{"secret":"payload"}', $3)`,
      [clinic, triggerId, triggeredAt, `PAT-${workflow}`],
    );
    await client.query(
      `INSERT INTO workflow_artifact_link
        (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
       VALUES ($1, $2, $3, $4, $5, 'DETERMINISTIC', '{exact_identity}')`,
      [clinic, `link-trigger:${suffix}`, workflow, triggerId, "2026-08-29T09:00:01.000Z"],
    );
    if (report) {
      await client.query(
        `INSERT INTO artifact
          (clinic_id, id, kind, occurred_at, occurred_at_source, source_employee_id,
           identity_anchor, payload, created_at)
         VALUES ($1, $2, 'EXAM_REPORT', '2026-08-29T09:10:00Z', 'source',
           'employee-secret', $3, '{"fields":"secret"}', '2026-08-29T09:10:00Z')`,
        [clinic, reportId, `PAT-${workflow}`],
      );
      await client.query(
        `INSERT INTO workflow_artifact_link
          (clinic_id, id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
         VALUES ($1, $2, $3, $4, '2026-08-29T09:10:01Z',
           'DETERMINISTIC', '{exact_identity}')`,
        [clinic, `link-report:${suffix}`, workflow, reportId],
      );
    }
    if (options.expectation === false) return;
    await client.query(
      `INSERT INTO expectation
        (clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
         due_at, state, satisfied_by_artifact_id, evaluated_at)
       VALUES ($1, $2, $3, 'REGISTRATION', 'EXAM_REPORT', $4,
         '2026-08-29T09:15:00Z', $5, $6, $7)`,
      [clinic, expectation, workflow, triggeredAt, state, report ? reportId : null, EVALUATED_AT],
    );
    await client.query(
      `INSERT INTO expectation_transition
        (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
         trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)`,
      [clinic, transitionId, expectation, workflow, state, EVALUATED_AT, triggerId,
        report ? reportId : null, report ? [triggerId, reportId] : [triggerId]],
    );
    if (verification !== false) {
      const reasons = verification === "VERIFIED" ? [] :
        verification === "CONFLICT" ? ["IDENTITY_CONFLICT"] :
        [state === "UNMET" ? "CHAIN_UNMET" : "CHAIN_OPEN"];
      await client.query(
        `INSERT INTO s2_verification
          (clinic_id, id, workflow_id, expectation_id, source_transition_id,
           verifier_version, status, reason_codes, trigger_artifact_id,
           consequence_artifact_id, evidence_artifact_ids, evaluated_at)
         VALUES ($1, $2, $3, $4, $5, 'S2_V1', $6, $7, $8, $9, $10, $11)`,
        [clinic, `verification:${suffix}`, workflow, expectation, transitionId, verification,
          reasons, triggerId, verification === "VERIFIED" ? reportId : null,
          report ? [triggerId, reportId] : [triggerId], EVALUATED_AT],
      );
    }
  });
}

function decision(
  action: ManagerDecisionCommand["action"],
  reasonCode: string | null,
  id = "decision-a",
  decidedAt = "2026-08-29T09:12:00.000Z",
): ManagerDecisionCommand {
  return { id, expectationId: "expectation-a", action, reasonCode,
    note: "private decision note", decidedAt };
}

test("open OPEN/PENDING chain is quiet and exposes only safe fields", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seed(pool);
    const [item] = await new ManagerClosureReadRepository(pool).listManagerClosures(manager());
    assert.equal(item.needsReview, false);
    assert.deepEqual(item.reasonCodes, []);
    assert.equal(item.verificationStatus, "PENDING");
    assert.deepEqual(Object.keys(item).sort(), [
      "evidenceArtifactIds", "expectationId", "expectationState", "identityAnchor",
      "latestDecision", "needsReview", "reasonCodes", "verificationReasonCodes",
      "verificationStatus", "workflowFamily", "workflowId", "workflowStatus",
    ]);
    assert.doesNotMatch(JSON.stringify(item), /payload|fields|employee|conversation|note|actor/i);
  } finally { await pool.close(); }
});

test("UNMET and CONFLICT use the existing manager review projection", async () => {
  for (const [state, verification, reason] of [
    ["UNMET", "PENDING", "EXPECTATION_UNMET"],
    ["OPEN", "CONFLICT", "VERIFICATION_CONFLICT"],
  ] as const) {
    const pool = new PGlitePoolShim(); await pool.migrate();
    try {
      await seed(pool, { state, verification });
      const [item] = await new ManagerClosureReadRepository(pool).listManagerClosures(manager());
      assert.equal(item.needsReview, true);
      assert.deepEqual(item.reasonCodes, [reason]);
    } finally { await pool.close(); }
  }
});

test("standard and exception CLOSED chains use decision snapshots without review", async () => {
  for (const [state, action, reasonCode, status] of [
    ["MET", "CLOSE_STANDARD", null, "VERIFIED"],
    ["UNMET", "CLOSE_EXCEPTION", "LEGITIMATE_DEVIATION", "PENDING"],
  ] as const) {
    const pool = new PGlitePoolShim(); await pool.migrate();
    try {
      await seed(pool, { state });
      await new ManagerDecisionRepository(pool).recordManagerDecision(manager(), decision(action, reasonCode));
      const [item] = await new ManagerClosureReadRepository(pool).listManagerClosures(manager());
      assert.equal(item.workflowStatus, "CLOSED");
      assert.equal(item.verificationStatus, status);
      assert.equal(item.needsReview, false);
      assert.deepEqual(item.latestDecision, {
        action, reasonCode, decidedAt: "2026-08-29T09:12:00.000Z",
      });
    } finally { await pool.close(); }
  }
});

test("VOIDED uses effective VOIDED projection and its decision snapshot", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seed(pool, { state: "UNMET" });
    await new ManagerDecisionRepository(pool).recordManagerDecision(
      manager(), decision("VOID", "PATIENT_CANCELLED"),
    );
    const [item] = await new ManagerClosureReadRepository(pool).listManagerClosures(manager());
    assert.equal(item.workflowStatus, "VOIDED");
    assert.equal(item.expectationState, "VOIDED");
    assert.equal(item.verificationStatus, "PENDING");
    assert.equal(item.needsReview, false);
  } finally { await pool.close(); }
});

test("missing durable chain rows remain visible with controlled reasons", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seed(pool, { workflowId: "workflow-no-exp", expectation: false });
    await seed(pool, { workflowId: "workflow-no-ver", expectationId: "expectation-no-ver",
      verification: false, createdAt: "2026-08-29T08:56:00Z" });
    await seed(pool, { workflowId: "workflow-terminal", expectationId: "expectation-terminal",
      createdAt: "2026-08-29T08:57:00Z" });
    await pool.db.query("UPDATE workflow SET status = 'CLOSED' WHERE id = 'workflow-terminal'");
    const items = await new ManagerClosureReadRepository(pool).listManagerClosures(manager());
    assert.deepEqual(items.map((item) => item.reasonCodes), [
      ["EXPECTATION_MISSING"], ["VERIFICATION_MISSING"], ["TERMINAL_DECISION_MISSING"],
    ]);
  } finally { await pool.close(); }
});

test("future Verification is ignored and current missing Verification stays visible", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seed(pool, { verification: false });
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(`INSERT INTO expectation_transition
        (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
         trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
        VALUES ('clinic-a', 'transition-future', 'expectation-a', 'workflow-a', 'OPEN', 'OPEN',
          '2026-08-29T09:13:00Z', 'trigger:workflow-a:expectation-a', NULL,
          '{trigger:workflow-a:expectation-a}')`);
      await client.query(`INSERT INTO s2_verification
        (clinic_id, id, workflow_id, expectation_id, source_transition_id, verifier_version,
         status, reason_codes, trigger_artifact_id, consequence_artifact_id,
         evidence_artifact_ids, evaluated_at)
        VALUES ('clinic-a', 'verification-future', 'workflow-a', 'expectation-a',
          'transition-future', 'S2_V1', 'PENDING', '{CHAIN_OPEN}',
          'trigger:workflow-a:expectation-a', NULL, '{trigger:workflow-a:expectation-a}',
          '2026-08-29T09:13:00Z')`);
    });
    const [item] = await new ManagerClosureReadRepository(pool).listManagerClosures(manager());
    assert.equal(item.verificationStatus, null);
    assert.deepEqual(item.reasonCodes, ["VERIFICATION_MISSING"]);
  } finally { await pool.close(); }
});

test("workflow, expectation, evidence and latest-decision ordering is deterministic", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seed(pool, { workflowId: "workflow-z", expectationId: "expectation-z",
      createdAt: "2026-08-29T08:56:00Z" });
    await seed(pool, { workflowId: "workflow-a", expectationId: "expectation-a",
      createdAt: "2026-08-29T08:55:00Z" });
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(`INSERT INTO expectation
        (clinic_id, id, workflow_id, trigger_kind, consequence_kind, triggered_at,
         due_at, state, satisfied_by_artifact_id, evaluated_at)
        VALUES ('clinic-a', 'expectation-b', 'workflow-a', 'REGISTRATION', 'EXAM_REPORT',
          '2026-08-29T09:00:00Z', '2026-08-29T09:15:00Z', 'OPEN', NULL, $1)`, [EVALUATED_AT]);
      await client.query(`INSERT INTO expectation_transition
        (clinic_id, id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
         trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
        VALUES ('clinic-a', 'transition-b', 'expectation-b', 'workflow-a', NULL, 'OPEN', $1,
          'trigger:workflow-a:expectation-a', NULL, '{trigger:workflow-a:expectation-a}')`,
      [EVALUATED_AT]);
      await client.query(`INSERT INTO s2_verification
        (clinic_id, id, workflow_id, expectation_id, source_transition_id, verifier_version,
         status, reason_codes, trigger_artifact_id, consequence_artifact_id,
         evidence_artifact_ids, evaluated_at)
        VALUES ('clinic-a', 'verification-b', 'workflow-a', 'expectation-b', 'transition-b',
          'S2_V1', 'PENDING', '{CHAIN_OPEN}', 'trigger:workflow-a:expectation-a', NULL,
          '{trigger:workflow-a:expectation-a}', $1)`, [EVALUATED_AT]);
    });
    const decisions = new ManagerDecisionRepository(pool);
    await decisions.recordManagerDecision(manager(), decision("KEEP_OPEN", null, "decision-a"));
    await decisions.recordManagerDecision(manager(), decision(
      "KEEP_OPEN", null, "decision-z", "2026-08-29T09:13:00.000Z",
    ));
    await decisions.recordManagerDecision(manager(), decision(
      "KEEP_OPEN", "NEEDS_MORE_EVIDENCE", "decision-zz", "2026-08-29T09:13:00.000Z",
    ));
    const items = await new ManagerClosureReadRepository(pool).listManagerClosures(manager());
    assert.deepEqual(items.map((item) => [item.workflowId, item.expectationId]), [
      ["workflow-a", "expectation-a"], ["workflow-a", "expectation-b"],
      ["workflow-z", "expectation-z"],
    ]);
    assert.equal(items[0].latestDecision?.action, "KEEP_OPEN");
    assert.equal(items[0].latestDecision?.decidedAt, "2026-08-29T09:13:00.000Z");
    assert.equal(items[0].latestDecision?.reasonCode, "NEEDS_MORE_EVIDENCE");
    assert.deepEqual(items[0].evidenceArtifactIds, ["trigger:workflow-a:expectation-a"]);
  } finally { await pool.close(); }
});

test("invalid or employee context fails before acquisition and authority is snapshotted", async () => {
  const pool = new PGlitePoolShim();
  try {
    const repository = new ManagerClosureReadRepository(pool);
    await assert.rejects(repository.listManagerClosures({ ...manager(), role: "EMPLOYEE" }));
    await assert.rejects(repository.listManagerClosures({ ...manager(), clinicId: "" }));
    assert.equal(pool.acquisitions, 0);
    await pool.migrate(); await seed(pool);
    const context = manager();
    pool.beforeConnect = () => { context.clinicId = "clinic-b"; context.role = "EMPLOYEE"; };
    assert.equal((await repository.listManagerClosures(context)).length, 1);
  } finally { await pool.close(); }
});

test("cross-clinic identical IDs stay isolated and injection text remains bound", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seed(pool, { clinicId: "clinic-a" });
    await seed(pool, { clinicId: "clinic-b" });
    assert.equal((await new ManagerClosureReadRepository(pool).listManagerClosures(manager("clinic-a"))).length, 1);
    const injected = "clinic-a' OR 1=1 --";
    pool.queries.length = 0;
    assert.deepEqual(await new ManagerClosureReadRepository(pool).listManagerClosures(manager(injected)), []);
    assert.ok(pool.queries.filter(({ text }) => /WHERE clinic_id = \$1/.test(text))
      .every(({ text, values }) => !text.includes(injected) && values[0] === injected));
  } finally { await pool.close(); }
});

test("returned objects are detached from stored data", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seed(pool);
    const repository = new ManagerClosureReadRepository(pool);
    const first = await repository.listManagerClosures(manager());
    first[0].reasonCodes.push("FAKE"); first[0].evidenceArtifactIds.push("FAKE");
    const second = await repository.listManagerClosures(manager());
    assert.deepEqual(second[0].reasonCodes, []);
    assert.deepEqual(second[0].evidenceArtifactIds, ["trigger:workflow-a:expectation-a"]);
  } finally { await pool.close(); }
});

test("malformed rows and duplicate current Verification identities fail closed", async () => {
  for (const mode of ["malformed", "duplicate"] as const) {
    const pool = new PGlitePoolShim(); await pool.migrate();
    try {
      await seed(pool);
      if (mode === "malformed") pool.corruptWorkflowStatus = true;
      else pool.duplicateCurrentVerification = true;
      await assert.rejects(new ManagerClosureReadRepository(pool).listManagerClosures(manager()),
        /Stored manager closure data is malformed/);
    } finally { await pool.close(); }
  }
});

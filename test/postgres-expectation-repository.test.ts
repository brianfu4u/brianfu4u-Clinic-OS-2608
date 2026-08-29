import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext, ExpectationSpec, Workflow } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import { ExpectationRepository } from "../src/persistence/expectation-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";

const TRIGGERED_AT = "2026-08-29T09:00:00.000Z";
const DUE_AT = "2026-08-29T09:15:00.000Z";
const BEFORE_DUE = "2026-08-29T09:05:00.000Z";

class PGlitePoolShim implements DatabasePool {
  readonly db = new PGlite();
  acquisitions = 0;

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

const actor = (clinicId = "clinic-a"): ActorContext => ({
  clinicId,
  actorId: "employee-a",
  role: "EMPLOYEE",
});

function spec(id = "expectation-a", overrides: Partial<ExpectationSpec> = {}): ExpectationSpec {
  return {
    id,
    triggerKind: "REGISTRATION",
    consequenceKind: "EXAM_REPORT",
    triggeredAt: TRIGGERED_AT,
    dueAt: DUE_AT,
    ...overrides,
  };
}

function workflow(id = "workflow-a", clinicId = "clinic-a", status: Workflow["status"] = "OPEN"): Workflow {
  return {
    id,
    clinicId,
    subjectType: "PATIENT",
    identityAnchor: " PAT-001 ",
    workflowFamily: "EYE_EXAM",
    status,
    createdAt: "2026-08-29T08:55:00.000Z",
    updatedAt: "2026-08-29T08:55:00.000Z",
  };
}

async function seedWorkflow(pool: DatabasePool, input: Workflow): Promise<void> {
  await withTenantTransaction(pool, input.clinicId, async (client) => {
    await client.query(
      `INSERT INTO workflow
         (id, clinic_id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.id, input.clinicId, input.subjectType, input.identityAnchor,
        input.workflowFamily, input.status, input.createdAt, input.updatedAt,
      ],
    );
  });
}

async function seedArtifact(
  pool: DatabasePool,
  input: {
    id: string;
    clinicId?: string;
    kind?: string;
    occurredAt?: string;
    identityAnchor?: string | null;
  },
): Promise<void> {
  const clinicId = input.clinicId ?? "clinic-a";
  await withTenantTransaction(pool, clinicId, async (client) => {
    await client.query(
      `INSERT INTO artifact
         (id, clinic_id, kind, occurred_at, occurred_at_source, source_employee_id,
          identity_anchor, payload, created_at)
       VALUES ($1, $2, $3, $4, 'source', 'employee-a', $5, '{}', $6)`,
      [
        input.id,
        clinicId,
        input.kind ?? "REGISTRATION",
        input.occurredAt ?? TRIGGERED_AT,
        input.identityAnchor === undefined ? " PAT-001 " : input.identityAnchor,
        input.occurredAt ?? TRIGGERED_AT,
      ],
    );
  });
}

async function seedLink(
  pool: DatabasePool,
  workflowId: string,
  artifactId: string,
  attachedAt = "2026-08-29T09:00:01.000Z",
  clinicId = "clinic-a",
): Promise<void> {
  await withTenantTransaction(pool, clinicId, async (client) => {
    await client.query(
      `INSERT INTO workflow_artifact_link
         (id, clinic_id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
       VALUES ($1, $2, $3, $4, $5, 'DETERMINISTIC', '{exact_identity}')`,
      [`link:${workflowId}:${artifactId}`, clinicId, workflowId, artifactId, attachedAt],
    );
  });
}

async function seedTrigger(
  pool: DatabasePool,
  workflowId = "workflow-a",
  artifactId = "trigger-a",
  clinicId = "clinic-a",
): Promise<void> {
  await seedArtifact(pool, { id: artifactId, clinicId });
  await seedLink(pool, workflowId, artifactId, "2026-08-29T09:00:01.000Z", clinicId);
}

async function countRows(pool: PGlitePoolShim): Promise<{ expectations: number; transitions: number }> {
  const result = await pool.db.query<{ expectations: number; transitions: number }>(
    `SELECT (SELECT count(*)::int FROM expectation) AS expectations,
            (SELECT count(*)::int FROM expectation_transition) AS transitions`,
  );
  return result.rows[0];
}

test("valid trigger initializes OPEN with immutable evidence lineage", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const result = await new ExpectationRepository(pool).initializeExpectation(
      actor(), "workflow-a", spec(), BEFORE_DUE,
    );
    assert.equal(result.expectation.state, "OPEN");
    assert.equal(result.expectation.satisfiedByArtifactId, null);
    assert.deepEqual(result.transition, {
      id: "transition:init:clinic-a:expectation-a",
      clinicId: "clinic-a",
      expectationId: "expectation-a",
      workflowId: "workflow-a",
      fromState: null,
      toState: "OPEN",
      evaluatedAt: BEFORE_DUE,
      triggerArtifactId: "trigger-a",
      satisfiedByArtifactId: null,
      evidenceArtifactIds: ["trigger-a"],
    });
  } finally {
    await pool.close();
  }
});

test("already-linked in-window consequence initializes MET with exact lineage", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await seedArtifact(pool, {
      id: "report-a",
      kind: "EXAM_REPORT",
      occurredAt: "2026-08-29T09:10:00.000Z",
    });
    await seedLink(pool, "workflow-a", "report-a", "2026-08-29T09:10:01.000Z");
    const result = await new ExpectationRepository(pool).initializeExpectation(
      actor(), "workflow-a", spec(), "2026-08-29T09:11:00.000Z",
    );
    assert.equal(result.expectation.state, "MET");
    assert.equal(result.expectation.satisfiedByArtifactId, "report-a");
    assert.deepEqual(result.transition.evidenceArtifactIds, ["trigger-a", "report-a"]);
    assert.equal(result.transition.satisfiedByArtifactId, "report-a");
  } finally {
    await pool.close();
  }
});

test("due boundary without consequence initializes UNMET", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const result = await new ExpectationRepository(pool).initializeExpectation(
      actor(), "workflow-a", spec(), DUE_AT,
    );
    assert.equal(result.expectation.state, "UNMET");
    assert.equal(result.transition.toState, "UNMET");
    assert.deepEqual(result.transition.evidenceArtifactIds, ["trigger-a"]);
  } finally {
    await pool.close();
  }
});

test("consequence before trigger or after evaluation cannot initialize MET", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await seedArtifact(pool, {
      id: "report-before",
      kind: "EXAM_REPORT",
      occurredAt: "2026-08-29T08:59:59.000Z",
    });
    await seedLink(pool, "workflow-a", "report-before");
    await seedArtifact(pool, {
      id: "report-future",
      kind: "EXAM_REPORT",
      occurredAt: "2026-08-29T09:10:00.000Z",
    });
    await seedLink(pool, "workflow-a", "report-future");
    await seedArtifact(pool, {
      id: "report-near-identity",
      kind: "EXAM_REPORT",
      occurredAt: "2026-08-29T09:03:00.000Z",
      identityAnchor: "PAT-001",
    });
    await seedLink(pool, "workflow-a", "report-near-identity");
    const result = await new ExpectationRepository(pool).initializeExpectation(
      actor(), "workflow-a", spec(), BEFORE_DUE,
    );
    assert.equal(result.expectation.state, "OPEN");
    assert.equal(result.transition.satisfiedByArtifactId, null);
  } finally {
    await pool.close();
  }
});

test("missing, wrong-kind, near-identity or unlinked trigger fails without writes", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    for (const id of ["missing", "wrong-kind", "near-identity", "unlinked"]) {
      await seedWorkflow(pool, workflow(`workflow-${id}`));
    }
    await seedArtifact(pool, { id: "wrong-trigger", kind: "EXAM_REPORT" });
    await seedLink(pool, "workflow-wrong-kind", "wrong-trigger");
    await seedArtifact(pool, { id: "near-trigger", identityAnchor: "PAT-001" });
    await seedLink(pool, "workflow-near-identity", "near-trigger");
    await seedArtifact(pool, { id: "unlinked-trigger" });

    for (const id of ["missing", "wrong-kind", "near-identity", "unlinked"]) {
      await assert.rejects(
        repository.initializeExpectation(
          actor(), `workflow-${id}`, spec(`expectation-${id}`), BEFORE_DUE,
        ),
        hasCode("EXPECTATION_TRIGGER_NOT_FOUND"),
      );
    }
    assert.deepEqual(await countRows(pool), { expectations: 0, transitions: 0 });
  } finally {
    await pool.close();
  }
});

test("missing, terminal and cross-clinic Workflow fails closed", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow("workflow-closed", "clinic-a", "CLOSED"));
    await seedWorkflow(pool, workflow("workflow-voided", "clinic-a", "VOIDED"));
    await seedWorkflow(pool, workflow("workflow-b", "clinic-b"));
    await assert.rejects(
      repository.initializeExpectation(actor(), "missing", spec(), BEFORE_DUE),
      hasCode("WORKFLOW_NOT_FOUND"),
    );
    for (const id of ["workflow-closed", "workflow-voided"]) {
      await assert.rejects(
        repository.initializeExpectation(actor(), id, spec(), BEFORE_DUE),
        hasCode("WORKFLOW_TERMINAL"),
      );
    }
    await assert.rejects(
      repository.initializeExpectation(actor(), "workflow-b", spec(), BEFORE_DUE),
      hasCode("WORKFLOW_NOT_FOUND"),
    );
    assert.deepEqual(await countRows(pool), { expectations: 0, transitions: 0 });
  } finally {
    await pool.close();
  }
});

test("invalid Expectation inputs fail before acquisition", async () => {
  const pool = new PGlitePoolShim();
  const repository = new ExpectationRepository(pool);
  try {
    const invalidTimes = [
      { triggeredAt: "2026-08-29" },
      { dueAt: "2026-08-29T09:15:00" },
      { triggeredAt: "2026-02-30T09:00:00Z" },
      { dueAt: "0000-01-01T09:15:00Z" },
      { dueAt: "2026-08-29T09:15:00.1234Z" },
      { triggeredAt: DUE_AT, dueAt: TRIGGERED_AT },
    ];
    for (const overrides of invalidTimes) {
      await assert.rejects(
        repository.initializeExpectation(actor(), "workflow-a", spec("expectation-a", overrides), BEFORE_DUE),
        hasCode("INVALID_EXPECTATION_TIME"),
      );
    }
    await assert.rejects(
      repository.initializeExpectation(actor(), "workflow-a", spec(), "2026-08-29T08:59:00.000Z"),
      hasCode("INVALID_EXPECTATION_TIME"),
    );
    await assert.rejects(
      repository.initializeExpectation(actor(), "", spec(), BEFORE_DUE),
      hasCode("WORKFLOW_ID_REQUIRED"),
    );
    assert.equal(pool.acquisitions, 0);
  } finally {
    await pool.close();
  }
});

test("caller authority and verdict fields are rejected before acquisition", async () => {
  const pool = new PGlitePoolShim();
  const repository = new ExpectationRepository(pool);
  try {
    for (const extra of [
      { state: "MET" },
      { satisfiedByArtifactId: "forged" },
      { transitionId: "forged" },
      { evidenceArtifactIds: ["forged"] },
      { workflowId: "forged" },
      { clinicId: "forged" },
      { voided: false },
    ]) {
      await assert.rejects(
        repository.initializeExpectation(
          actor(), "workflow-a", { ...spec(), ...extra } as never, BEFORE_DUE,
        ),
        hasCode("INVALID_EXPECTATION_SPEC"),
      );
    }
    assert.equal(pool.acquisitions, 0);
  } finally {
    await pool.close();
  }
});

test("exact replay is idempotent and later projection state is not overwritten", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const first = await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    assert.deepEqual(
      await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE),
      first,
    );
    await pool.db.query(
      "UPDATE expectation SET state = 'UNMET', evaluated_at = $1 WHERE clinic_id = $2 AND id = $3",
      [DUE_AT, "clinic-a", "expectation-a"],
    );
    const replay = await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    assert.equal(replay.expectation.state, "UNMET");
    assert.equal(replay.transition.toState, "OPEN");
    assert.deepEqual(await countRows(pool), { expectations: 1, transitions: 1 });
  } finally {
    await pool.close();
  }
});

test("Expectation and transition ID conflicts fail without mutation", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    await seedWorkflow(pool, workflow("workflow-b"));
    await seedTrigger(pool, "workflow-b", "trigger-b");
    await assert.rejects(
      repository.initializeExpectation(actor(), "workflow-b", spec(), BEFORE_DUE),
      hasCode("EXPECTATION_ID_CONFLICT"),
    );

    await seedWorkflow(pool, workflow("workflow-c"));
    await seedTrigger(pool, "workflow-c", "trigger-c");
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(
        `INSERT INTO expectation
           (id, clinic_id, workflow_id, trigger_kind, consequence_kind, triggered_at,
            due_at, state, satisfied_by_artifact_id, evaluated_at)
         VALUES ('expectation-c', 'clinic-a', 'workflow-c', 'REGISTRATION', 'EXAM_REPORT',
           $1, $2, 'OPEN', NULL, $3)`,
        [TRIGGERED_AT, DUE_AT, BEFORE_DUE],
      );
      await client.query(
        `INSERT INTO expectation_transition
           (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
            trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
         VALUES ($1, 'clinic-a', 'expectation-c', 'workflow-c', NULL, 'UNMET', $2,
           'trigger-c', NULL, '{trigger-c}')`,
        ["transition:init:clinic-a:expectation-c", BEFORE_DUE],
      );
    });
    await assert.rejects(
      repository.initializeExpectation(
        actor(), "workflow-c", spec("expectation-c"), BEFORE_DUE,
      ),
      hasCode("EXPECTATION_TRANSITION_ID_CONFLICT"),
    );
    assert.deepEqual(await countRows(pool), { expectations: 2, transitions: 2 });
  } finally {
    await pool.close();
  }
});

test("forced transition failure rolls back a newly inserted Expectation", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const baseConnect = pool.connect.bind(pool);
    const failingPool: DatabasePool = {
      async connect() {
        const connection = await baseConnect();
        return {
          query: (text, values) => text.trimStart().startsWith("INSERT INTO expectation_transition")
            ? Promise.reject(new Error("forced transition failure"))
            : connection.query(text, values),
          release: () => connection.release(),
        };
      },
    };
    await assert.rejects(
      new ExpectationRepository(failingPool).initializeExpectation(
        actor(), "workflow-a", spec(), BEFORE_DUE,
      ),
      /forced transition failure/,
    );
    assert.deepEqual(await countRows(pool), { expectations: 0, transitions: 0 });
  } finally {
    await pool.close();
  }
});

test("transition is append-only with fail-closed tenant foreign keys and RLS", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await new ExpectationRepository(pool).initializeExpectation(
      actor(), "workflow-a", spec(), BEFORE_DUE,
    );
    await assert.rejects(pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ('second-init', 'clinic-a', 'expectation-a', 'workflow-a', NULL, 'OPEN', $1,
         'trigger-a', NULL, '{trigger-a}')`,
      [BEFORE_DUE],
    ));
    await pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ('future-transition', 'clinic-a', 'expectation-a', 'workflow-a', 'OPEN', 'UNMET', $1,
         'trigger-a', NULL, '{trigger-a}')`,
      [DUE_AT],
    );
    await assert.rejects(pool.db.query(
      "UPDATE expectation_transition SET to_state = 'OPEN' WHERE id = 'future-transition'",
    ));
    await assert.rejects(pool.db.query(
      "DELETE FROM expectation_transition WHERE id = 'future-transition'",
    ));
    await assert.rejects(pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ('cross', 'clinic-b', 'expectation-a', 'workflow-a', NULL, 'OPEN', $1,
         'trigger-a', NULL, '{trigger-a}')`,
      [BEFORE_DUE],
    ));
    await seedWorkflow(pool, workflow("workflow-other"));
    await assert.rejects(pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ('wrong-workflow', 'clinic-a', 'expectation-a', 'workflow-other', NULL, 'OPEN', $1,
         'trigger-a', NULL, '{trigger-a}')`,
      [BEFORE_DUE],
    ));
    await assert.rejects(pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ('bad-from', 'clinic-a', 'expectation-a', 'workflow-a', 'INVALID', 'OPEN', $1,
         'trigger-a', NULL, '{trigger-a}')`,
      [BEFORE_DUE],
    ));
    await assert.rejects(pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ('empty-evidence', 'clinic-a', 'expectation-a', 'workflow-a', NULL, 'OPEN', $1,
         'trigger-a', NULL, '{}')`,
      [BEFORE_DUE],
    ));
    await assert.rejects(pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ('met-without-result', 'clinic-a', 'expectation-a', 'workflow-a', NULL, 'MET', $1,
         'trigger-a', NULL, '{trigger-a}')`,
      [BEFORE_DUE],
    ));
    const flags = await pool.db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname = 'expectation_transition'`,
    );
    assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    const policy = await pool.db.query<{ qual: string; with_check: string }>(
      `SELECT qual, with_check FROM pg_policies WHERE tablename = 'expectation_transition'`,
    );
    assert.match(policy.rows[0].qual, /current_setting\('app\.clinic_id'/);
    assert.match(policy.rows[0].with_check, /current_setting\('app\.clinic_id'/);
  } finally {
    await pool.close();
  }
});

test("caller mutation during acquisition cannot alter persisted values", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => resume = resolve);
    const baseConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      await gate;
      return baseConnect();
    };
    const context = actor();
    const input = spec();
    const pending = new ExpectationRepository(pool).initializeExpectation(
      context, "workflow-a", input, BEFORE_DUE,
    );
    context.clinicId = "clinic-mutated";
    input.triggerKind = "MUTATED";
    resume();
    const result = await pending;
    assert.equal(result.expectation.clinicId, "clinic-a");
    assert.equal(result.expectation.triggerKind, "REGISTRATION");
  } finally {
    await pool.close();
  }
});

test("returned transition evidence arrays are detached", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const first = await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    first.transition.evidenceArtifactIds.push("mutated");
    const replay = await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    assert.deepEqual(replay.transition.evidenceArtifactIds, ["trigger-a"]);
  } finally {
    await pool.close();
  }
});

test("re-evaluation records OPEN, UNMET, late UNMET, and recovery MET history", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);

    const stillOpen = await repository.reevaluateExpectation(
      actor(), "expectation-a", "2026-08-29T09:06:00.000Z",
    );
    assert.equal(stillOpen.expectation.state, "OPEN");
    assert.equal(stillOpen.transition?.fromState, "OPEN");
    assert.equal(stillOpen.transition?.toState, "OPEN");

    const unmet = await repository.reevaluateExpectation(actor(), "expectation-a", DUE_AT);
    assert.equal(unmet.expectation.state, "UNMET");
    assert.equal(unmet.transition?.fromState, "OPEN");
    assert.equal(unmet.transition?.toState, "UNMET");

    const stillUnmet = await repository.reevaluateExpectation(
      actor(), "expectation-a", "2026-08-29T09:16:00.000Z",
    );
    assert.equal(stillUnmet.transition?.fromState, "UNMET");
    assert.equal(stillUnmet.transition?.toState, "UNMET");

    await seedArtifact(pool, {
      id: "report-late-link",
      kind: "EXAM_REPORT",
      occurredAt: "2026-08-29T09:10:00.000Z",
    });
    await seedLink(
      pool, "workflow-a", "report-late-link", "2026-08-29T09:17:00.000Z",
    );
    const recovered = await repository.reevaluateExpectation(
      actor(), "expectation-a", "2026-08-29T09:18:00.000Z",
    );
    assert.equal(recovered.expectation.state, "MET");
    assert.equal(recovered.expectation.satisfiedByArtifactId, "report-late-link");
    assert.equal(recovered.transition?.fromState, "UNMET");
    assert.equal(recovered.transition?.toState, "MET");
    assert.deepEqual(
      recovered.transition?.evidenceArtifactIds,
      ["trigger-a", "report-late-link"],
    );

    const history = await pool.db.query<{ from_state: string | null; to_state: string }>(
      `SELECT from_state, to_state FROM expectation_transition
       WHERE clinic_id = 'clinic-a' AND expectation_id = 'expectation-a'
       ORDER BY evaluated_at`,
    );
    assert.deepEqual(history.rows, [
      { from_state: null, to_state: "OPEN" },
      { from_state: "OPEN", to_state: "OPEN" },
      { from_state: "OPEN", to_state: "UNMET" },
      { from_state: "UNMET", to_state: "UNMET" },
      { from_state: "UNMET", to_state: "MET" },
    ]);
  } finally {
    await pool.close();
  }
});

test("visible in-window consequence performs OPEN to MET", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const repository = new ExpectationRepository(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    await seedArtifact(pool, {
      id: "report-a",
      kind: "EXAM_REPORT",
      occurredAt: "2026-08-29T09:10:00.000Z",
    });
    await seedLink(pool, "workflow-a", "report-a", "2026-08-29T09:10:01.000Z");
    const result = await repository.reevaluateExpectation(
      actor(), "expectation-a", "2026-08-29T09:11:00.000Z",
    );
    assert.equal(result.expectation.state, "MET");
    assert.equal(result.transition?.fromState, "OPEN");
    assert.equal(result.transition?.satisfiedByArtifactId, "report-a");
  } finally {
    await pool.close();
  }
});

test("invalidly timed, hidden-link, and near-identity evidence cannot satisfy", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const repository = new ExpectationRepository(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    const cases = [
      ["report-before", "2026-08-29T08:59:59.000Z", "2026-08-29T09:10:00.000Z", " PAT-001 "],
      ["report-after-due", "2026-08-29T09:15:00.001Z", "2026-08-29T09:16:00.000Z", " PAT-001 "],
      ["report-future", "2026-08-29T09:30:00.000Z", "2026-08-29T09:10:00.000Z", " PAT-001 "],
      ["report-hidden-link", "2026-08-29T09:10:00.000Z", "2026-08-29T09:21:00.000Z", " PAT-001 "],
      ["report-near", "2026-08-29T09:10:00.000Z", "2026-08-29T09:10:00.000Z", "PAT-001"],
    ] as const;
    for (const [id, occurredAt, attachedAt, identityAnchor] of cases) {
      await seedArtifact(pool, { id, kind: "EXAM_REPORT", occurredAt, identityAnchor });
      await seedLink(pool, "workflow-a", id, attachedAt);
    }
    const result = await repository.reevaluateExpectation(
      actor(), "expectation-a", "2026-08-29T09:20:00.000Z",
    );
    assert.equal(result.expectation.state, "UNMET");
    assert.equal(result.expectation.satisfiedByArtifactId, null);
    assert.deepEqual(result.transition?.evidenceArtifactIds, ["trigger-a"]);
  } finally {
    await pool.close();
  }
});

test("stale time fails and same-time replay is an idempotent no-op", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    const repository = new ExpectationRepository(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    const first = await repository.reevaluateExpectation(
      actor(), "expectation-a", "2026-08-29T09:06:00.000Z",
    );
    const replay = await repository.reevaluateExpectation(
      actor(), "expectation-a", "2026-08-29T10:06:00.000+01:00",
    );
    assert.equal(replay.transition, null);
    assert.deepEqual(replay.expectation, first.expectation);
    await assert.rejects(
      repository.reevaluateExpectation(actor(), "expectation-a", BEFORE_DUE),
      hasCode("EXPECTATION_EVALUATION_STALE"),
    );
    assert.deepEqual(await countRows(pool), { expectations: 1, transitions: 2 });
  } finally {
    await pool.close();
  }
});

test("MET and VOIDED are automatic terminal states", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow("workflow-met"));
    await seedTrigger(pool, "workflow-met", "trigger-met");
    await seedArtifact(pool, {
      id: "report-met", kind: "EXAM_REPORT", occurredAt: "2026-08-29T09:10:00.000Z",
    });
    await seedLink(pool, "workflow-met", "report-met", "2026-08-29T09:10:01.000Z");
    const met = await repository.initializeExpectation(
      actor(), "workflow-met", spec("expectation-met"), "2026-08-29T09:11:00.000Z",
    );
    const metReplay = await repository.reevaluateExpectation(
      actor(), "expectation-met", "2026-08-29T09:20:00.000Z",
    );
    assert.equal(metReplay.transition, null);
    assert.deepEqual(metReplay.expectation, met.expectation);

    await seedWorkflow(pool, workflow("workflow-void"));
    await seedTrigger(pool, "workflow-void", "trigger-void");
    await repository.initializeExpectation(
      actor(), "workflow-void", spec("expectation-void"), BEFORE_DUE,
    );
    await pool.db.query(
      `UPDATE expectation SET state = 'VOIDED', evaluated_at = $1
       WHERE clinic_id = 'clinic-a' AND id = 'expectation-void'`,
      ["2026-08-29T09:07:00.000Z"],
    );
    const voided = await repository.reevaluateExpectation(
      actor(), "expectation-void", "2026-08-29T09:20:00.000Z",
    );
    assert.equal(voided.expectation.state, "VOIDED");
    assert.equal(voided.transition, null);
  } finally {
    await pool.close();
  }
});

test("missing and cross-clinic Expectation or terminal Workflow fail closed", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await assert.rejects(
      repository.reevaluateExpectation(actor(), "missing", DUE_AT),
      hasCode("EXPECTATION_NOT_FOUND"),
    );
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    await assert.rejects(
      repository.reevaluateExpectation(actor("clinic-b"), "expectation-a", DUE_AT),
      hasCode("EXPECTATION_NOT_FOUND"),
    );
    await pool.db.query(
      "UPDATE workflow SET status = 'CLOSED' WHERE clinic_id = 'clinic-a' AND id = 'workflow-a'",
    );
    await assert.rejects(
      repository.reevaluateExpectation(actor(), "expectation-a", DUE_AT),
      hasCode("WORKFLOW_TERMINAL"),
    );
  } finally {
    await pool.close();
  }
});

test("missing or non-visible initialization trigger fails closed", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow());
    await seedArtifact(pool, { id: "trigger-a" });
    await seedLink(pool, "workflow-a", "trigger-a", "2026-08-29T09:30:00.000Z");
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(
        `INSERT INTO expectation
           (id, clinic_id, workflow_id, trigger_kind, consequence_kind, triggered_at,
            due_at, state, satisfied_by_artifact_id, evaluated_at)
         VALUES ('expectation-a', 'clinic-a', 'workflow-a', 'REGISTRATION',
           'EXAM_REPORT', $1, $2, 'OPEN', NULL, $3)`,
        [TRIGGERED_AT, DUE_AT, BEFORE_DUE],
      );
      await client.query(
        `INSERT INTO expectation_transition
           (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
            trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
         VALUES ('transition:init:clinic-a:expectation-a', 'clinic-a', 'expectation-a',
           'workflow-a', NULL, 'OPEN', $1, 'trigger-a', NULL, '{trigger-a}')`,
        [BEFORE_DUE],
      );
    });
    await assert.rejects(
      repository.reevaluateExpectation(actor(), "expectation-a", DUE_AT),
      hasCode("EXPECTATION_TRIGGER_NOT_FOUND"),
    );

    await seedWorkflow(pool, workflow("workflow-no-init"));
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(
        `INSERT INTO expectation
           (id, clinic_id, workflow_id, trigger_kind, consequence_kind, triggered_at,
            due_at, state, satisfied_by_artifact_id, evaluated_at)
         VALUES ('expectation-no-init', 'clinic-a', 'workflow-no-init', 'REGISTRATION',
           'EXAM_REPORT', $1, $2, 'OPEN', NULL, $3)`,
        [TRIGGERED_AT, DUE_AT, BEFORE_DUE],
      );
    });
    await assert.rejects(
      repository.reevaluateExpectation(actor(), "expectation-no-init", DUE_AT),
      hasCode("EXPECTATION_INITIALIZATION_NOT_FOUND"),
    );
  } finally {
    await pool.close();
  }
});

test("invalid re-evaluation inputs fail before acquisition", async () => {
  const pool = new PGlitePoolShim();
  const repository = new ExpectationRepository(pool);
  try {
    for (const value of ["", "2026-08-29", "2026-08-29T09:15:00", "2026-02-30T09:00:00Z"]) {
      await assert.rejects(
        repository.reevaluateExpectation(actor(), "expectation-a", value),
        hasCode("INVALID_EXPECTATION_TIME"),
      );
    }
    await assert.rejects(
      repository.reevaluateExpectation(actor(), " ", DUE_AT),
      hasCode("EXPECTATION_ID_REQUIRED"),
    );
    assert.equal(pool.acquisitions, 0);
  } finally {
    await pool.close();
  }
});

test("deterministic transition conflict leaves projection unchanged", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    const evaluatedAt = "2026-08-29T09:06:00.000Z";
    await pool.db.query(
      `INSERT INTO expectation_transition
         (id, clinic_id, expectation_id, workflow_id, from_state, to_state, evaluated_at,
          trigger_artifact_id, satisfied_by_artifact_id, evidence_artifact_ids)
       VALUES ($1, 'clinic-a', 'expectation-a', 'workflow-a', 'OPEN', 'UNMET', $2,
         'trigger-a', NULL, '{trigger-a}')`,
      [`transition:eval:clinic-a:expectation-a:${evaluatedAt}`, evaluatedAt],
    );
    await assert.rejects(
      repository.reevaluateExpectation(actor(), "expectation-a", evaluatedAt),
      hasCode("EXPECTATION_TRANSITION_ID_CONFLICT"),
    );
    const projection = await pool.db.query<{ state: string; evaluated_at: Date | string }>(
      "SELECT state, evaluated_at FROM expectation WHERE clinic_id = 'clinic-a' AND id = 'expectation-a'",
    );
    assert.equal(projection.rows[0].state, "OPEN");
    assert.equal(new Date(projection.rows[0].evaluated_at).toISOString(), BEFORE_DUE);
  } finally {
    await pool.close();
  }
});

test("re-evaluation transition and projection failures roll back atomically", async () => {
  for (const failPrefix of ["INSERT INTO expectation_transition", "UPDATE expectation"]) {
    const pool = new PGlitePoolShim();
    await pool.migrate();
    try {
      await seedWorkflow(pool, workflow());
      await seedTrigger(pool);
      await new ExpectationRepository(pool).initializeExpectation(
        actor(), "workflow-a", spec(), BEFORE_DUE,
      );
      const baseConnect = pool.connect.bind(pool);
      const failingPool: DatabasePool = {
        async connect() {
          const connection = await baseConnect();
          return {
            query: (text, values) => text.trimStart().startsWith(failPrefix)
              ? Promise.reject(new Error(`forced ${failPrefix}`))
              : connection.query(text, values),
            release: () => connection.release(),
          };
        },
      };
      await assert.rejects(
        new ExpectationRepository(failingPool).reevaluateExpectation(
          actor(), "expectation-a", DUE_AT,
        ),
        /forced/,
      );
      const projection = await pool.db.query<{ state: string }>(
        "SELECT state FROM expectation WHERE clinic_id = 'clinic-a' AND id = 'expectation-a'",
      );
      assert.equal(projection.rows[0].state, "OPEN");
      assert.deepEqual(await countRows(pool), { expectations: 1, transitions: 1 });
    } finally {
      await pool.close();
    }
  }
});

test("re-evaluation snapshots context and returns detached evidence", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new ExpectationRepository(pool);
  try {
    await seedWorkflow(pool, workflow());
    await seedTrigger(pool);
    await repository.initializeExpectation(actor(), "workflow-a", spec(), BEFORE_DUE);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => resume = resolve);
    const baseConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      await gate;
      return baseConnect();
    };
    const context = actor();
    const pending = repository.reevaluateExpectation(context, "expectation-a", DUE_AT);
    context.clinicId = "clinic-mutated";
    resume();
    const result = await pending;
    assert.equal(result.expectation.clinicId, "clinic-a");
    result.transition?.evidenceArtifactIds.push("mutated");
    const replay = await repository.reevaluateExpectation(actor(), "expectation-a", DUE_AT);
    assert.equal(replay.transition, null);
    const stored = await pool.db.query<{ evidence_artifact_ids: string[] }>(
      `SELECT evidence_artifact_ids FROM expectation_transition
       WHERE clinic_id = 'clinic-a' AND expectation_id = 'expectation-a' AND from_state = 'OPEN'`,
    );
    assert.deepEqual(stored.rows[0].evidence_artifact_ids, ["trigger-a"]);
  } finally {
    await pool.close();
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

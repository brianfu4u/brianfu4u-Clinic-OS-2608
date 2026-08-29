import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { ActorContext, Artifact, EvidenceFactCard, Workflow } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { CaptureRepository } from "../src/persistence/capture-repository.ts";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";
import { WorkflowAttachRepository } from "../src/persistence/workflow-attach-repository.ts";

const ATTACHED_AT = "2026-08-29T09:05:00.000Z";

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

function capture(
  clinicId = "clinic-a",
  artifactId = "artifact-a",
  factCardId = "fact-a",
): { artifact: Artifact; factCard: EvidenceFactCard } {
  return {
    artifact: {
      id: artifactId,
      clinicId,
      kind: "REGISTRATION",
      occurredAt: "2026-08-29T09:00:00.000Z",
      occurredAtSource: "source",
      sourceEmployeeId: "employee-a",
      identityAnchor: " PAT-001 ",
      payload: { source: "scan" },
      createdAt: "2026-08-29T09:00:01.000Z",
    },
    factCard: {
      id: factCardId,
      clinicId,
      artifactId,
      subjectType: "PATIENT",
      identityAnchor: " PAT-001 ",
      workflowFamily: "EYE_EXAM",
      occurredAt: "2026-08-29T09:00:00.000Z",
      fields: { registration: true },
      missingFields: ["exam_report"],
      confidence: 0.9,
      parserVersion: "parser-1",
      lineageArtifactIds: [artifactId],
    },
  };
}

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "workflow-existing",
    clinicId: "clinic-a",
    subjectType: "PATIENT",
    identityAnchor: " PAT-001 ",
    workflowFamily: "EYE_EXAM",
    status: "OPEN",
    createdAt: "2026-08-29T08:00:00.000Z",
    updatedAt: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

async function seedCapture(
  pool: DatabasePool,
  input = capture(),
): Promise<{ artifact: Artifact; factCard: EvidenceFactCard }> {
  await new CaptureRepository(pool).saveCapture(actor(input.artifact.clinicId), input.artifact, input.factCard);
  return input;
}

async function seedWorkflow(pool: DatabasePool, input: Workflow): Promise<void> {
  await withTenantTransaction(pool, input.clinicId, async (client) => {
    await client.query(
      `INSERT INTO workflow
         (id, clinic_id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.id,
        input.clinicId,
        input.subjectType,
        input.identityAnchor,
        input.workflowFamily,
        input.status,
        input.createdAt,
        input.updatedAt,
      ],
    );
  });
}

async function countRows(pool: PGlitePoolShim): Promise<{ workflows: number; links: number }> {
  const result = await pool.db.query<{ workflows: number; links: number }>(
    `SELECT (SELECT count(*)::int FROM workflow) AS workflows,
            (SELECT count(*)::int FROM workflow_artifact_link) AS links`,
  );
  return result.rows[0];
}

test("exact existing Workflow attaches and round-trips authoritative Link", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    await seedWorkflow(pool, workflow());
    const result = await new WorkflowAttachRepository(pool).attachCapture(
      actor(), "artifact-a", "fact-a", ATTACHED_AT,
    );
    assert.deepEqual(result.resolution, { kind: "ATTACH_EXISTING", workflowId: "workflow-existing" });
    assert.equal(result.workflow.id, "workflow-existing");
    assert.deepEqual(result.link, {
      id: "link:workflow-existing:artifact-a",
      clinicId: "clinic-a",
      workflowId: "workflow-existing",
      artifactId: "artifact-a",
      attachedAt: ATTACHED_AT,
      decisionSource: "DETERMINISTIC",
      reasoningChain: ["exact_clinic", "exact_subject", "exact_identity", "exact_workflow_family"],
    });
  } finally {
    await pool.close();
  }
});

test("zero candidates creates Workflow and Link atomically", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    const result = await new WorkflowAttachRepository(pool).attachCapture(
      actor(), "artifact-a", "fact-a", ATTACHED_AT,
    );
    assert.deepEqual(result.resolution, { kind: "CREATE_NEW" });
    assert.equal(result.workflow.id, "wf:clinic-a:artifact-a");
    assert.equal(result.link.id, "link:wf:clinic-a:artifact-a:artifact-a");
    assert.deepEqual(await countRows(pool), { workflows: 1, links: 1 });
  } finally {
    await pool.close();
  }
});

test("two exact candidates return sorted review-required and write nothing", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    await seedWorkflow(pool, workflow({ id: "workflow-z" }));
    await seedWorkflow(pool, workflow({ id: "workflow-a" }));
    const result = await new WorkflowAttachRepository(pool).attachCapture(
      actor(), "artifact-a", "fact-a", ATTACHED_AT,
    );
    assert.deepEqual(result, {
      resolution: { kind: "REVIEW_REQUIRED", candidateWorkflowIds: ["workflow-a", "workflow-z"] },
      workflow: null,
      link: null,
    });
    assert.deepEqual(await countRows(pool), { workflows: 2, links: 0 });
  } finally {
    await pool.close();
  }
});

test("near-miss identity, subject and family never attach", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    await seedWorkflow(pool, workflow({ id: "identity-near", identityAnchor: "PAT-001" }));
    await seedWorkflow(pool, workflow({ id: "subject-near", subjectType: "DEVICE" }));
    await seedWorkflow(pool, workflow({ id: "family-near", workflowFamily: "OTHER" }));
    const result = await new WorkflowAttachRepository(pool).attachCapture(
      actor(), "artifact-a", "fact-a", ATTACHED_AT,
    );
    assert.equal(result.resolution.kind, "CREATE_NEW");
    assert.equal(result.workflow.id, "wf:clinic-a:artifact-a");
    assert.equal((await pool.db.query("SELECT 1 FROM workflow_artifact_link WHERE workflow_id <> 'wf:clinic-a:artifact-a'")).rows.length, 0);
  } finally {
    await pool.close();
  }
});

test("invalid caller inputs fail before acquisition", async () => {
  const pool = new PGlitePoolShim();
  const repository = new WorkflowAttachRepository(pool);
  try {
    await assert.rejects(repository.attachCapture(actor(), "", "fact-a", ATTACHED_AT), hasCode("ARTIFACT_ID_REQUIRED"));
    await assert.rejects(repository.attachCapture(actor(), "artifact-a", "", ATTACHED_AT), hasCode("FACT_CARD_ID_REQUIRED"));
    for (const invalidTime of [
      "not-a-time",
      "2026-08-29",
      "2026-08-29T09:05:00",
      "2026-02-30T09:05:00Z",
      "2026-08-29T24:05:00Z",
      "2026-08-29T09:05:00+15:00",
      "2026-08-29T09:05:00+14:01",
    ]) {
      await assert.rejects(
        repository.attachCapture(actor(), "artifact-a", "fact-a", invalidTime),
        hasCode("INVALID_ATTACHED_AT"),
      );
    }
    await assert.rejects(
      repository.attachCapture({ ...actor(), role: "SYSTEM" as never }, "artifact-a", "fact-a", ATTACHED_AT),
      hasCode("INVALID_ACTOR_CONTEXT"),
    );
    assert.equal(pool.acquisitions, 0);
  } finally {
    await pool.close();
  }
});

test("candidate query locks exact Workflow rows before resolution", async () => {
  const source = await readFile(
    new URL("../src/persistence/workflow-attach-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /FROM workflow[\s\S]+status = 'OPEN'[\s\S]+ORDER BY id\s+FOR UPDATE/,
  );
});

test("explicit ISO timestamp with offset is accepted", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    const result = await new WorkflowAttachRepository(pool).attachCapture(
      actor(), "artifact-a", "fact-a", "2026-08-29T18:05:00+09:00",
    );
    assert.equal(result.resolution.kind, "CREATE_NEW");
    assert.equal(Date.parse(result.link.attachedAt), Date.parse(ATTACHED_AT));
  } finally {
    await pool.close();
  }
});

test("missing or rewritten patient identity fails closed", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new WorkflowAttachRepository(pool);
  try {
    const missing = capture();
    missing.artifact.identityAnchor = null;
    missing.factCard.identityAnchor = null;
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(
        `INSERT INTO artifact
           (id, clinic_id, kind, occurred_at, occurred_at_source, source_employee_id,
            identity_anchor, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          missing.artifact.id, missing.artifact.clinicId, missing.artifact.kind,
          missing.artifact.occurredAt, missing.artifact.occurredAtSource,
          missing.artifact.sourceEmployeeId, missing.artifact.identityAnchor,
          missing.artifact.payload, missing.artifact.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO evidence_fact_card
           (id, clinic_id, artifact_id, subject_type, identity_anchor, workflow_family,
            occurred_at, fields, missing_fields, confidence, parser_version, lineage_artifact_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          missing.factCard.id, missing.factCard.clinicId, missing.factCard.artifactId,
          missing.factCard.subjectType, missing.factCard.identityAnchor,
          missing.factCard.workflowFamily, missing.factCard.occurredAt, missing.factCard.fields,
          missing.factCard.missingFields, missing.factCard.confidence,
          missing.factCard.parserVersion, missing.factCard.lineageArtifactIds,
        ],
      );
    });
    await assert.rejects(
      repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT),
      hasCode("IDENTITY_ANCHOR_REQUIRED"),
    );

    const valid = capture("clinic-a", "artifact-b", "fact-b");
    await seedCapture(pool, valid);
    await pool.db.query(
      "UPDATE evidence_fact_card SET identity_anchor = 'PAT-REWRITTEN' WHERE clinic_id = $1 AND id = $2",
      ["clinic-a", "fact-b"],
    );
    await assert.rejects(
      repository.attachCapture(actor(), "artifact-b", "fact-b", ATTACHED_AT),
      hasCode("IDENTITY_ANCHOR_MISMATCH"),
    );
    assert.deepEqual(await countRows(pool), { workflows: 0, links: 0 });
  } finally {
    await pool.close();
  }
});

test("cross-clinic records and Workflows remain invisible", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new WorkflowAttachRepository(pool);
  try {
    await seedCapture(pool, capture("clinic-b", "artifact-b", "fact-b"));
    await seedWorkflow(pool, workflow({ clinicId: "clinic-b", id: "workflow-b" }));
    await assert.rejects(
      repository.attachCapture(actor("clinic-a"), "artifact-b", "fact-b", ATTACHED_AT),
      hasCode("ARTIFACT_NOT_FOUND"),
    );
    await seedCapture(pool);
    const local = await repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT);
    assert.equal(local.resolution.kind, "CREATE_NEW");
    assert.equal(local.workflow.id, "wf:clinic-a:artifact-a");
    assert.deepEqual(await countRows(pool), { workflows: 2, links: 1 });
  } finally {
    await pool.close();
  }
});

test("missing Artifact or FactCard fails without writes", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new WorkflowAttachRepository(pool);
  try {
    await assert.rejects(
      repository.attachCapture(actor(), "missing", "missing", ATTACHED_AT),
      hasCode("ARTIFACT_NOT_FOUND"),
    );
    await seedCapture(pool);
    await assert.rejects(
      repository.attachCapture(actor(), "artifact-a", "missing", ATTACHED_AT),
      hasCode("FACT_CARD_NOT_FOUND"),
    );
    assert.deepEqual(await countRows(pool), { workflows: 0, links: 0 });
  } finally {
    await pool.close();
  }
});

test("malformed stored lineage fails closed", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    const baseConnect = pool.connect.bind(pool);
    const tamperedPool: DatabasePool = {
      async connect() {
        const connection = await baseConnect();
        return {
          query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
            const result = await connection.query<Row>(text, values);
            if (text.includes("FROM evidence_fact_card") && result.rows[0]) {
              return { rows: [{ ...result.rows[0], lineage_artifact_ids: [] } as Row] };
            }
            return result;
          },
          release: () => connection.release(),
        };
      },
    };
    await assert.rejects(
      new WorkflowAttachRepository(tamperedPool).attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT),
      hasCode("FACT_CARD_LINEAGE_INVALID"),
    );
    assert.deepEqual(await countRows(pool), { workflows: 0, links: 0 });
  } finally {
    await pool.close();
  }
});

test("same replay is idempotent and conflicting attachedAt fails without duplicates", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new WorkflowAttachRepository(pool);
  try {
    await seedCapture(pool);
    const first = await repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT);
    assert.deepEqual(await repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT), first);
    await assert.rejects(
      repository.attachCapture(actor(), "artifact-a", "fact-a", "2026-08-29T09:06:00.000Z"),
      hasCode("LINK_ID_CONFLICT"),
    );
    assert.deepEqual(await countRows(pool), { workflows: 1, links: 1 });
  } finally {
    await pool.close();
  }
});

test("preexisting exact deterministic-ID Workflow has stable first and replay resolution", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new WorkflowAttachRepository(pool);
  try {
    await seedCapture(pool);
    await seedWorkflow(pool, workflow({ id: "wf:clinic-a:artifact-a" }));
    const first = await repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT);
    const replay = await repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT);
    assert.deepEqual(first.resolution, { kind: "CREATE_NEW" });
    assert.deepEqual(replay, first);
    assert.deepEqual(await countRows(pool), { workflows: 1, links: 1 });
  } finally {
    await pool.close();
  }
});

test("deterministic Workflow ID conflict fails without mutation", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    await seedWorkflow(pool, workflow({
      id: "wf:clinic-a:artifact-a",
      identityAnchor: "PAT-DIFFERENT",
    }));
    await assert.rejects(
      new WorkflowAttachRepository(pool).attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT),
      hasCode("WORKFLOW_ID_CONFLICT"),
    );
    assert.deepEqual(await countRows(pool), { workflows: 1, links: 0 });
  } finally {
    await pool.close();
  }
});

test("existing different-Workflow Link blocks a second attach", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    const wrong = workflow({ id: "workflow-wrong", identityAnchor: "PAT-DIFFERENT" });
    await seedWorkflow(pool, wrong);
    await withTenantTransaction(pool, "clinic-a", async (client) => {
      await client.query(
        `INSERT INTO workflow_artifact_link
           (id, clinic_id, workflow_id, artifact_id, attached_at, decision_source, reasoning_chain)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["link-wrong", "clinic-a", wrong.id, "artifact-a", ATTACHED_AT, "HUMAN", ["manual"]],
      );
    });
    await assert.rejects(
      new WorkflowAttachRepository(pool).attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT),
      hasCode("ARTIFACT_ALREADY_LINKED"),
    );
    assert.deepEqual(await countRows(pool), { workflows: 1, links: 1 });
  } finally {
    await pool.close();
  }
});

test("SQL injection and extra authority fields remain inert bound data", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    const injection = "x'); DROP TABLE workflow; --";
    await seedCapture(pool, capture(injection, injection, injection));
    const context = { ...actor(injection), workflowId: "forged", decisionSource: "HUMAN" };
    const result = await new WorkflowAttachRepository(pool).attachCapture(
      context, injection, injection, ATTACHED_AT,
    );
    assert.equal(result.workflow.clinicId, injection);
    assert.equal(result.link.decisionSource, "DETERMINISTIC");
    assert.equal((await pool.db.query("SELECT 1 FROM pg_tables WHERE tablename = 'workflow'")).rows.length, 1);
  } finally {
    await pool.close();
  }
});

test("failed Link insert rolls back a newly created Workflow", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    const baseConnect = pool.connect.bind(pool);
    const failingPool: DatabasePool = {
      async connect() {
        const connection = await baseConnect();
        return {
          query: (text, values) => {
            if (text.trimStart().startsWith("INSERT INTO workflow_artifact_link")) {
              return Promise.reject(new Error("forced link failure"));
            }
            return connection.query(text, values);
          },
          release: () => connection.release(),
        };
      },
    };
    await assert.rejects(
      new WorkflowAttachRepository(failingPool).attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT),
      /forced link failure/,
    );
    assert.deepEqual(await countRows(pool), { workflows: 0, links: 0 });
  } finally {
    await pool.close();
  }
});

test("caller mutation during acquisition cannot change persisted values", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  try {
    await seedCapture(pool);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => resume = resolve);
    const baseConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      await gate;
      return baseConnect();
    };
    const context = actor();
    const pending = new WorkflowAttachRepository(pool).attachCapture(
      context, "artifact-a", "fact-a", ATTACHED_AT,
    );
    context.clinicId = "clinic-mutated";
    resume();
    const result = await pending;
    assert.equal(result.workflow.clinicId, "clinic-a");
    assert.equal(result.link.attachedAt, ATTACHED_AT);
  } finally {
    await pool.close();
  }
});

test("returned Workflow and Link values are detached", async () => {
  const pool = new PGlitePoolShim();
  await pool.migrate();
  const repository = new WorkflowAttachRepository(pool);
  try {
    await seedCapture(pool);
    const first = await repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT);
    first.workflow.identityAnchor = "mutated";
    first.link.reasoningChain.push("mutated");
    const replay = await repository.attachCapture(actor(), "artifact-a", "fact-a", ATTACHED_AT);
    assert.equal(replay.workflow.identityAnchor, " PAT-001 ");
    assert.deepEqual(replay.link.reasoningChain, [
      "exact_clinic", "exact_subject", "exact_identity", "exact_workflow_family",
    ]);
  } finally {
    await pool.close();
  }
});

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DomainError && error.code === code;
}

import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PersistedGoldenPath } from "../src/application/persisted-golden-path.ts";
import type {
  ActorContext,
  Artifact,
  EvidenceFactCard,
  ExpectationSpec,
  Workflow,
} from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { CaptureRepository } from "../src/persistence/capture-repository.ts";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "../src/persistence/database-contracts.ts";
import { ExpectationRepository } from "../src/persistence/expectation-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { withTenantTransaction } from "../src/persistence/tenant-transaction.ts";
import { VerificationRepository } from "../src/persistence/verification-repository.ts";
import { WorkflowAttachRepository } from "../src/persistence/workflow-attach-repository.ts";

const TRIGGERED_AT = "2026-08-30T09:00:00.000Z";
const DUE_AT = "2026-08-30T09:15:00.000Z";
const TRIGGER_ATTACHED_AT = "2026-08-30T09:00:01.000Z";
const TRIGGER_EVALUATED_AT = "2026-08-30T09:05:00.000Z";
const RESULT_OCCURRED_AT = "2026-08-30T09:10:00.000Z";
const RESULT_ATTACHED_AT = "2026-08-30T09:10:01.000Z";
const RESULT_EVALUATED_AT = "2026-08-30T09:11:00.000Z";

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

function structuredCapture(options: {
  clinicId?: string;
  artifactId?: string;
  factCardId?: string;
  identity?: string;
  kind?: string;
  occurredAt?: string;
} = {}): { artifact: Artifact; factCard: EvidenceFactCard } {
  const clinicId = options.clinicId ?? "clinic-a";
  const artifactId = options.artifactId ?? "trigger-a";
  const identity = options.identity ?? "PAT-001";
  const kind = options.kind ?? "REGISTRATION";
  const occurredAt = options.occurredAt ?? TRIGGERED_AT;
  return {
    artifact: {
      id: artifactId,
      clinicId,
      kind,
      occurredAt,
      occurredAtSource: "source",
      sourceEmployeeId: "employee-a",
      identityAnchor: identity,
      payload: { source: kind === "REGISTRATION" ? "scanner" : "device" },
      createdAt: occurredAt,
    },
    factCard: {
      id: options.factCardId ?? `fact-${artifactId}`,
      clinicId,
      artifactId,
      subjectType: "PATIENT",
      identityAnchor: identity,
      workflowFamily: "EYE_EXAM",
      occurredAt,
      fields: { kind },
      missingFields: [],
      confidence: 1,
      parserVersion: "fixture-v1",
      lineageArtifactIds: [artifactId],
    },
  };
}

function triggerCommand(options: { identity?: string; suffix?: string } = {}) {
  const suffix = options.suffix ?? "a";
  const capture = structuredCapture({
    artifactId: `trigger-${suffix}`,
    factCardId: `fact-trigger-${suffix}`,
    identity: options.identity,
  });
  return {
    ...capture,
    expectation: {
      id: `expectation-${suffix}`,
      triggerKind: "REGISTRATION",
      consequenceKind: "EXAM_REPORT",
      triggeredAt: TRIGGERED_AT,
      dueAt: DUE_AT,
    } satisfies Omit<ExpectationSpec, "voided">,
    attachedAt: TRIGGER_ATTACHED_AT,
    evaluatedAt: TRIGGER_EVALUATED_AT,
  };
}

function consequenceCommand(options: {
  artifactId?: string;
  expectationId?: string;
  identity?: string;
  occurredAt?: string;
  attachedAt?: string;
  evaluatedAt?: string;
} = {}) {
  const artifactId = options.artifactId ?? "result-a";
  const capture = structuredCapture({
    artifactId,
    factCardId: `fact-${artifactId}`,
    identity: options.identity,
    kind: "EXAM_REPORT",
    occurredAt: options.occurredAt ?? RESULT_OCCURRED_AT,
  });
  return {
    ...capture,
    expectationId: options.expectationId ?? "expectation-a",
    attachedAt: options.attachedAt ?? RESULT_ATTACHED_AT,
    evaluatedAt: options.evaluatedAt ?? RESULT_EVALUATED_AT,
  };
}

function repositories(pool: DatabasePool) {
  return {
    capture: new CaptureRepository(pool),
    attach: new WorkflowAttachRepository(pool),
    expectation: new ExpectationRepository(pool),
    verification: new VerificationRepository(pool),
  };
}

function service(pool: DatabasePool): PersistedGoldenPath {
  return new PersistedGoldenPath(repositories(pool));
}

async function counts(pool: PGlitePoolShim) {
  const result = await pool.db.query<Record<string, number>>(
    `SELECT
       (SELECT count(*)::int FROM artifact) AS artifacts,
       (SELECT count(*)::int FROM evidence_fact_card) AS fact_cards,
       (SELECT count(*)::int FROM workflow) AS workflows,
       (SELECT count(*)::int FROM workflow_artifact_link) AS links,
       (SELECT count(*)::int FROM expectation) AS expectations,
       (SELECT count(*)::int FROM expectation_transition) AS transitions,
       (SELECT count(*)::int FROM s2_verification) AS verifications`,
  );
  return result.rows[0];
}

async function seedWorkflow(pool: DatabasePool, workflow: Workflow): Promise<void> {
  await withTenantTransaction(pool, workflow.clinicId, async (client) => {
    await client.query(
      `INSERT INTO workflow
         (clinic_id, id, subject_type, identity_anchor, workflow_family, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [workflow.clinicId, workflow.id, workflow.subjectType, workflow.identityAnchor,
        workflow.workflowFamily, workflow.status, workflow.createdAt, workflow.updatedAt],
    );
  });
}

function openWorkflow(id: string): Workflow {
  return {
    id,
    clinicId: "clinic-a",
    subjectType: "PATIENT",
    identityAnchor: "PAT-001",
    workflowFamily: "EYE_EXAM",
    status: "OPEN",
    createdAt: "2026-08-30T08:00:00.000Z",
    updatedAt: "2026-08-30T08:00:00.000Z",
  };
}

test("trigger creates capture, Workflow, Link, OPEN Expectation and PENDING Verification", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    const result = await service(pool).recordTrigger(actor(), triggerCommand());
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.attachment.workflow?.id, "wf:clinic-a:trigger-a");
    assert.equal(result.expectation.expectation.state, "OPEN");
    assert.equal(result.verification.result.status, "PENDING");
    assert.deepEqual(await counts(pool), {
      artifacts: 1, fact_cards: 1, workflows: 1, links: 1,
      expectations: 1, transitions: 1, verifications: 1,
    });
  } finally { await pool.close(); }
});

test("exact trigger replay is idempotent across every durable stage", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    const app = service(pool);
    const first = await app.recordTrigger(actor(), triggerCommand());
    const second = await app.recordTrigger(actor(), triggerCommand());
    assert.deepEqual(second, first);
    assert.deepEqual(await counts(pool), {
      artifacts: 1, fact_cards: 1, workflows: 1, links: 1,
      expectations: 1, transitions: 1, verifications: 1,
    });
  } finally { await pool.close(); }
});

test("ambiguous attach leaves the capture durable and returns review without fabricated stages", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await seedWorkflow(pool, openWorkflow("workflow-z"));
    await seedWorkflow(pool, openWorkflow("workflow-a"));
    const result = await service(pool).recordTrigger(actor(), triggerCommand());
    assert.deepEqual(result.status, "REVIEW_REQUIRED");
    assert.deepEqual(result.attachment.resolution, {
      kind: "REVIEW_REQUIRED",
      candidateWorkflowIds: ["workflow-a", "workflow-z"],
    });
    assert.equal(result.expectation, null);
    assert.equal(result.verification, null);
    const state = await counts(pool);
    assert.equal(state.artifacts, 1);
    assert.equal(state.fact_cards, 1);
    assert.equal(state.links, 0);
    assert.equal(state.expectations, 0);
    assert.equal(state.verifications, 0);
  } finally { await pool.close(); }
});

test("consequence joins the authoritative Workflow and advances to MET plus VERIFIED", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    const app = service(pool);
    const trigger = await app.recordTrigger(actor(), triggerCommand());
    const result = await app.recordConsequence(actor(), consequenceCommand());
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.attachment.workflow?.id, trigger.attachment.workflow?.id);
    assert.equal(result.expectation.expectation.state, "MET");
    assert.equal(result.expectation.expectation.satisfiedByArtifactId, "result-a");
    assert.equal(result.verification.result.status, "VERIFIED");
    assert.deepEqual(result.verification.result.evidenceArtifactIds, ["trigger-a", "result-a"]);
  } finally { await pool.close(); }
});

test("exact consequence replay is idempotent", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    const app = service(pool);
    await app.recordTrigger(actor(), triggerCommand());
    const first = await app.recordConsequence(actor(), consequenceCommand());
    const second = await app.recordConsequence(actor(), consequenceCommand());
    assert.deepEqual(second, {
      ...first,
      expectation: { ...first.expectation, transition: null },
    });
    assert.deepEqual(await counts(pool), {
      artifacts: 2, fact_cards: 2, workflows: 1, links: 2,
      expectations: 1, transitions: 2, verifications: 2,
    });
  } finally { await pool.close(); }
});

test("Workflow mismatch fails before Expectation mutation or Verification", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    const app = service(pool);
    await app.recordTrigger(actor(), triggerCommand());
    await app.recordTrigger(actor(), triggerCommand({ identity: "PAT-002", suffix: "b" }));
    const before = await counts(pool);
    await assert.rejects(
      app.recordConsequence(actor(), consequenceCommand({ expectationId: "expectation-b" })),
      (error: unknown) => error instanceof DomainError && error.code === "EXPECTATION_WORKFLOW_MISMATCH",
    );
    const after = await counts(pool);
    assert.equal(after.artifacts, before.artifacts + 1);
    assert.equal(after.links, before.links + 1);
    assert.equal(after.transitions, before.transitions);
    assert.equal(after.verifications, before.verifications);
    const target = await repositories(pool).expectation.getExpectation(actor(), "expectation-b");
    assert.equal(target?.state, "OPEN");
    assert.equal(target?.evaluatedAt, TRIGGER_EVALUATED_AT);
  } finally { await pool.close(); }
});

test("stage failures are restartable without duplicate immutable rows", async () => {
  const stages = ["attach", "expectation", "verification"] as const;
  for (const stage of stages) {
    const pool = new PGlitePoolShim(); await pool.migrate();
    try {
      const deps = repositories(pool);
      let failed = false;
      const failing = {
        ...deps,
        [stage]: new Proxy(deps[stage], {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (!failed) {
                failed = true;
                return Promise.reject(new Error(`FORCED_${stage.toUpperCase()}_FAILURE`));
              }
              return Reflect.apply(value, target, args);
            };
          },
        }),
      };
      const app = new PersistedGoldenPath(failing);
      await assert.rejects(app.recordTrigger(actor(), triggerCommand()), /FORCED_/);
      const recovered = await app.recordTrigger(actor(), triggerCommand());
      assert.equal(recovered.status, "COMPLETED");
      assert.deepEqual(await counts(pool), {
        artifacts: 1, fact_cards: 1, workflows: 1, links: 1,
        expectations: 1, transitions: 1, verifications: 1,
      });
    } finally { await pool.close(); }
  }
});

test("consequence re-evaluation and Verification failures resume cleanly", async () => {
  for (const stage of ["expectation", "verification"] as const) {
    const pool = new PGlitePoolShim(); await pool.migrate();
    try {
      const base = repositories(pool);
      await new PersistedGoldenPath(base).recordTrigger(actor(), triggerCommand());
      let failed = false;
      const method = stage === "expectation" ? "reevaluateExpectation" : "verifyCurrentExpectation";
      const wrapped = new Proxy(base[stage], {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (property === method && !failed) {
              failed = true;
              return Promise.reject(new Error(`FORCED_${stage.toUpperCase()}_FAILURE`));
            }
            return Reflect.apply(value, target, args);
          };
        },
      });
      const app = new PersistedGoldenPath({ ...base, [stage]: wrapped });
      await assert.rejects(app.recordConsequence(actor(), consequenceCommand()), /FORCED_/);
      const recovered = await app.recordConsequence(actor(), consequenceCommand());
      assert.equal(recovered.status, "COMPLETED");
      assert.equal(recovered.verification.result.status, "VERIFIED");
      assert.deepEqual(await counts(pool), {
        artifacts: 2, fact_cards: 2, workflows: 1, links: 2,
        expectations: 1, transitions: 2, verifications: 2,
      });
    } finally { await pool.close(); }
  }
});

test("stale evaluation replay fails visibly after committing only restartable earlier stages", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    const app = service(pool);
    await app.recordTrigger(actor(), triggerCommand());
    await app.recordConsequence(actor(), consequenceCommand());
    await assert.rejects(
      app.recordConsequence(actor(), consequenceCommand({
        artifactId: "result-stale",
        occurredAt: "2026-08-30T09:09:00.000Z",
        attachedAt: "2026-08-30T09:09:01.000Z",
        evaluatedAt: "2026-08-30T09:10:00.000Z",
      })),
      (error: unknown) => error instanceof DomainError && error.code === "EXPECTATION_EVALUATION_STALE",
    );
    const state = await counts(pool);
    assert.equal(state.artifacts, 3);
    assert.equal(state.links, 3);
    assert.equal(state.transitions, 2);
    assert.equal(state.verifications, 2);
  } finally { await pool.close(); }
});

test("authority, tenant, identity and command fields fail before the first write", async () => {
  const cases: Array<[ActorContext, ReturnType<typeof triggerCommand> & Record<string, unknown>, string]> = [
    [{ clinicId: "clinic-a", actorId: "", role: "EMPLOYEE" }, triggerCommand(), "INVALID_ACTOR_CONTEXT"],
    [actor("clinic-b"), triggerCommand(), "TENANT_SCOPE_VIOLATION"],
    [actor(), { ...triggerCommand(), clinicId: "clinic-b" }, "INVALID_TRIGGER_COMMAND"],
    [actor(), {
      ...triggerCommand(),
      factCard: { ...triggerCommand().factCard, identityAnchor: "PAT-OO1" },
    }, "IDENTITY_ANCHOR_MISMATCH"],
  ];
  for (const [context, command, code] of cases) {
    const pool = new PGlitePoolShim(); await pool.migrate();
    try {
      await assert.rejects(
        service(pool).recordTrigger(context, command),
        (error: unknown) => error instanceof DomainError && error.code === code,
      );
      assert.equal(pool.acquisitions, 0);
      assert.equal((await counts(pool)).artifacts, 0);
    } finally { await pool.close(); }
  }
});

test("malformed and inconsistent times fail before capture", async () => {
  const invalid = [
    { ...triggerCommand(), attachedAt: "2026-08-30 09:00:01" },
    { ...triggerCommand(), evaluatedAt: "2026-08-30T08:59:00.000Z" },
    { ...triggerCommand(), expectation: { ...triggerCommand().expectation, triggeredAt: "2026-08-30T09:00:01.000Z" } },
    { ...triggerCommand(), artifact: { ...triggerCommand().artifact, occurredAt: "not-a-time" } },
  ];
  for (const command of invalid) {
    const pool = new PGlitePoolShim(); await pool.migrate();
    try {
      await assert.rejects(service(pool).recordTrigger(actor(), command));
      assert.equal(pool.acquisitions, 0);
      assert.equal((await counts(pool)).artifacts, 0);
    } finally { await pool.close(); }
  }
});

test("commands are snapshotted during awaits and results are detached", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    const base = repositories(pool);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const delayedCapture = {
      async saveCapture(...args: Parameters<CaptureRepository["saveCapture"]>) {
        entered();
        await gate;
        return base.capture.saveCapture(...args);
      },
    };
    const app = new PersistedGoldenPath({ ...base, capture: delayedCapture });
    const command = triggerCommand();
    const pending = app.recordTrigger(actor(), command);
    await started;
    command.artifact.identityAnchor = "MUTATED";
    command.factCard.lineageArtifactIds.push("forged");
    release();
    const result = await pending;
    assert.equal(result.capture.artifact.identityAnchor, "PAT-001");
    result.capture.factCard.lineageArtifactIds.push("returned-mutation");
    if (result.status === "COMPLETED") result.verification.record.reasonCodes.push("MUTATED");

    const replay = await service(pool).recordTrigger(actor(), triggerCommand());
    assert.deepEqual(replay.capture.factCard.lineageArtifactIds, ["trigger-a"]);
    assert.deepEqual(replay.verification.record.reasonCodes, ["CHAIN_OPEN"]);
  } finally { await pool.close(); }
});

test("Expectation preflight is tenant-scoped and returns detached values", async () => {
  const pool = new PGlitePoolShim(); await pool.migrate();
  try {
    await service(pool).recordTrigger(actor(), triggerCommand());
    const repository = new ExpectationRepository(pool);
    const found = await repository.getExpectation(actor(), "expectation-a");
    assert.equal(found?.workflowId, "wf:clinic-a:trigger-a");
    if (found) found.state = "VOIDED";
    assert.equal((await repository.getExpectation(actor(), "expectation-a"))?.state, "OPEN");
    assert.equal(await repository.getExpectation(actor("clinic-b"), "expectation-a"), null);
  } finally { await pool.close(); }
});

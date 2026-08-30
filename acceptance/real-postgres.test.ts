import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { DueExpectationBatch } from "../src/application/due-expectation-batch.ts";
import { EYE_EXAM_EXTRACTION_SPEC, type StoredEvidenceExtractionResult } from "../src/application/evidence-extraction.ts";
import { PersistedGoldenPath } from "../src/application/persisted-golden-path.ts";
import type { ActorContext, Artifact, EvidenceFactCard } from "../src/domain/contracts.ts";
import { CaptureRepository } from "../src/persistence/capture-repository.ts";
import { ExpectationRepository } from "../src/persistence/expectation-repository.ts";
import { ExtractionPersistenceRepository } from "../src/persistence/extraction-persistence-repository.ts";
import { ManagerDecisionRepository } from "../src/persistence/manager-decision-repository.ts";
import { createNodePgPool } from "../src/persistence/node-pg-pool.ts";
import { VerificationRepository } from "../src/persistence/verification-repository.ts";
import { WorkflowAttachRepository } from "../src/persistence/workflow-attach-repository.ts";
import {
  AcceptanceError,
  assertAppendOnlyBehavior,
  assertAppendOnlyTriggers,
  assertBinaries,
  assertConnectedRolesDiffer,
  assertDatabaseIdentities,
  assertDedicatedEmptyPublic,
  assertNoTenantLeak,
  assertRlsCatalog,
  assertRole,
  assertTenantIsolationForEveryTable,
  catalogDigest,
  dumpAndRestore,
  grantApplicationAccess,
  installSignalCancellation,
  loadConfig,
  logicalDigests,
  migrate,
  resetPublicSchema,
  throwIfAborted,
  userFromUrl,
} from "./real-postgres.ts";

test("WO-018 real PostgreSQL acceptance", { timeout: 300_000 }, async () => {
  const cancellationController = new AbortController();
  const cancellation = installSignalCancellation(cancellationController);
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    cancellation.dispose();
    console.error(`[WO018][FAIL] ${error instanceof AcceptanceError ? error.code : "ENVIRONMENT_INVALID"}`);
    throw error;
  }
  const sourceAdmin = new Pool({ connectionString: config.sourceAdmin });
  const sourceApp = new Pool({ connectionString: config.sourceApp, max: 12 });
  const restoreAdmin = new Pool({ connectionString: config.restoreAdmin });
  const restoreApp = new Pool({ connectionString: config.restoreApp, max: 4 });
  const sourceProductPool = createNodePgPool(config.sourceApp);
  let restoreProductPool: ReturnType<typeof createNodePgPool> | null = null;
  let sourceTouched = false;
  let restoreTouched = false;

  let failure: unknown;
  try {
    progress("PREFLIGHT");
    throwIfAborted(cancellationController.signal);
    const serverVersions = await assertDatabaseIdentities(sourceAdmin, sourceApp, restoreAdmin, restoreApp);
    await assertBinaries([serverVersions.sourceMajor, serverVersions.restoreMajor], cancellationController.signal);
    await assertDedicatedEmptyPublic(sourceAdmin);
    await assertDedicatedEmptyPublic(restoreAdmin);
    await assertConnectedRolesDiffer(sourceAdmin, sourceApp);
    await assertConnectedRolesDiffer(restoreAdmin, restoreApp);
    await assertRole(sourceApp, userFromUrl(config.sourceApp));
    await assertRole(restoreApp, userFromUrl(config.restoreApp));
    // No database may be touched until every source and restore preflight has passed.
    sourceTouched = true;
    restoreTouched = true;
    await resetPublicSchema(sourceAdmin);
    await migrate(sourceAdmin);
    await grantApplicationAccess(sourceAdmin, config.sourceApp);
    throwIfAborted(cancellationController.signal);

    progress("RLS");
    throwIfAborted(cancellationController.signal);
    await assertRlsCatalog(sourceAdmin);
    await assertAppendOnlyTriggers(sourceAdmin);
    await assertNoTenantLeak(sourceApp);
    const capture = new CaptureRepository(sourceProductPool);
    const employee = actor("WO018-A", "EMPLOYEE");
    const first = capturePair("WO018-read-write", "WO018-P-1", "2026-08-30T09:00:00.000Z");
    await capture.saveCapture(employee, first.artifact, first.factCard);
    assert.equal((await capture.getArtifact(employee, first.artifact.id))?.identityAnchor, "WO018-P-1");
    assert.equal(await tenantCount(sourceApp, "WO018-B", "artifact"), 0);
    await assert.rejects(tenantInsertForeignClinic(sourceApp));
    const extractions = new ExtractionPersistenceRepository(sourceProductPool);
    const extractionA = extraction("WO018-A");
    await extractions.saveExtraction(employee, extractionA.objectRef, extractionA.result);
    throwIfAborted(cancellationController.signal);

    progress("CONCURRENCY");
    throwIfAborted(cancellationController.signal);
    const attach = new WorkflowAttachRepository(sourceProductPool);
    const replay = await Promise.all([
      attach.attachCapture(employee, first.artifact.id, first.factCard.id, "2026-08-30T09:00:01.000Z"),
      attach.attachCapture(employee, first.artifact.id, first.factCard.id, "2026-08-30T09:00:01.000Z"),
    ]);
    assert.deepEqual(replay[0], replay[1]);
    assert.equal(await tenantCount(sourceApp, "WO018-A", "workflow_artifact_link"), 1);

    const sharedA = capturePair("WO018-shared-a", "WO018-P-SHARED", "2026-08-30T09:02:00.000Z");
    const sharedB = capturePair("WO018-shared-b", "WO018-P-SHARED", "2026-08-30T09:03:00.000Z");
    await capture.saveCapture(employee, sharedA.artifact, sharedA.factCard);
    await capture.saveCapture(employee, sharedB.artifact, sharedB.factCard);
    await tenantQuery(sourceApp, "WO018-A", `INSERT INTO workflow
      (clinic_id,id,subject_type,identity_anchor,workflow_family,status,created_at,updated_at)
      VALUES ('WO018-A','WO018-shared-workflow','PATIENT','WO018-P-SHARED','PATIENT_VISIT',
        'OPEN','2026-08-30T09:01:00Z','2026-08-30T09:01:00Z')`);
    const shared = await Promise.all([
      attach.attachCapture(employee, sharedA.artifact.id, sharedA.factCard.id, "2026-08-30T09:04:00.000Z"),
      attach.attachCapture(employee, sharedB.artifact.id, sharedB.factCard.id, "2026-08-30T09:04:00.000Z"),
    ]);
    assert.ok(shared.every((item) => item.workflow?.id === "WO018-shared-workflow"));

    const golden = goldenPath(sourceProductPool);
    const due1 = await golden.recordTrigger(employee, triggerCommand("WO018-due-1", "WO018-P-D1", "2026-08-30T09:10:00.000Z", "WO018-exp-1", "2026-08-30T09:11:00.000Z"));
    const due2 = await golden.recordTrigger(employee, triggerCommand("WO018-due-2", "WO018-P-D2", "2026-08-30T09:12:00.000Z", "WO018-exp-2", "2026-08-30T09:13:00.000Z"));
    assert.equal(due1.status, "COMPLETED");
    assert.equal(due2.status, "COMPLETED");
    const held = await sourceApp.connect();
    await held.query("BEGIN");
    await held.query("SELECT set_config('app.clinic_id','WO018-A',true)");
    await held.query("SELECT id FROM expectation WHERE clinic_id='WO018-A' AND id='WO018-exp-1' FOR UPDATE");
    const batch = new DueExpectationBatch(sourceProductPool);
    const skipped = await batch.processDueExpectations(actor("WO018-A", "MANAGER"), {
      now: "2026-08-30T09:20:00.000Z", limit: 1, cursor: null,
    });
    assert.deepEqual(skipped.processed, [{ expectationId: "WO018-exp-2" }]);
    await held.query("ROLLBACK");
    held.release();
    const released = await batch.processDueExpectations(actor("WO018-A", "MANAGER"), {
      now: "2026-08-30T09:20:00.000Z", limit: 10, cursor: null,
    });
    assert.ok(released.processed.some(({ expectationId }) => expectationId === "WO018-exp-1"));

    const complete = await createCompletedChain(golden, employee, "WO018-close");
    const decisions = new ManagerDecisionRepository(sourceProductPool);
    const manager = actor("WO018-A", "MANAGER");
    const commands = ["a", "b"].map((suffix) => ({
      id: `WO018-decision-${suffix}`,
      expectationId: complete.expectationId,
      action: "CLOSE_STANDARD" as const,
      reasonCode: null,
      note: null,
      decidedAt: "2026-08-30T10:10:00.000Z",
    }));
    const raced = await Promise.allSettled(commands.map((command) =>
      decisions.recordManagerDecision(manager, command)));
    assert.equal(raced.filter(({ status }) => status === "fulfilled").length, 1);
    assert.equal(await tenantCount(sourceApp, "WO018-A", "manager_decision", "expectation_id", complete.expectationId), 1);
    const winning = commands[raced.findIndex(({ status }) => status === "fulfilled")];
    await decisions.recordManagerDecision(manager, winning);
    assert.equal(await tenantCount(sourceApp, "WO018-A", "manager_decision", "id", winning.id), 1);

    const mixed = await golden.recordTrigger(employee, triggerCommand("WO018-mixed", "WO018-P-MIX", "2026-08-30T10:20:00.000Z", "WO018-exp-mix", "2026-08-30T10:21:00.000Z"));
    assert.equal(mixed.status, "COMPLETED");
    const mixedResults = await Promise.allSettled([
      batch.processDueExpectations(manager, { now: "2026-08-30T10:22:00.000Z", limit: 100, cursor: null }),
      decisions.recordManagerDecision(manager, {
        id: "WO018-decision-mix", expectationId: "WO018-exp-mix", action: "KEEP_OPEN",
        reasonCode: null, note: null, decidedAt: "2026-08-30T10:22:00.000Z",
      }),
    ]);
    assert.ok(mixedResults.some(({ status }) => status === "fulfilled"));
    await assertCoherentChain(sourceAdmin, "WO018-A", "WO018-exp-mix");

    const employeeB = actor("WO018-B", "EMPLOYEE");
    const managerB = actor("WO018-B", "MANAGER");
    const completeB = await createCompletedChain(golden, employeeB, "WO018-B-close");
    const extractionB = extraction("WO018-B");
    await extractions.saveExtraction(employeeB, extractionB.objectRef, extractionB.result);
    await decisions.recordManagerDecision(managerB, {
      id: "WO018-B-decision", expectationId: completeB.expectationId, action: "CLOSE_STANDARD",
      reasonCode: null, note: null, decidedAt: "2026-08-30T10:10:00.000Z",
    });
    await assertTenantIsolationForEveryTable(sourceAdmin, sourceApp);
    await assertAppendOnlyBehavior(sourceAdmin);
    throwIfAborted(cancellationController.signal);

    progress("BACKUP_RESTORE");
    throwIfAborted(cancellationController.signal);
    const sourceDigest = await logicalDigests(sourceAdmin);
    const sourceCatalogDigest = await catalogDigest(sourceAdmin);
    const dumpDigest = await dumpAndRestore(config, sourceAdmin, cancellationController.signal);
    assert.match(dumpDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(await logicalDigests(restoreAdmin), sourceDigest);
    assert.equal(await catalogDigest(restoreAdmin), sourceCatalogDigest);
    await assertRlsCatalog(restoreAdmin);
    await assertAppendOnlyTriggers(restoreAdmin);
    await grantApplicationAccess(restoreAdmin, config.restoreApp);
    await assertRole(restoreApp, userFromUrl(config.restoreApp));
    await assertNoTenantLeak(restoreApp);
    restoreProductPool = createNodePgPool(config.restoreApp);
    const restoredCapture = new CaptureRepository(restoreProductPool);
    const restored = capturePair("WO018-restored-write", "WO018-P-R", "2026-08-30T11:00:00.000Z");
    await restoredCapture.saveCapture(employee, restored.artifact, restored.factCard);
    assert.equal((await restoredCapture.getArtifact(employee, restored.artifact.id))?.id, restored.artifact.id);
    throwIfAborted(cancellationController.signal);
  } catch (error) {
    const safe = error instanceof AcceptanceError
      ? error
      : new AcceptanceError("REAL_POSTGRES_ACCEPTANCE_FAILED");
    console.error(`[WO018][FAIL] ${safe.code}`);
    failure = safe;
  } finally {
    const cleanup = await Promise.allSettled([
      restoreProductPool?.close() ?? Promise.resolve(),
      sourceProductPool.close(), sourceApp.end(), restoreApp.end(),
    ]);
    if (sourceTouched) cleanup.push(await settle(resetPublicSchema(sourceAdmin)));
    if (restoreTouched) cleanup.push(await settle(resetPublicSchema(restoreAdmin)));
    cleanup.push(await settle(sourceAdmin.end()), await settle(restoreAdmin.end()));
    cancellation.dispose();
    if (cleanup.some(({ status }) => status === "rejected")) {
      console.error("[WO018][FAIL] CLEANUP_FAILED");
      failure ??= new AcceptanceError("CLEANUP_FAILED");
    }
  }
  if (cancellation.exitCode !== null) {
    const signalExitCode = cancellation.exitCode;
    process.exitCode = signalExitCode;
    process.once("beforeExit", () => { process.exitCode = signalExitCode; });
    failure ??= new AcceptanceError("ACCEPTANCE_CANCELLED");
  }
  if (failure) throw failure;
  progress("PASS");
});

function actor(clinicId: string, role: ActorContext["role"]): ActorContext {
  return { clinicId, role, actorId: role === "MANAGER" ? "WO018-manager" : "WO018-employee" };
}

function capturePair(id: string, identityAnchor: string, occurredAt: string, kind = "REGISTRATION"):
  { artifact: Artifact; factCard: EvidenceFactCard } {
  const artifact: Artifact = {
    id, clinicId: identityAnchor.startsWith("WO018-B") ? "WO018-B" : "WO018-A", kind, occurredAt, occurredAtSource: "source",
    sourceEmployeeId: "WO018-employee", identityAnchor, payload: { synthetic: true }, createdAt: occurredAt,
  };
  return {
    artifact,
    factCard: {
      id: `${id}-fact`, clinicId: artifact.clinicId, artifactId: id, subjectType: "PATIENT",
      identityAnchor, workflowFamily: "PATIENT_VISIT", occurredAt, fields: { synthetic: true },
      missingFields: [], confidence: 1, parserVersion: "WO018", lineageArtifactIds: [id],
    },
  };
}

function extraction(clinicId: string): { objectRef: import("../src/storage/contracts.ts").StoredObjectRef; result: StoredEvidenceExtractionResult } {
  const suffix = clinicId === "WO018-A" ? "A" : "B";
  const objectRef = {
    clinicId, objectId: `WO018-object-${suffix}`, contentSha256: suffix.toLowerCase().repeat(64),
    sizeBytes: 100, mediaType: "image/png",
  };
  const artifactId = `WO018-extraction-artifact-${suffix}`;
  const factCardId = `WO018-extraction-fact-${suffix}`;
  return { objectRef, result: {
    status: "READY",
    artifact: {
      id: artifactId, clinicId, kind: "EXAM_REPORT", occurredAt: "2026-08-30T08:00:00.000Z",
      occurredAtSource: "source", sourceEmployeeId: "WO018-employee", identityAnchor: `WO018-P-${suffix}`,
      payload: { storedObjectRef: objectRef }, createdAt: "2026-08-30T08:00:01.000Z",
    },
    factCard: {
      id: factCardId, clinicId, artifactId, subjectType: "PATIENT", identityAnchor: `WO018-P-${suffix}`,
      workflowFamily: "EYE_EXAM", occurredAt: "2026-08-30T08:00:00.000Z",
      fields: { reportType: "EYE_EXAM" }, missingFields: [], confidence: 1,
      parserVersion: EYE_EXAM_EXTRACTION_SPEC.parserVersion, lineageArtifactIds: [artifactId],
    },
    candidate: {
      subjectTypeCandidate: "PATIENT", workflowFamilyCandidate: "EYE_EXAM",
      fields: { reportType: "EYE_EXAM" }, missingFields: [], confidence: 1,
    },
    reasonCodes: [],
    lineage: {
      requestId: `WO018-extraction-${suffix}`, providerKind: "LOCAL_MODEL",
      modelId: EYE_EXAM_EXTRACTION_SPEC.modelId,
      modelManifestSha256: EYE_EXAM_EXTRACTION_SPEC.modelManifestSha256,
      capability: EYE_EXAM_EXTRACTION_SPEC.capability,
      schemaVersion: EYE_EXAM_EXTRACTION_SPEC.schemaVersion,
      policyVersion: EYE_EXAM_EXTRACTION_SPEC.policyVersion,
      parserVersion: EYE_EXAM_EXTRACTION_SPEC.parserVersion,
      completedAt: "2026-08-30T08:00:02.000Z", objectContentSha256: objectRef.contentSha256,
    },
  } };
}

function goldenPath(pool: ReturnType<typeof createNodePgPool>): PersistedGoldenPath {
  return new PersistedGoldenPath({
    capture: new CaptureRepository(pool), attach: new WorkflowAttachRepository(pool),
    expectation: new ExpectationRepository(pool), verification: new VerificationRepository(pool),
  });
}

function triggerCommand(id: string, identity: string, occurredAt: string, expectationId: string, dueAt: string) {
  const pair = capturePair(id, identity, occurredAt);
  return { ...pair, attachedAt: occurredAt, evaluatedAt: occurredAt, expectation: {
    id: expectationId, triggerKind: "REGISTRATION", consequenceKind: "EXAM_REPORT",
    triggeredAt: occurredAt, dueAt,
  } };
}

async function createCompletedChain(golden: PersistedGoldenPath, employee: ActorContext, prefix: string) {
  const triggerAt = "2026-08-30T10:00:00.000Z";
  const expectationId = `${prefix}-expectation`;
  const trigger = await golden.recordTrigger(employee, triggerCommand(
    `${prefix}-trigger`, `${prefix}-patient`, triggerAt, expectationId, "2026-08-30T10:30:00.000Z",
  ));
  assert.equal(trigger.status, "COMPLETED");
  const consequence = capturePair(`${prefix}-consequence`, `${prefix}-patient`, "2026-08-30T10:05:00.000Z", "EXAM_REPORT");
  const result = await golden.recordConsequence(employee, {
    ...consequence, expectationId, attachedAt: "2026-08-30T10:05:00.000Z",
    evaluatedAt: "2026-08-30T10:06:00.000Z",
  });
  assert.equal(result.status, "COMPLETED");
  return { expectationId };
}

async function tenantQuery(pool: Pool, clinicId: string, text: string, values: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.clinic_id',$1,true)", [clinicId]);
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function tenantCount(pool: Pool, clinicId: string, table: string, field?: string, value?: string) {
  assert.match(table, /^[a-z_]+$/);
  if (field) assert.match(field, /^[a-z_]+$/);
  const result = await tenantQuery(pool, clinicId,
    `SELECT count(*)::int AS count FROM ${table}${field ? ` WHERE ${field}=$1` : ""}`,
    field ? [value] : []);
  return result.rows[0].count as number;
}

async function tenantInsertForeignClinic(pool: Pool) {
  return tenantQuery(pool, "WO018-A", `INSERT INTO artifact
    (clinic_id,id,kind,occurred_at,occurred_at_source,source_employee_id,identity_anchor,payload,created_at)
    VALUES ('WO018-B','WO018-cross','REGISTRATION',now(),'source','WO018-e','WO018-P','{}',now())`);
}

async function assertCoherentChain(admin: Pool, clinicId: string, expectationId: string) {
  const result = await admin.query<{
    orphan_transition: boolean; orphan_verification: boolean;
    current_transition_count: number; current_verification_count: number;
  }>(
    `SELECT
      EXISTS (SELECT 1 FROM expectation_transition t LEFT JOIN expectation e
        ON e.clinic_id=t.clinic_id AND e.id=t.expectation_id
        WHERE t.clinic_id=$1 AND t.expectation_id=$2 AND e.id IS NULL) AS orphan_transition,
      EXISTS (SELECT 1 FROM s2_verification v LEFT JOIN expectation_transition t
        ON t.clinic_id=v.clinic_id AND t.id=v.source_transition_id
        WHERE v.clinic_id=$1 AND v.expectation_id=$2 AND t.id IS NULL) AS orphan_verification,
      (SELECT count(*)::int FROM expectation e JOIN expectation_transition t
        ON t.clinic_id=e.clinic_id AND t.expectation_id=e.id
       AND t.to_state=e.state AND t.evaluated_at=e.evaluated_at
        WHERE e.clinic_id=$1 AND e.id=$2) AS current_transition_count,
      (SELECT count(*)::int FROM expectation e JOIN expectation_transition t
        ON t.clinic_id=e.clinic_id AND t.expectation_id=e.id
       AND t.to_state=e.state AND t.evaluated_at=e.evaluated_at
       JOIN s2_verification v ON v.clinic_id=t.clinic_id AND v.source_transition_id=t.id
        WHERE e.clinic_id=$1 AND e.id=$2 AND v.verifier_version='S2_V1') AS current_verification_count`,
    [clinicId, expectationId],
  );
  assert.deepEqual(result.rows[0], {
    orphan_transition: false,
    orphan_verification: false,
    current_transition_count: 1,
    current_verification_count: 1,
  });
}

function progress(label: string): void {
  console.log(`[WO018][${label}]`);
}

async function settle(promise: Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { EvidenceObjectIngestionService } from "../src/application/evidence-object-ingestion.ts";
import {
  EYE_EXAM_EXTRACTION_SPEC,
  StoredEvidenceExtractionService,
  type ExtractionCandidate,
} from "../src/application/evidence-extraction.ts";
import { ExtractionGoldenPath } from "../src/application/extraction-golden-path.ts";
import type { ProcessGoldenPathCommand } from "../src/application/extraction-golden-path.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { DatabaseConnection, DatabasePool, DatabaseQueryResult } from "../src/persistence/database-contracts.ts";
import { ExtractionPersistenceRepository } from "../src/persistence/extraction-persistence-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { PersistedGoldenPath } from "../src/application/persisted-golden-path.ts";
import { CaptureRepository } from "../src/persistence/capture-repository.ts";
import { ExpectationRepository } from "../src/persistence/expectation-repository.ts";
import { VerificationRepository } from "../src/persistence/verification-repository.ts";
import { WorkflowAttachRepository } from "../src/persistence/workflow-attach-repository.ts";
import { PostgresClinicalPreviewBackend } from "../src/preview/clinical-preview-backend.ts";
import { InferenceGateway } from "../src/runtime/inference-gateway.ts";
import type { InferenceProvider, InferenceRequest, InferenceResponse, RuntimeManifest } from "../src/runtime/contracts.ts";
import { LocalObjectStore } from "../src/storage/local-object-store.ts";
import { ObjectStoreGateway } from "../src/storage/object-store-gateway.ts";

// This is deliberately a transport fixture, not a document or clinical assertion.
const FIXTURE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const REGISTRATION_OCCURRED_AT = "2026-08-30T09:00:00.000Z";
const REGISTRATION_OPERATION_AT = "2026-08-30T09:01:00.000Z";
const PRESCRIPTION_OCCURRED_AT = "2026-08-30T09:05:00.000Z";
const PRESCRIPTION_OPERATION_AT = "2026-08-30T09:06:00.000Z";
const SELECTION_AT = "2026-08-30T09:07:00.000Z";
const REPORT_OCCURRED_AT = "2026-08-30T09:10:00.000Z";
const REPORT_CREATED_AT = "2026-08-30T09:10:30.000Z";
const INFERENCE_COMPLETED_AT = "2026-08-30T09:10:40.000Z";
const REPORT_OPERATION_AT = "2026-08-30T09:11:00.000Z";
const DECISION_AT = "2026-08-30T09:12:00.000Z";

const EMPLOYEE: ActorContext = { clinicId: "closure-demo-clinic", actorId: "closure-demo-employee", role: "EMPLOYEE" };
const MANAGER: ActorContext = { clinicId: EMPLOYEE.clinicId, actorId: "closure-demo-manager", role: "MANAGER" };
const OTHER_EMPLOYEE: ActorContext = { clinicId: EMPLOYEE.clinicId, actorId: "closure-demo-other", role: "EMPLOYEE" };
const OTHER_CLINIC_EMPLOYEE: ActorContext = { clinicId: "closure-other-clinic", actorId: "closure-demo-employee", role: "EMPLOYEE" };
const SYNTHETIC_ANCHOR = "DEMO-CLOSURE-001";

const MANIFEST: RuntimeManifest = Object.freeze({
  profile: "ON_PREM_STRICT",
  databaseProvider: "LOCAL_POSTGRES",
  fileProvider: "LOCAL_OBJECT_STORE",
  inferenceProvider: "LOCAL_MODEL",
  backupProvider: "LOCAL_ENCRYPTED_BACKUP",
  externalInferenceAuthorized: false,
  manifestVersion: "closure-demo-v1",
});

type Counts = {
  artifacts: number; factCards: number; workflows: number; links: number; expectations: number;
  storedObjects: number; extractionAttempts: number; verifications: number; decisions: number;
};

export type PersistedClosureSummary = {
  phases: readonly ["REGISTRATION", "PRESCRIPTION", "SELECTION", "UPLOAD", "EXTRACTION", "VERIFICATION", "MANAGER_CLOSE", "REPLAY"];
  registration: "OPEN";
  extraction: "READY";
  verification: "VERIFIED";
  closure: "CLOSED";
  decision: "CLOSE_STANDARD";
  reviewRequired: false;
  inferenceCalls: number;
  counts: Counts;
};

class PGlitePool implements DatabasePool {
  readonly db = new PGlite();
  async connect(): Promise<DatabaseConnection> {
    return {
      query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
        const result = await this.db.query<Row>(text, values as unknown[] | undefined);
        return { rows: result.rows } satisfies DatabaseQueryResult<Row>;
      },
      release() {},
    };
  }
  async migrate(): Promise<void> { await applyMigrations(this.db, await loadRepositoryMigrations()); }
  async close(): Promise<void> { await this.db.close(); }
}

class FixtureInferenceProvider implements InferenceProvider {
  readonly kind = "LOCAL_MODEL" as const;
  readonly modelId = EYE_EXAM_EXTRACTION_SPEC.modelId;
  calls = 0;
  readonly #candidate: ExtractionCandidate;

  constructor(candidate: ExtractionCandidate = readyCandidate()) { this.#candidate = structuredClone(candidate); }

  async infer(_context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    this.calls += 1;
    return {
      requestId: request.requestId,
      providerKind: this.kind,
      modelId: this.modelId,
      schemaVersion: request.schemaVersion,
      output: structuredClone(this.#candidate),
      completedAt: INFERENCE_COMPLETED_AT,
    };
  }
}

function readyCandidate(): ExtractionCandidate {
  return {
    subjectTypeCandidate: "PATIENT",
    workflowFamilyCandidate: "EYE_EXAM",
    fields: { reportType: "synthetic" },
    missingFields: [],
    confidence: 0.95,
  };
}

export interface PersistedClosureHarness {
  readonly backend: PostgresClinicalPreviewBackend;
  readonly pool: PGlitePool;
  readonly provider: FixtureInferenceProvider;
  readonly employee: ActorContext;
  readonly manager: ActorContext;
  readonly otherEmployee: ActorContext;
  readonly otherClinicEmployee: ActorContext;
  selectOpenExpectation(context?: ActorContext): Promise<{ expectationId: string; dueAt: string }>;
  register(): Promise<void>;
  prescribe(): Promise<void>;
  upload(bytes?: Uint8Array, key?: string): Promise<ReturnType<PostgresClinicalPreviewBackend["uploadEvidenceObject"]>>;
  uploadAs(context: ActorContext, bytes?: Uint8Array, key?: string): Promise<ReturnType<PostgresClinicalPreviewBackend["uploadEvidenceObject"]>>;
  command(expectationId: string, objectRef: Awaited<ReturnType<PostgresClinicalPreviewBackend["uploadEvidenceObject"]>>, overrides?: Partial<{
    requestId: string; artifactId: string; factCardId: string; occurredAt: string; createdAt: string; attachedAt: string; evaluatedAt: string;
  }>): ProcessGoldenPathCommand;
  submit(expectationId: string, objectRef: Awaited<ReturnType<PostgresClinicalPreviewBackend["uploadEvidenceObject"]>>, overrides?: Partial<{
    requestId: string; artifactId: string; factCardId: string; occurredAt: string; createdAt: string; attachedAt: string; evaluatedAt: string;
  }>): Promise<unknown>;
  close(expectationId: string, action?: "CLOSE_STANDARD" | "KEEP_OPEN", key?: string): Promise<unknown>;
  counts(): Promise<Counts>;
  dispose(): Promise<void>;
}

export async function createPersistedClosureHarness(candidate: ExtractionCandidate = readyCandidate()): Promise<PersistedClosureHarness> {
  const pool = new PGlitePool();
  const root = await mkdtemp(join(tmpdir(), "clinic-os-closure-"));
  await pool.migrate();
  const objects = new ObjectStoreGateway(MANIFEST, new LocalObjectStore(root));
  // Finish the local provider's directory hardening before handing a harness
  // to a caller that may dispose it without uploading anything. This probe is
  // read-only and intentionally does not create an object or receipt.
  try {
    await objects.get(EMPLOYEE, { objectId: "closure-ready-probe" });
    throw new DomainError("CLOSURE_DEMO_STORAGE_FAILED", "Unexpected readiness probe object.");
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "OBJECT_NOT_FOUND") throw error;
  }
  const provider = new FixtureInferenceProvider(candidate);
  const inference = new InferenceGateway(MANIFEST, provider);
  const capture = new CaptureRepository(pool);
  const golden = new PersistedGoldenPath({
    capture,
    attach: new WorkflowAttachRepository(pool),
    expectation: new ExpectationRepository(pool),
    verification: new VerificationRepository(pool),
  });
  const extractionPath = new ExtractionGoldenPath({
    extractor: new StoredEvidenceExtractionService({ objects, inference }),
    persistence: new ExtractionPersistenceRepository(pool),
    goldenPath: golden,
  });
  const backend = new PostgresClinicalPreviewBackend(pool, {
    extractionGoldenPath: extractionPath,
    objectIngestion: new EvidenceObjectIngestionService(objects),
  });
  return {
    backend, pool, provider,
    employee: structuredClone(EMPLOYEE), manager: structuredClone(MANAGER),
    otherEmployee: structuredClone(OTHER_EMPLOYEE), otherClinicEmployee: structuredClone(OTHER_CLINIC_EMPLOYEE),
    async register() {
      const result = await backend.createRegistrationTrigger!(EMPLOYEE, {
        identityAnchor: SYNTHETIC_ANCHOR,
        occurredAt: REGISTRATION_OCCURRED_AT,
        receivedAt: REGISTRATION_OPERATION_AT,
        idempotencyKey: "closure-registration-0001",
      });
      if (result.status !== "COMPLETED" || result.expectationState !== "OPEN" || result.verificationStatus !== "PENDING") {
        throw new DomainError("CLOSURE_DEMO_REGISTRATION_FAILED", "Registration did not establish the expected pending chain.");
      }
    },
    async prescribe() {
      const result = await backend.createPrescriptionTrigger!(EMPLOYEE, {
        identityAnchor: SYNTHETIC_ANCHOR,
        occurredAt: PRESCRIPTION_OCCURRED_AT,
        receivedAt: PRESCRIPTION_OPERATION_AT,
        idempotencyKey: "closure-prescription-0001",
      });
      if (result.status !== "COMPLETED" || result.expectationState !== "OPEN" || result.verificationStatus !== "PENDING") {
        throw new DomainError("CLOSURE_DEMO_PRESCRIPTION_FAILED", "Prescription did not establish the expected report stage.");
      }
    },
    async selectOpenExpectation(context = EMPLOYEE) {
      const page = await backend.listOpenExamReportExpectations(context, { asOf: SELECTION_AT, limit: 2 });
      if (page.items.length !== 1 || page.nextCursor !== null || page.items[0].state !== "OPEN" || page.items[0].consequenceKind !== "EXAM_REPORT") {
        throw new DomainError("CLOSURE_DEMO_SELECTION_FAILED", "Employee selection did not return exactly one open expectation.");
      }
      return structuredClone({ expectationId: page.items[0].expectationId, dueAt: page.items[0].dueAt });
    },
    async upload(bytes = FIXTURE_BYTES, key = "closure-upload-0001") {
      return backend.uploadEvidenceObject!(EMPLOYEE, { idempotencyKey: key, mediaType: "image/png", bytes: new Uint8Array(bytes) });
    },
    async uploadAs(context, bytes = FIXTURE_BYTES, key = "closure-upload-0001") {
      return backend.uploadEvidenceObject!(context, { idempotencyKey: key, mediaType: "image/png", bytes: new Uint8Array(bytes) });
    },
    command(expectationId, objectRef, overrides = {}) {
      return consequenceCommand(expectationId, objectRef, overrides);
    },
    async submit(expectationId, objectRef, overrides = {}) {
      return backend.submitExamReportConsequence!(EMPLOYEE, consequenceCommand(expectationId, objectRef, overrides));
    },
    async close(expectationId, action = "CLOSE_STANDARD", key = "closure-decision-0001") {
      return backend.submitManagerDecision(MANAGER, {
        expectationId, action, reasonCode: null, note: null, idempotencyKey: key, receivedAt: DECISION_AT,
      });
    },
    counts: () => readCounts(pool),
    async dispose() {
      await pool.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function consequenceCommand(
  expectationId: string,
  objectRef: Awaited<ReturnType<PostgresClinicalPreviewBackend["uploadEvidenceObject"]>>,
  overrides: Partial<{
    requestId: string; artifactId: string; factCardId: string; occurredAt: string; createdAt: string; attachedAt: string; evaluatedAt: string;
  }> = {},
): ProcessGoldenPathCommand {
  return {
    extraction: {
      requestId: overrides.requestId ?? "closure-extraction-0001",
      artifactId: overrides.artifactId ?? "closure-report-artifact-0001",
      factCardId: overrides.factCardId ?? "closure-report-fact-0001",
      objectRef: structuredClone(objectRef), kind: "EXAM_REPORT",
      occurredAt: overrides.occurredAt ?? REPORT_OCCURRED_AT, occurredAtSource: "source",
      identityAnchor: SYNTHETIC_ANCHOR, createdAt: overrides.createdAt ?? REPORT_CREATED_AT,
    },
    operation: {
      kind: "CONSEQUENCE", expectationId,
      attachedAt: overrides.attachedAt ?? REPORT_OPERATION_AT,
      evaluatedAt: overrides.evaluatedAt ?? REPORT_OPERATION_AT,
    },
  };
}

export async function runPersistedClosureDemo(): Promise<PersistedClosureSummary> {
  const harness = await createPersistedClosureHarness();
  try {
    await harness.register();
    // Registration is replayed while its state is still OPEN. Later state progression is deliberately
    // not hidden by a fake fresh registration command.
    await harness.register();
    await harness.prescribe();
    await harness.prescribe();
    const selected = await harness.selectOpenExpectation();
    if (selected.dueAt !== "2026-08-30T09:35:00.000Z") throw new DomainError("CLOSURE_DEMO_DUE_FAILED", "Unexpected server-derived due time.");
    const objectRef = await harness.upload();
    await harness.upload();
    const consequence = await harness.submit(selected.expectationId, objectRef) as { status: string; extraction: { status: string }; goldenPath: { verification: { result: { status: string } } } };
    if (consequence.status !== "COMPLETED" || consequence.extraction.status !== "READY" || consequence.goldenPath.verification.result.status !== "VERIFIED") {
      throw new DomainError("CLOSURE_DEMO_CONSEQUENCE_FAILED", "Consequence did not verify.");
    }
    await harness.submit(selected.expectationId, objectRef);
    if (harness.provider.calls !== 1) throw new DomainError("CLOSURE_DEMO_REPLAY_FAILED", "Durable extraction replay invoked inference.");
    const beforeClose = (await harness.backend.listManagerClosures(harness.manager))
      .find((item) => item.expectationId === selected.expectationId);
    if (!beforeClose || beforeClose.workflowStatus !== "OPEN" || beforeClose.expectationState !== "MET" ||
        beforeClose.verificationStatus !== "VERIFIED" || beforeClose.needsReview) {
      throw new DomainError("CLOSURE_DEMO_PROJECTION_FAILED", "Manager projection was not closure-ready.");
    }
    await harness.close(selected.expectationId);
    const firstClosedProjection = await harness.backend.listManagerClosures(harness.manager);
    await harness.close(selected.expectationId);
    const projection = await harness.backend.listManagerClosures(harness.manager);
    const closed = projection.find((item) => item.expectationId === selected.expectationId);
    if (!closed || closed.workflowStatus !== "CLOSED" || closed.expectationState !== "MET" ||
        closed.verificationStatus !== "VERIFIED" || closed.latestDecision?.action !== "CLOSE_STANDARD" || closed.needsReview ||
        projection.some((item) => item.needsReview)) {
      throw new DomainError("CLOSURE_DEMO_CLOSE_FAILED", "Manager close did not produce a closed projection.");
    }
    if (JSON.stringify(projection) !== JSON.stringify(firstClosedProjection)) {
      throw new DomainError("CLOSURE_DEMO_REPLAY_FAILED", "Manager decision replay changed the closure projection.");
    }
    return Object.freeze({
      phases: ["REGISTRATION", "PRESCRIPTION", "SELECTION", "UPLOAD", "EXTRACTION", "VERIFICATION", "MANAGER_CLOSE", "REPLAY"],
      registration: "OPEN", extraction: "READY", verification: "VERIFIED", closure: "CLOSED",
      decision: "CLOSE_STANDARD", reviewRequired: false, inferenceCalls: harness.provider.calls,
      counts: await harness.counts(),
    });
  } finally {
    await harness.dispose();
  }
}

async function readCounts(pool: PGlitePool): Promise<Counts> {
  const result = await pool.db.query<Counts>(`
    SELECT
      (SELECT count(*)::int FROM artifact) AS artifacts,
      (SELECT count(*)::int FROM evidence_fact_card) AS "factCards",
      (SELECT count(*)::int FROM workflow) AS workflows,
      (SELECT count(*)::int FROM workflow_artifact_link) AS links,
      (SELECT count(*)::int FROM expectation) AS expectations,
      (SELECT count(*)::int FROM stored_object_ref) AS "storedObjects",
      (SELECT count(*)::int FROM evidence_extraction_attempt) AS "extractionAttempts",
      (SELECT count(*)::int FROM s2_verification) AS verifications,
      (SELECT count(*)::int FROM manager_decision) AS decisions
  `);
  return structuredClone(result.rows[0]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPersistedClosureDemo().then(
    (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
    () => { process.stdout.write('{"status":"FAILED"}\n'); process.exitCode = 1; },
  );
}

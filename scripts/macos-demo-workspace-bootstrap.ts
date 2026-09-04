import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { EvidenceObjectIngestionService } from "../src/application/evidence-object-ingestion.ts";
import { EYE_EXAM_EXTRACTION_SPEC, StoredEvidenceExtractionService, type ExtractionCandidate } from "../src/application/evidence-extraction.ts";
import { ExtractionGoldenPath } from "../src/application/extraction-golden-path.ts";
import { PersistedGoldenPath } from "../src/application/persisted-golden-path.ts";
import type { ActorContext } from "../src/domain/contracts.ts";
import { DomainError } from "../src/domain/errors.ts";
import { CaptureRepository } from "../src/persistence/capture-repository.ts";
import type { DatabasePool } from "../src/persistence/database-contracts.ts";
import { ExtractionPersistenceRepository } from "../src/persistence/extraction-persistence-repository.ts";
import { ExpectationRepository } from "../src/persistence/expectation-repository.ts";
import { applyMigrations, loadRepositoryMigrations } from "../src/persistence/migration-runner.ts";
import { createNodePgPool } from "../src/persistence/node-pg-pool.ts";
import { VerificationRepository } from "../src/persistence/verification-repository.ts";
import { WorkflowAttachRepository } from "../src/persistence/workflow-attach-repository.ts";
import { PostgresClinicalPreviewBackend } from "../src/preview/clinical-preview-backend.ts";
import type { InferenceProvider, InferenceRequest, InferenceResponse, RuntimeManifest } from "../src/runtime/contracts.ts";
import { InferenceGateway } from "../src/runtime/inference-gateway.ts";
import { LocalObjectStore } from "../src/storage/local-object-store.ts";
import { ObjectStoreGateway } from "../src/storage/object-store-gateway.ts";

export const MACOS_DEMO_CONFIRMATION = "RESET_LOCAL_DEMO";
export const MACOS_DEMO_DATABASE_NAME = "clinic_os_demo";
const DEMO_ROOT = join(homedir(), "clinic-os-data", "demo-objects");
const EMPLOYEE: ActorContext = Object.freeze({ clinicId: "demo-clinic", actorId: "demo-employee", role: "EMPLOYEE" });
const MANAGER: ActorContext = Object.freeze({ clinicId: "demo-clinic", actorId: "demo-manager", role: "MANAGER" });
const MANIFEST: RuntimeManifest = Object.freeze({
  profile: "ON_PREM_STRICT", databaseProvider: "LOCAL_POSTGRES", fileProvider: "LOCAL_OBJECT_STORE",
  inferenceProvider: "LOCAL_MODEL", backupProvider: "LOCAL_ENCRYPTED_BACKUP",
  externalInferenceAuthorized: false, manifestVersion: "macos-demo-workspace-v1",
});
const FIXTURE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

export type DemoBootstrapSummary = { status: "PREPARED"; cases: 5 };

/** This validation deliberately runs before opening a database connection. */
export function assertDedicatedMacosDemoDatabase(databaseUrl: unknown, confirmation: unknown): string {
  if (confirmation !== MACOS_DEMO_CONFIRMATION || typeof databaseUrl !== "string") throw refused();
  try {
    const url = new URL(databaseUrl);
    const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (!localHost || !["postgres:", "postgresql:"].includes(url.protocol) || url.port !== "5432" ||
        url.pathname !== `/${MACOS_DEMO_DATABASE_NAME}` || url.search || url.hash || !url.username || url.password) throw new Error();
    return databaseUrl;
  } catch { throw refused(); }
}

export async function prepareMacosDemoWorkspace(input: {
  databaseUrl: unknown;
  confirmation: unknown;
  launch?: boolean;
}, dependencies: {
  reset?: (url: string) => Promise<void>;
  seed?: (url: string) => Promise<void>;
  launch?: (url: string) => Promise<void>;
} = {}): Promise<DemoBootstrapSummary> {
  const databaseUrl = assertDedicatedMacosDemoDatabase(input.databaseUrl, input.confirmation);
  await (dependencies.reset ?? resetDedicatedDatabase)(databaseUrl);
  await (dependencies.seed ?? seedFiveSyntheticCases)(databaseUrl);
  if (input.launch !== false) await (dependencies.launch ?? launchPreparedPreview)(databaseUrl);
  return Object.freeze({ status: "PREPARED", cases: 5 });
}

async function resetDedicatedDatabase(databaseUrl: string): Promise<void> {
  const pool = createNodePgPool(databaseUrl);
  let connection;
  try {
    connection = await pool.connect();
    // DDL only: no application/business data is inserted outside accepted services.
    await connection.query("DROP SCHEMA public CASCADE");
    await connection.query("CREATE SCHEMA public");
    await applyMigrations(connection, await loadRepositoryMigrations());
  } finally {
    connection?.release();
    await pool.close().catch(() => undefined);
  }
  await rm(DEMO_ROOT, { recursive: true, force: true });
}

async function seedFiveSyntheticCases(databaseUrl: string): Promise<void> {
  const pool = createNodePgPool(databaseUrl);
  try {
    const backend = makeBackend(pool);
    await runFiveSyntheticDemoCases({
      open: (anchor, key, at) => seedOpen(backend, anchor, key, at),
      closed: (anchor, key, at, replay) => seedClosed(backend, anchor, key, at, replay),
    });
  } finally { await pool.close().catch(() => undefined); }
}

type DemoCaseSeeder = {
  open(anchor: string, key: string, at: Date): Promise<void>;
  closed(anchor: string, key: string, at: Date, replay: boolean): Promise<void>;
};

/** Fixed case plan; the only varying value is an in-window clock anchor for the visible local preview. */
export async function runFiveSyntheticDemoCases(seeder: DemoCaseSeeder, now = Date.now()): Promise<void> {
  const base = new Date(now - 10 * 60_000);
  // Complete both closed walkthroughs before creating any intentionally open
  // cases.  The employee selector is deliberately global to its authorized
  // workspace, so interleaving unfinished patients would make a seed command
  // select another patient's current Expectation and correctly fail closed.
  await seeder.closed("DEMO-FIVE-01", "one", base, false);
  await seeder.closed("DEMO-FIVE-05", "five", base, true);
  await seeder.open("DEMO-FIVE-02", "two", base);
  await seeder.open("DEMO-FIVE-03", "three", new Date(base.getTime() - 90 * 60_000));
  await seeder.open("DEMO-FIVE-04", "four", base);
}

function makeBackend(pool: DatabasePool): PostgresClinicalPreviewBackend {
  const capture = new CaptureRepository(pool);
  const persisted = new PersistedGoldenPath({
    capture, attach: new WorkflowAttachRepository(pool), expectation: new ExpectationRepository(pool), verification: new VerificationRepository(pool),
  });
  const objects = new ObjectStoreGateway(MANIFEST, new LocalObjectStore(DEMO_ROOT));
  const extraction = new ExtractionGoldenPath({
    extractor: new StoredEvidenceExtractionService({ objects, inference: new InferenceGateway(MANIFEST, new SyntheticExtractionProvider()) }),
    persistence: new ExtractionPersistenceRepository(pool, EYE_EXAM_EXTRACTION_SPEC), goldenPath: persisted,
  });
  return new PostgresClinicalPreviewBackend(pool, {
    extractionGoldenPath: extraction, objectIngestion: new EvidenceObjectIngestionService(objects),
  });
}

async function seedOpen(backend: PostgresClinicalPreviewBackend, anchor: string, key: string, at: Date): Promise<void> {
  const registrationAt = at.toISOString();
  const prescriptionAt = new Date(at.getTime() + 60_000).toISOString();
  await backend.createRegistrationTrigger(EMPLOYEE, { identityAnchor: anchor, occurredAt: registrationAt, receivedAt: registrationAt, idempotencyKey: `demo-${key}-registration` });
  await backend.createPrescriptionTrigger(EMPLOYEE, { identityAnchor: anchor, occurredAt: prescriptionAt, receivedAt: prescriptionAt, idempotencyKey: `demo-${key}-prescription` });
}

async function seedClosed(backend: PostgresClinicalPreviewBackend, anchor: string, key: string, at: Date, replay: boolean): Promise<void> {
  await seedOpen(backend, anchor, key, at);
  const reportAt = new Date(at.getTime() + 2 * 60_000).toISOString();
  const selected = await backend.listOpenExamReportExpectations(EMPLOYEE, { asOf: reportAt, limit: 1 });
  const expectationId = selected.items[0]?.expectationId;
  if (!expectationId) throw new DomainError("MACOS_DEMO_SEED_FAILED", "Synthetic demonstration setup failed.");
  const objectRef = await backend.uploadEvidenceObject(EMPLOYEE, { idempotencyKey: `demo-${key}-upload`, mediaType: "image/png", bytes: FIXTURE_BYTES });
  const command = {
    extraction: { requestId: `demo-${key}-extract`, artifactId: `demo-${key}-report-artifact`, factCardId: `demo-${key}-report-fact`, objectRef,
      kind: "EXAM_REPORT" as const, occurredAt: reportAt, occurredAtSource: "source" as const, identityAnchor: anchor, createdAt: reportAt },
    operation: { kind: "CONSEQUENCE" as const, expectationId, attachedAt: reportAt, evaluatedAt: reportAt },
  };
  await backend.submitExamReportConsequence(EMPLOYEE, command);
  if (replay) await backend.submitExamReportConsequence(EMPLOYEE, command);
  const paymentAt = new Date(at.getTime() + 3 * 60_000).toISOString();
  const payment = await backend.listOpenPaymentExpectations(EMPLOYEE, { asOf: paymentAt, limit: 1 });
  const paymentExpectationId = payment.items[0]?.expectationId;
  if (!paymentExpectationId) throw new DomainError("MACOS_DEMO_SEED_FAILED", "Synthetic demonstration setup failed.");
  await backend.createPaymentTrigger(EMPLOYEE, { identityAnchor: anchor, occurredAt: paymentAt, receivedAt: paymentAt, idempotencyKey: `demo-${key}-payment` });
  // Payment's S2 verification is appended at paymentAt + 1 ms.  The immutable
  // manager snapshot must therefore be later than that verification, not at
  // the same earlier receipt instant.
  const decisionAt = new Date(Date.parse(paymentAt) + 2).toISOString();
  await backend.submitManagerDecision(MANAGER, { expectationId: paymentExpectationId, action: "CLOSE_STANDARD", reasonCode: null, note: null, idempotencyKey: `demo-${key}-close`, receivedAt: decisionAt });
}

class SyntheticExtractionProvider implements InferenceProvider {
  readonly kind = "LOCAL_MODEL" as const;
  readonly modelId = EYE_EXAM_EXTRACTION_SPEC.modelId;
  async infer(_context: ActorContext, request: InferenceRequest): Promise<InferenceResponse> {
    const candidate: ExtractionCandidate = { subjectTypeCandidate: "PATIENT", workflowFamilyCandidate: "EYE_EXAM", fields: { reportType: "synthetic" }, missingFields: [], confidence: 0.95 };
    return { requestId: request.requestId, providerKind: this.kind, modelId: this.modelId, schemaVersion: request.schemaVersion, output: candidate, completedAt: new Date().toISOString() };
  }
}

async function launchPreparedPreview(databaseUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["scripts/start-macos-local.sh"], {
      stdio: "inherit",
      env: { ...process.env, CLINIC_OS_DEMO_WORKSPACE_BOOTSTRAP: "1", CLINIC_OS_DEMO_DATABASE_URL: databaseUrl },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("PREVIEW_LAUNCH_FAILED")));
  });
}

function refused(): DomainError {
  return new DomainError("MACOS_DEMO_DATABASE_REFUSED", "The requested demo workspace target is not permitted.");
}

function boundedBootstrapFailureCode(error: unknown): string {
  // The local operator needs a stable next action, but never a driver message,
  // SQL statement, connection URL, filesystem path, or seeded record value.
  return error instanceof DomainError && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code
    : "DATABASE_OR_STORAGE_FAILURE";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const launch = process.env.CLINIC_OS_DEMO_NO_LAUNCH !== "1";
  let stage = "VALIDATION";
  prepareMacosDemoWorkspace({ databaseUrl: process.env.CLINIC_OS_DEMO_DATABASE_URL, confirmation: process.env.CLINIC_OS_DEMO_RESET, launch }, {
    reset: async (databaseUrl) => { stage = "DATABASE_RESET"; await resetDedicatedDatabase(databaseUrl); },
    seed: async (databaseUrl) => { stage = "DEMO_SEED"; await seedFiveSyntheticCases(databaseUrl); },
    launch: async (databaseUrl) => { stage = "PREVIEW_START"; await launchPreparedPreview(databaseUrl); },
  }).then(
    (summary) => process.stdout.write(`${JSON.stringify(summary)}\n`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ status: "REFUSED", stage, code: boundedBootstrapFailureCode(error) })}\n`);
      process.exitCode = 1;
    },
  );
}

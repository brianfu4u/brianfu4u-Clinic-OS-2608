import { createHash } from "node:crypto";

import { PersistedGoldenPath } from "../application/persisted-golden-path.ts";
import {
  ExtractionGoldenPath,
  type ProcessGoldenPathCommand,
  type ProcessGoldenPathResult,
} from "../application/extraction-golden-path.ts";
import { assertActorAccess } from "../domain/access-context.ts";
import type { ActorContext, Artifact, EvidenceFactCard, ManagerDecisionAction } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { CaptureRepository } from "../persistence/capture-repository.ts";
import type { DatabasePool } from "../persistence/database-contracts.ts";
import { ExpectationRepository } from "../persistence/expectation-repository.ts";
import {
  EmployeeOpenExpectationReadRepository,
  type EmployeeOpenExpectationPage,
  type EmployeeOpenExpectationQuery,
} from "../persistence/employee-open-expectation-read-repository.ts";
import { ManagerClosureReadRepository, type ManagerClosureReadItem } from "../persistence/manager-closure-read-repository.ts";
import { ManagerDecisionRepository, type PersistedManagerDecisionResult } from "../persistence/manager-decision-repository.ts";
import { parseStrictIsoInstant } from "../persistence/strict-timestamp.ts";
import { VerificationRepository } from "../persistence/verification-repository.ts";
import { WorkflowAttachRepository } from "../persistence/workflow-attach-repository.ts";
import type {
  EvidenceObjectIngestionInput,
  EvidenceObjectIngestionService,
} from "../application/evidence-object-ingestion.ts";
import type { StoredObjectRef } from "../storage/contracts.ts";

export interface ClinicalRegistrationTriggerInput {
  identityAnchor: string;
  occurredAt: string;
  idempotencyKey: string;
  receivedAt: string;
}

export type ClinicalRegistrationTriggerResult =
  | { status: "COMPLETED"; expectationId: string; expectationState: "OPEN" | "UNMET"; verificationStatus: "PENDING" }
  | { status: "REVIEW_REQUIRED" };

export interface ClinicalManagerDecisionInput {
  expectationId: string;
  action: ManagerDecisionAction;
  reasonCode: string | null;
  note: string | null;
  idempotencyKey: string;
  receivedAt: string;
}

export interface ClinicalPreviewBackend {
  listOpenExamReportExpectations(
    context: ActorContext,
    query: EmployeeOpenExpectationQuery,
  ): Promise<EmployeeOpenExpectationPage>;
  createRegistrationTrigger?(
    context: ActorContext,
    input: ClinicalRegistrationTriggerInput,
  ): Promise<ClinicalRegistrationTriggerResult>;
  submitExamReportConsequence?(
    context: ActorContext,
    command: ProcessGoldenPathCommand,
  ): Promise<ProcessGoldenPathResult>;
  uploadEvidenceObject?(
    context: ActorContext,
    input: EvidenceObjectIngestionInput,
  ): Promise<StoredObjectRef>;
  listManagerClosures(context: ActorContext): Promise<ManagerClosureReadItem[]>;
  submitManagerDecision(
    context: ActorContext,
    input: ClinicalManagerDecisionInput,
  ): Promise<PersistedManagerDecisionResult>;
}

export class PostgresClinicalPreviewBackend implements ClinicalPreviewBackend {
  readonly #path: PersistedGoldenPath;
  readonly #extractionPath?: ExtractionGoldenPath;
  readonly #objectIngestion?: Pick<EvidenceObjectIngestionService, "ingest">;
  readonly #capture: CaptureRepository;
  readonly #closures: ManagerClosureReadRepository;
  readonly #decisions: ManagerDecisionRepository;
  readonly #openExpectations: EmployeeOpenExpectationReadRepository;

  constructor(pool: DatabasePool, options: {
    extractionGoldenPath?: ExtractionGoldenPath;
    objectIngestion?: Pick<EvidenceObjectIngestionService, "ingest">;
  } = {}) {
    this.#capture = new CaptureRepository(pool);
    this.#path = new PersistedGoldenPath({
      capture: this.#capture,
      attach: new WorkflowAttachRepository(pool),
      expectation: new ExpectationRepository(pool),
      verification: new VerificationRepository(pool),
    });
    this.#closures = new ManagerClosureReadRepository(pool);
    this.#decisions = new ManagerDecisionRepository(pool);
    this.#openExpectations = new EmployeeOpenExpectationReadRepository(pool);
    this.#extractionPath = options.extractionGoldenPath;
    this.#objectIngestion = options.objectIngestion;
  }

  listOpenExamReportExpectations(
    context: ActorContext,
    query: EmployeeOpenExpectationQuery,
  ): Promise<EmployeeOpenExpectationPage> {
    assertActorAccess(context, context.clinicId, "EMPLOYEE");
    return this.#openExpectations.listOpenExamReportExpectations(context, query);
  }

  async uploadEvidenceObject(
    context: ActorContext,
    input: EvidenceObjectIngestionInput,
  ): Promise<StoredObjectRef> {
    assertActorAccess(context, context.clinicId, "EMPLOYEE");
    if (!this.#objectIngestion) {
      throw new DomainError("PERSISTED_UPLOAD_UNAVAILABLE", "Persisted evidence upload is not configured.");
    }
    return this.#objectIngestion.ingest(context, input);
  }

  async submitExamReportConsequence(
    context: ActorContext,
    command: ProcessGoldenPathCommand,
  ): Promise<ProcessGoldenPathResult> {
    assertActorAccess(context, context.clinicId, "EMPLOYEE");
    if (!this.#extractionPath) {
      throw new DomainError(
        "PERSISTED_TRANSPORT_UNAVAILABLE",
        "Persisted extraction transport is not configured.",
      );
    }
    return this.#extractionPath.processGoldenPath(context, command);
  }

  async createRegistrationTrigger(
    context: ActorContext,
    rawInput: ClinicalRegistrationTriggerInput,
  ): Promise<ClinicalRegistrationTriggerResult> {
    assertActorAccess(context, context.clinicId, "EMPLOYEE");
    const input = structuredClone(rawInput);
    requireExactRegistrationInput(input);
    requireKey(input.idempotencyKey);
    const occurredAt = parseStrictIsoInstant(input.occurredAt);
    const receivedAt = parseStrictIsoInstant(input.receivedAt);
    if (occurredAt === null || receivedAt === null || occurredAt > receivedAt) {
      throw new DomainError("INVALID_CLINICAL_PREVIEW_TIME", "Occurrence must not be later than receipt.");
    }
    if (!isExactDemoAnchor(input.identityAnchor)) {
      throw new DomainError("INVALID_CLINICAL_PREVIEW_INPUT", "Only synthetic EYE_EXAM data is accepted.");
    }
    const artifactId = stableId("artifact", context, input.idempotencyKey);
    const existingArtifact = await this.#capture.getArtifact(context, artifactId);
    let operationAt = existingArtifact?.createdAt ?? input.receivedAt;
    const artifact: Artifact = {
      id: artifactId,
      clinicId: context.clinicId,
      kind: "REGISTRATION",
      occurredAt: input.occurredAt,
      occurredAtSource: "employee_confirmed",
      sourceEmployeeId: context.actorId,
      identityAnchor: input.identityAnchor,
      payload: { previewRegistration: true },
      createdAt: operationAt,
    };
    const factCard: EvidenceFactCard = {
      id: stableId("fact", context, input.idempotencyKey),
      clinicId: context.clinicId,
      artifactId,
      subjectType: "PATIENT",
      identityAnchor: input.identityAnchor,
      workflowFamily: "EYE_EXAM",
      occurredAt: input.occurredAt,
      fields: { previewRegistration: true },
      missingFields: [],
      confidence: 1,
      parserVersion: "preview-registration-trigger-1",
      lineageArtifactIds: [artifactId],
    };
    const run = () => this.#path.recordTrigger(context, {
          artifact,
          factCard,
          expectation: {
            id: stableId("expectation", context, input.idempotencyKey),
            triggerKind: "REGISTRATION",
            consequenceKind: "EXAM_REPORT",
            triggeredAt: input.occurredAt,
            dueAt: new Date(Date.parse(input.occurredAt) + 15 * 60_000).toISOString(),
          },
          attachedAt: operationAt,
          evaluatedAt: operationAt,
        });
    let result;
    try {
      result = await run();
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "ARTIFACT_ID_CONFLICT" || existingArtifact) throw error;
      const racedArtifact = await this.#capture.getArtifact(context, artifactId);
      if (!racedArtifact) throw error;
      artifact.createdAt = racedArtifact.createdAt;
      operationAt = racedArtifact.createdAt;
      result = await run();
    }

    if (result.status === "REVIEW_REQUIRED") {
      return { status: "REVIEW_REQUIRED" };
    }
    const expectationState = result.expectation.expectation.state;
    if ((expectationState !== "OPEN" && expectationState !== "UNMET") || result.verification.result.status !== "PENDING") {
      throw new DomainError("INVALID_REGISTRATION_RESULT", "Registration did not establish a valid pending expectation.");
    }
    return structuredClone({
      status: "COMPLETED" as const,
      expectationId: result.expectation.expectation.id,
      expectationState,
      verificationStatus: "PENDING" as const,
    });
  }

  listManagerClosures(context: ActorContext): Promise<ManagerClosureReadItem[]> {
    return this.#closures.listManagerClosures(context);
  }

  async submitManagerDecision(
    context: ActorContext,
    rawInput: ClinicalManagerDecisionInput,
  ): Promise<PersistedManagerDecisionResult> {
    assertActorAccess(context, context.clinicId, "MANAGER");
    const input = structuredClone(rawInput);
    requireKey(input.idempotencyKey);
    const decisionId = stableId("decision", context, input.idempotencyKey);
    const existing = await this.#decisions.getManagerDecision(context, decisionId);
    const receivedAt = parseStrictIsoInstant(input.receivedAt);
    if (receivedAt === null) {
      throw new DomainError("INVALID_MANAGER_DECISION_TIME", "Decision receipt time must be valid.");
    }
    const command = {
      id: decisionId,
      expectationId: requireExpectationId(input.expectationId),
      action: input.action,
      reasonCode: input.reasonCode,
      note: input.note,
      decidedAt: existing?.decidedAt ?? input.receivedAt,
    };
    try {
      return await this.#decisions.recordManagerDecision(context, command);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "DECISION_ID_CONFLICT" || existing) throw error;
      const raced = await this.#decisions.getManagerDecision(context, decisionId);
      if (!raced) throw error;
      command.decidedAt = raced.decidedAt;
      return this.#decisions.recordManagerDecision(context, command);
    }
  }
}

export function requireIdempotencyKey(value: string | undefined): string {
  requireKey(value);
  return value as string;
}

function requireKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:+-]+$/.test(value)) {
    throw new DomainError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 8-128 bounded characters.");
  }
}

function requireExactRegistrationInput(value: ClinicalRegistrationTriggerInput): void {
  if (Object.keys(value).sort().join("|") !== "idempotencyKey|identityAnchor|occurredAt|receivedAt") {
    throw new DomainError("INVALID_CLINICAL_PREVIEW_INPUT", "Registration command is invalid.");
  }
}

function isExactDemoAnchor(value: unknown): value is string {
  return typeof value === "string" && /^DEMO-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function stableId(
  prefix: string,
  context: ActorContext,
  key: string,
): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify([context.clinicId, context.actorId, key]))
    .digest("hex")
    .slice(0, 32)}`;
}

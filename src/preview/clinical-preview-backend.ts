import { createHash } from "node:crypto";

import { PersistedGoldenPath } from "../application/persisted-golden-path.ts";
import {
  ExtractionGoldenPath,
  type ProcessGoldenPathCommand,
  type ProcessGoldenPathResult,
} from "../application/extraction-golden-path.ts";
import { assertActorAccess } from "../domain/access-context.ts";
import type { ActorContext, Artifact, EvidenceFactCard, ManagerDecisionAction } from "../domain/contracts.ts";
import { nextEyeExamExpectation } from "../domain/eye-exam-flow-policy.ts";
import { DomainError } from "../domain/errors.ts";
import { CaptureRepository } from "../persistence/capture-repository.ts";
import type { DatabasePool } from "../persistence/database-contracts.ts";
import { ExpectationRepository } from "../persistence/expectation-repository.ts";
import {
  EmployeeOpenExpectationReadRepository,
  type EmployeeOpenExpectationPage,
  type EmployeeOpenExpectationQuery,
} from "../persistence/employee-open-expectation-read-repository.ts";
import {
  ManagerClosureReadRepository,
  type ManagerAttentionGapItem,
  type ManagerClosureReadItem,
} from "../persistence/manager-closure-read-repository.ts";
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

export interface ClinicalPrescriptionTriggerInput extends ClinicalRegistrationTriggerInput {}
export interface ClinicalPaymentTriggerInput extends ClinicalRegistrationTriggerInput {}

export type ClinicalRegistrationTriggerResult =
  | { status: "COMPLETED"; expectationId: string; expectationState: "OPEN" | "UNMET"; verificationStatus: "PENDING" }
  | { status: "REVIEW_REQUIRED" };

export type ClinicalPrescriptionTriggerResult = ClinicalRegistrationTriggerResult;
export type ClinicalPaymentTriggerResult =
  | { status: "COMPLETED"; expectationId: string; expectationState: "MET"; verificationStatus: "VERIFIED" }
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
  listOpenPaymentExpectations?(
    context: ActorContext,
    query: EmployeeOpenExpectationQuery,
  ): Promise<EmployeeOpenExpectationPage>;
  createRegistrationTrigger?(
    context: ActorContext,
    input: ClinicalRegistrationTriggerInput,
  ): Promise<ClinicalRegistrationTriggerResult>;
  createPrescriptionTrigger?(
    context: ActorContext,
    input: ClinicalPrescriptionTriggerInput,
  ): Promise<ClinicalPrescriptionTriggerResult>;
  createPaymentTrigger?(
    context: ActorContext,
    input: ClinicalPaymentTriggerInput,
  ): Promise<ClinicalPaymentTriggerResult>;
  submitExamReportConsequence?(
    context: ActorContext,
    command: ProcessGoldenPathCommand,
  ): Promise<ProcessGoldenPathResult>;
  uploadEvidenceObject?(
    context: ActorContext,
    input: EvidenceObjectIngestionInput,
  ): Promise<StoredObjectRef>;
  listManagerClosures(context: ActorContext): Promise<ManagerClosureReadItem[]>;
  listManagerAttentionGaps?(context: ActorContext): Promise<ManagerAttentionGapItem[]>;
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
  readonly #expectations: ExpectationRepository;
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
      expectation: this.#expectations = new ExpectationRepository(pool),
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

  listOpenPaymentExpectations(
    context: ActorContext,
    query: EmployeeOpenExpectationQuery,
  ): Promise<EmployeeOpenExpectationPage> {
    assertActorAccess(context, context.clinicId, "EMPLOYEE");
    return this.#openExpectations.listOpenFlowExpectations(context, query, "PAYMENT");
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
    const capturedContext = snapshotActorContext(context);
    const capturedCommand = structuredClone(command);
    assertActorAccess(capturedContext, capturedContext.clinicId, "EMPLOYEE");
    if (!this.#extractionPath) {
      throw new DomainError(
        "PERSISTED_TRANSPORT_UNAVAILABLE",
        "Persisted extraction transport is not configured.",
      );
    }
    // The opaque Expectation ID is not authority by itself.  Its current
    // employee-safe selection is rechecked before the extraction path can
    // persist or attach a consequence, including at the exclusive due edge.
    const page = await this.#openExpectations.listOpenExamReportExpectations(capturedContext, {
      asOf: capturedCommand.operation?.evaluatedAt,
      limit: 50,
    });
    const selected = page.items.some((item) => item.expectationId === capturedCommand.operation?.expectationId);
    if (!selected && !(await this.#extractionPath.canResumeExisting(capturedContext, capturedCommand))) {
      throw new DomainError("EXPECTATION_SELECTION_REQUIRED", "A current employee expectation selection is required.");
    }
    const result = await this.#extractionPath.processGoldenPath(capturedContext, capturedCommand);
    if (result.status !== "COMPLETED" ||
        result.goldenPath.expectation.expectation.state !== "MET" ||
        result.goldenPath.verification.result.status !== "VERIFIED") {
      return result;
    }

    // An accepted report is the only authority that can establish the payment
    // stage. The client never supplies a payment identifier, amount, or
    // browser-selected expectation: this deterministic trigger reuses the
    // durable report capture and exact extraction identity.
    const occurredAt = result.extraction.artifact.occurredAt;
    const next = occurredAt === null ? null : nextEyeExamExpectation("EXAM_REPORT", occurredAt);
    if (!next) {
      throw new DomainError("INVALID_FLOW_POLICY", "A verified exam report must create a payment expectation.");
    }
    const payment = await this.#path.recordTrigger(capturedContext, {
      artifact: result.extraction.artifact,
      factCard: result.extraction.factCard,
      expectation: {
        id: stableId("expectation", capturedContext, `${capturedCommand.extraction.requestId}:payment`),
        triggerKind: next.triggerKind,
        consequenceKind: next.consequenceKind,
        triggeredAt: occurredAt,
        dueAt: next.dueAt,
      },
      attachedAt: capturedCommand.operation.attachedAt,
      evaluatedAt: capturedCommand.operation.evaluatedAt,
    });
    if (payment.status === "REVIEW_REQUIRED" ||
        (payment.expectation.expectation.state !== "OPEN" && payment.expectation.expectation.state !== "UNMET") ||
        payment.verification.result.status !== "PENDING") {
      throw new DomainError("INVALID_PAYMENT_STAGE", "Verified exam report did not establish a pending payment expectation.");
    }
    return result;
  }

  async createRegistrationTrigger(
    context: ActorContext,
    rawInput: ClinicalRegistrationTriggerInput,
  ): Promise<ClinicalRegistrationTriggerResult> {
    // This command performs a read-before-write retry. Freeze the authority at
    // the entry boundary so a caller cannot mutate its context while a database
    // await is in flight and redirect the retry into another tenant.
    const capturedContext = snapshotActorContext(context);
    assertActorAccess(capturedContext, capturedContext.clinicId, "EMPLOYEE");
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
    const artifactId = stableId("artifact", capturedContext, input.idempotencyKey);
    const existingArtifact = await this.#capture.getArtifact(capturedContext, artifactId);
    let operationAt = existingArtifact?.createdAt ?? input.receivedAt;
    const artifact: Artifact = {
      id: artifactId,
      clinicId: capturedContext.clinicId,
      kind: "REGISTRATION",
      occurredAt: input.occurredAt,
      occurredAtSource: "employee_confirmed",
      sourceEmployeeId: capturedContext.actorId,
      identityAnchor: input.identityAnchor,
      payload: { previewRegistration: true },
      createdAt: operationAt,
    };
    const factCard: EvidenceFactCard = {
      id: stableId("fact", capturedContext, input.idempotencyKey),
      clinicId: capturedContext.clinicId,
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
    const next = nextEyeExamExpectation("REGISTRATION", input.occurredAt);
    if (!next) throw new DomainError("INVALID_FLOW_POLICY", "Registration must create a prescription expectation.");
    const run = () => this.#path.recordTrigger(capturedContext, {
          artifact,
          factCard,
          expectation: {
            id: stableId("expectation", capturedContext, input.idempotencyKey),
            triggerKind: next.triggerKind,
            consequenceKind: next.consequenceKind,
            triggeredAt: input.occurredAt,
            dueAt: next.dueAt,
          },
          attachedAt: operationAt,
          evaluatedAt: operationAt,
        });
    let result;
    try {
      result = await run();
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "ARTIFACT_ID_CONFLICT" || existingArtifact) throw error;
      const racedArtifact = await this.#capture.getArtifact(capturedContext, artifactId);
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

  async createPrescriptionTrigger(
    context: ActorContext,
    rawInput: ClinicalPrescriptionTriggerInput,
  ): Promise<ClinicalPrescriptionTriggerResult> {
    const capturedContext = snapshotActorContext(context);
    assertActorAccess(capturedContext, capturedContext.clinicId, "EMPLOYEE");
    const input = structuredClone(rawInput);
    requireExactRegistrationInput(input);
    requireKey(input.idempotencyKey);
    const occurredAt = parseStrictIsoInstant(input.occurredAt);
    const receivedAt = parseStrictIsoInstant(input.receivedAt);
    if (occurredAt === null || receivedAt === null || occurredAt > receivedAt || !isExactDemoAnchor(input.identityAnchor)) {
      throw new DomainError("INVALID_CLINICAL_PREVIEW_INPUT", "Prescription command is invalid.");
    }
    const artifactId = stableId("artifact", capturedContext, input.idempotencyKey);
    const existing = await this.#capture.getArtifact(capturedContext, artifactId);
    const operationAt = existing?.createdAt ?? input.receivedAt;
    // Registration may have been accepted in the same clock tick. Its pending
    // verification is immutable, so this server-derived, replay-stable instant
    // gives the consequence a distinct append-only verification identity. It
    // never changes the immutable createdAt or attachedAt evidence timestamps.
    const evaluatedAt = new Date(Date.parse(operationAt) + 1).toISOString();
    const expectationId = existing ? storedConsequenceExpectation(existing) : await this.#currentStageExpectation(
      capturedContext, input.identityAnchor, "PRESCRIPTION", input.occurredAt, input.receivedAt,
    );
    if (expectationId === null) return { status: "REVIEW_REQUIRED" };
    const artifact: Artifact = {
      id: artifactId,
      clinicId: capturedContext.clinicId,
      kind: "PRESCRIPTION",
      occurredAt: input.occurredAt,
      occurredAtSource: "employee_confirmed",
      sourceEmployeeId: capturedContext.actorId,
      identityAnchor: input.identityAnchor,
      payload: { previewPrescription: true, consequenceExpectationId: expectationId },
      createdAt: operationAt,
    };
    const factCard: EvidenceFactCard = {
      id: stableId("fact", capturedContext, input.idempotencyKey), clinicId: capturedContext.clinicId,
      artifactId, subjectType: "PATIENT", identityAnchor: input.identityAnchor, workflowFamily: "EYE_EXAM",
      occurredAt: input.occurredAt, fields: { previewPrescription: true }, missingFields: [], confidence: 1,
      parserVersion: "preview-prescription-trigger-1", lineageArtifactIds: [artifactId],
    };
    const consequence = await this.#path.recordConsequence(capturedContext, {
      artifact, factCard, expectationId, attachedAt: operationAt, evaluatedAt,
    });
    if (consequence.status === "REVIEW_REQUIRED") return { status: "REVIEW_REQUIRED" };
    if (consequence.expectation.expectation.state !== "MET" || consequence.verification.result.status !== "VERIFIED") {
      throw new DomainError("INVALID_PRESCRIPTION_RESULT", "Prescription did not satisfy its expected registration consequence.");
    }
    if (consequence.expectation.expectation.satisfiedByArtifactId !== artifactId) {
      throw new DomainError("PRESCRIPTION_NOT_CURRENT", "Prescription did not satisfy the selected current expectation.");
    }
    const next = nextEyeExamExpectation("PRESCRIPTION", input.occurredAt);
    if (!next) throw new DomainError("INVALID_FLOW_POLICY", "Prescription must create an exam report expectation.");
    const nextResult = await this.#path.recordTrigger(capturedContext, {
      artifact,
      factCard,
      expectation: {
        id: stableId("expectation", capturedContext, `${input.idempotencyKey}:next`),
        triggerKind: next.triggerKind, consequenceKind: next.consequenceKind,
        triggeredAt: input.occurredAt, dueAt: next.dueAt,
      },
      attachedAt: operationAt, evaluatedAt,
    });
    if (nextResult.status === "REVIEW_REQUIRED") return { status: "REVIEW_REQUIRED" };
    const expectation = nextResult.expectation.expectation;
    if ((expectation.state !== "OPEN" && expectation.state !== "UNMET") || nextResult.verification.result.status !== "PENDING") {
      throw new DomainError("INVALID_PRESCRIPTION_RESULT", "Prescription did not establish the next pending expectation.");
    }
    return { status: "COMPLETED", expectationId: expectation.id, expectationState: expectation.state, verificationStatus: "PENDING" };
  }

  async createPaymentTrigger(
    context: ActorContext,
    rawInput: ClinicalPaymentTriggerInput,
  ): Promise<ClinicalPaymentTriggerResult> {
    const capturedContext = snapshotActorContext(context);
    assertActorAccess(capturedContext, capturedContext.clinicId, "EMPLOYEE");
    const input = structuredClone(rawInput);
    requireExactRegistrationInput(input);
    requireKey(input.idempotencyKey);
    const occurredAt = parseStrictIsoInstant(input.occurredAt);
    const receivedAt = parseStrictIsoInstant(input.receivedAt);
    if (occurredAt === null || receivedAt === null || occurredAt > receivedAt || !isExactDemoAnchor(input.identityAnchor)) {
      throw new DomainError("INVALID_CLINICAL_PREVIEW_INPUT", "Payment command is invalid.");
    }
    const artifactId = stableId("artifact", capturedContext, input.idempotencyKey);
    const existing = await this.#capture.getArtifact(capturedContext, artifactId);
    const operationAt = existing?.createdAt ?? input.receivedAt;
    const evaluatedAt = new Date(Date.parse(operationAt) + 1).toISOString();
    const expectationId = existing ? storedConsequenceExpectation(existing, "previewPayment") : await this.#currentStageExpectation(
      capturedContext, input.identityAnchor, "PAYMENT", input.occurredAt, input.receivedAt,
    );
    if (expectationId === null) return { status: "REVIEW_REQUIRED" };
    const artifact: Artifact = {
      id: artifactId, clinicId: capturedContext.clinicId, kind: "PAYMENT", occurredAt: input.occurredAt,
      occurredAtSource: "employee_confirmed", sourceEmployeeId: capturedContext.actorId, identityAnchor: input.identityAnchor,
      payload: { previewPayment: true, consequenceExpectationId: expectationId }, createdAt: operationAt,
    };
    const factCard: EvidenceFactCard = {
      id: stableId("fact", capturedContext, input.idempotencyKey), clinicId: capturedContext.clinicId,
      artifactId, subjectType: "PATIENT", identityAnchor: input.identityAnchor, workflowFamily: "EYE_EXAM",
      occurredAt: input.occurredAt, fields: { previewPayment: true }, missingFields: [], confidence: 1,
      parserVersion: "preview-payment-trigger-1", lineageArtifactIds: [artifactId],
    };
    const consequence = await this.#path.recordConsequence(capturedContext, {
      artifact, factCard, expectationId, attachedAt: operationAt, evaluatedAt,
    });
    if (consequence.status === "REVIEW_REQUIRED") return { status: "REVIEW_REQUIRED" };
    if (consequence.expectation.expectation.state !== "MET" || consequence.verification.result.status !== "VERIFIED" ||
        consequence.expectation.expectation.satisfiedByArtifactId !== artifactId) {
      throw new DomainError("INVALID_PAYMENT_RESULT", "Payment did not satisfy the current payment expectation.");
    }
    return { status: "COMPLETED", expectationId, expectationState: "MET", verificationStatus: "VERIFIED" };
  }

  async #currentStageExpectation(
    context: ActorContext,
    identityAnchor: string,
    consequenceKind: "PRESCRIPTION" | "PAYMENT",
    occurredAtValue: string,
    asOf: string,
  ): Promise<string | null> {
    const page = await this.#openExpectations.listOpenFlowExpectations(
      context, { asOf, limit: 2 }, consequenceKind, identityAnchor,
    );
    if (page.items.length === 0) {
      throw new DomainError("EXPECTATION_SELECTION_REQUIRED", "A single current flow expectation is required.");
    }
    if (page.items.length > 1) return null;
    const expectation = await this.#expectations.getExpectation(context, page.items[0].expectationId);
    const occurredAt = parseStrictIsoInstant(occurredAtValue);
    const triggeredAt = expectation && parseStrictIsoInstant(expectation.triggeredAt);
    const dueAt = expectation && parseStrictIsoInstant(expectation.dueAt);
    if (!expectation || occurredAt === null || triggeredAt === null || dueAt === null ||
        expectation.triggerKind !== (consequenceKind === "PRESCRIPTION" ? "REGISTRATION" : "EXAM_REPORT") || expectation.consequenceKind !== consequenceKind ||
        expectation.state !== "OPEN" || occurredAt < triggeredAt || occurredAt > dueAt) {
      throw new DomainError(consequenceKind === "PRESCRIPTION" ? "PRESCRIPTION_NOT_CURRENT" : "PAYMENT_NOT_CURRENT", "Flow stage is not current.");
    }
    return expectation.id;
  }

  listManagerClosures(context: ActorContext): Promise<ManagerClosureReadItem[]> {
    return this.#closures.listManagerClosures(context);
  }

  listManagerAttentionGaps(context: ActorContext): Promise<ManagerAttentionGapItem[]> {
    return this.#closures.listManagerAttentionGaps(context);
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

function snapshotActorContext(value: ActorContext): ActorContext {
  let captured: ActorContext;
  try {
    captured = structuredClone(value);
    if (
      !captured ||
      typeof captured !== "object" ||
      Array.isArray(captured) ||
      Object.getPrototypeOf(captured) !== Object.prototype ||
      Object.keys(captured).length !== 3 ||
      !["actorId", "clinicId", "role"].every((key) => Object.hasOwn(captured, key))
    ) {
      throw new Error("invalid ActorContext shape");
    }
  } catch {
    throw new DomainError("INVALID_ACTOR_CONTEXT", "ActorContext must contain exact clinic, actor and role values.");
  }
  return captured;
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

function requireExpectationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new DomainError("INVALID_EXPECTATION_ID", "Expectation ID is invalid.");
  }
  return value;
}

function storedConsequenceExpectation(artifact: Artifact, marker = "previewPrescription"): string {
  const payload = artifact.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.getPrototypeOf(payload) !== Object.prototype ||
      Object.keys(payload).sort().join("|") !== `consequenceExpectationId|${marker}` ||
      (payload as Record<string, unknown>)[marker] !== true) {
    throw new DomainError("ARTIFACT_ID_CONFLICT", "Persisted stage identity is inconsistent.");
  }
  return requireExpectationId((payload as Record<string, unknown>).consequenceExpectationId);
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

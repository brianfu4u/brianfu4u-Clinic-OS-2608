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
import { ManagerClosureReadRepository, type ManagerClosureReadItem } from "../persistence/manager-closure-read-repository.ts";
import { ManagerDecisionRepository, type PersistedManagerDecisionResult } from "../persistence/manager-decision-repository.ts";
import { parseStrictIsoInstant } from "../persistence/strict-timestamp.ts";
import { VerificationRepository } from "../persistence/verification-repository.ts";
import { WorkflowAttachRepository } from "../persistence/workflow-attach-repository.ts";

export interface ClinicalWorkUpdateInput {
  kind: "REGISTRATION" | "EXAM_REPORT";
  identityAnchor: string;
  workflowFamily: "EYE_EXAM";
  occurredAt: string;
  text: string;
  expectationId?: string;
  idempotencyKey: string;
  receivedAt: string;
}

export interface ClinicalWorkUpdateResult {
  status: "COMPLETED" | "REVIEW_REQUIRED";
  artifactId: string;
  workflowId: string | null;
  expectationId: string | null;
  expectationState: string | null;
  verificationStatus: string | null;
}

export interface ClinicalManagerDecisionInput {
  expectationId: string;
  action: ManagerDecisionAction;
  reasonCode: string | null;
  note: string | null;
  idempotencyKey: string;
  receivedAt: string;
}

export interface ClinicalPreviewBackend {
  submitWorkUpdate(context: ActorContext, input: ClinicalWorkUpdateInput): Promise<ClinicalWorkUpdateResult>;
  submitExamReportConsequence?(
    context: ActorContext,
    command: ProcessGoldenPathCommand,
  ): Promise<ProcessGoldenPathResult>;
  listManagerClosures(context: ActorContext): Promise<ManagerClosureReadItem[]>;
  submitManagerDecision(
    context: ActorContext,
    input: ClinicalManagerDecisionInput,
  ): Promise<PersistedManagerDecisionResult>;
}

export class PostgresClinicalPreviewBackend implements ClinicalPreviewBackend {
  readonly #path: PersistedGoldenPath;
  readonly #extractionPath?: ExtractionGoldenPath;
  readonly #capture: CaptureRepository;
  readonly #closures: ManagerClosureReadRepository;
  readonly #decisions: ManagerDecisionRepository;

  constructor(pool: DatabasePool, options: { extractionGoldenPath?: ExtractionGoldenPath } = {}) {
    this.#capture = new CaptureRepository(pool);
    this.#path = new PersistedGoldenPath({
      capture: this.#capture,
      attach: new WorkflowAttachRepository(pool),
      expectation: new ExpectationRepository(pool),
      verification: new VerificationRepository(pool),
    });
    this.#closures = new ManagerClosureReadRepository(pool);
    this.#decisions = new ManagerDecisionRepository(pool);
    this.#extractionPath = options.extractionGoldenPath;
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

  async submitWorkUpdate(
    context: ActorContext,
    rawInput: ClinicalWorkUpdateInput,
  ): Promise<ClinicalWorkUpdateResult> {
    assertActorAccess(context, context.clinicId, "EMPLOYEE");
    const input = structuredClone(rawInput);
    requireKey(input.idempotencyKey);
    const occurredAt = parseStrictIsoInstant(input.occurredAt);
    const receivedAt = parseStrictIsoInstant(input.receivedAt);
    if (occurredAt === null || receivedAt === null || occurredAt > receivedAt) {
      throw new DomainError("INVALID_CLINICAL_PREVIEW_TIME", "Occurrence must not be later than receipt.");
    }
    if (input.workflowFamily !== "EYE_EXAM" || !input.identityAnchor.startsWith("DEMO-")) {
      throw new DomainError("INVALID_CLINICAL_PREVIEW_INPUT", "Only synthetic EYE_EXAM data is accepted.");
    }
    if (input.kind === "REGISTRATION" && input.expectationId !== undefined) {
      throw new DomainError("FORBIDDEN_EXPECTATION_ID", "Registration creates its server-derived Expectation ID.");
    }
    if (input.kind === "EXAM_REPORT") requireExpectationId(input.expectationId);
    const artifactId = stableId("artifact", context, input.idempotencyKey);
    const existingArtifact = await this.#capture.getArtifact(context, artifactId);
    const artifact: Artifact = {
      id: artifactId,
      clinicId: context.clinicId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      occurredAtSource: "employee_confirmed",
      sourceEmployeeId: context.actorId,
      identityAnchor: input.identityAnchor,
      payload: { text: input.text, synthetic: true },
      createdAt: existingArtifact?.createdAt ?? input.receivedAt,
    };
    const factCard: EvidenceFactCard = {
      id: stableId("fact", context, input.idempotencyKey),
      clinicId: context.clinicId,
      artifactId,
      subjectType: "PATIENT",
      identityAnchor: input.identityAnchor,
      workflowFamily: "EYE_EXAM",
      occurredAt: input.occurredAt,
      fields: { kind: input.kind, synthetic: true },
      missingFields: [],
      confidence: 1,
      parserVersion: "preview-deterministic-1",
      lineageArtifactIds: [artifactId],
    };
    const attachedAt = input.occurredAt;
    const run = () => input.kind === "REGISTRATION"
      ? this.#path.recordTrigger(context, {
          artifact,
          factCard,
          expectation: {
            id: stableId("expectation", context, input.idempotencyKey),
            triggerKind: "REGISTRATION",
            consequenceKind: "EXAM_REPORT",
            triggeredAt: input.occurredAt,
            dueAt: new Date(Date.parse(input.occurredAt) + 15 * 60_000).toISOString(),
          },
          attachedAt,
          evaluatedAt: input.occurredAt,
        })
      : this.#path.recordConsequence(context, {
          artifact,
          factCard,
          expectationId: requireExpectationId(input.expectationId),
          attachedAt,
          evaluatedAt: input.occurredAt,
        });
    let result;
    try {
      result = await run();
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "ARTIFACT_ID_CONFLICT" || existingArtifact) throw error;
      const racedArtifact = await this.#capture.getArtifact(context, artifactId);
      if (!racedArtifact) throw error;
      artifact.createdAt = racedArtifact.createdAt;
      result = await run();
    }

    if (result.status === "REVIEW_REQUIRED") {
      return structuredClone({
        status: result.status,
        artifactId,
        workflowId: null,
        expectationId: null,
        expectationState: null,
        verificationStatus: null,
      });
    }
    return structuredClone({
      status: result.status,
      artifactId,
      workflowId: result.attachment.workflow.id,
      expectationId: result.expectation.expectation.id,
      expectationState: result.expectation.expectation.state,
      verificationStatus: result.verification.result.status,
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

function requireExpectationId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("EXPECTATION_ID_REQUIRED", "A server-issued Expectation ID is required.");
  }
  return value;
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

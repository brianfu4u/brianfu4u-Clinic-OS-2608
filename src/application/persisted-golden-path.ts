import { assertActorContext } from "../domain/access-context.ts";
import type {
  ActorContext,
  Artifact,
  EvidenceFactCard,
  Expectation,
  ExpectationSpec,
} from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { assertFactCardIdentitySource } from "../domain/identity-gate.ts";
import type { SavedCapture } from "../persistence/capture-repository.ts";
import type {
  InitializedExpectation,
  ReevaluatedExpectation,
} from "../persistence/expectation-repository.ts";
import { parseStrictIsoInstant } from "../persistence/strict-timestamp.ts";
import type { PersistedVerification } from "../persistence/verification-repository.ts";
import type { WorkflowAttachResult } from "../persistence/workflow-attach-repository.ts";

type CapturePort = {
  saveCapture(
    context: ActorContext,
    artifact: Artifact,
    factCard: EvidenceFactCard,
  ): Promise<SavedCapture>;
};

type AttachPort = {
  attachCapture(
    context: ActorContext,
    artifactId: string,
    factCardId: string,
    attachedAt: string,
  ): Promise<WorkflowAttachResult>;
};

type ExpectationPort = {
  getExpectation(context: ActorContext, expectationId: string): Promise<Expectation | null>;
  initializeExpectation(
    context: ActorContext,
    workflowId: string,
    spec: Omit<ExpectationSpec, "voided">,
    evaluatedAt: string,
  ): Promise<InitializedExpectation>;
  reevaluateExpectation(
    context: ActorContext,
    expectationId: string,
    evaluatedAt: string,
  ): Promise<ReevaluatedExpectation>;
};

type VerificationPort = {
  verifyCurrentExpectation(
    context: ActorContext,
    expectationId: string,
  ): Promise<PersistedVerification>;
};

export interface TriggerCommand {
  artifact: Artifact;
  factCard: EvidenceFactCard;
  expectation: Omit<ExpectationSpec, "voided">;
  attachedAt: string;
  evaluatedAt: string;
}

export interface ConsequenceCommand {
  artifact: Artifact;
  factCard: EvidenceFactCard;
  expectationId: string;
  attachedAt: string;
  evaluatedAt: string;
}

/**
 * Trigger replay returns the current durable Expectation projection together with
 * the original immutable initialization transition that established its lineage.
 * The projection may therefore be MET while the initialization transition remains OPEN.
 */
export type TriggerExpectationStage = InitializedExpectation;

export type PersistedTriggerResult =
  | {
      status: "COMPLETED";
      capture: SavedCapture;
      attachment: WorkflowAttachResult & { workflow: NonNullable<WorkflowAttachResult["workflow"]> };
      expectation: TriggerExpectationStage;
      verification: PersistedVerification;
    }
  | ReviewRequiredResult;

export type PersistedConsequenceResult =
  | {
      status: "COMPLETED";
      capture: SavedCapture;
      attachment: WorkflowAttachResult & { workflow: NonNullable<WorkflowAttachResult["workflow"]> };
      expectation: ReevaluatedExpectation;
      verification: PersistedVerification;
    }
  | ReviewRequiredResult;

export interface ReviewRequiredResult {
  status: "REVIEW_REQUIRED";
  capture: SavedCapture;
  attachment: Extract<WorkflowAttachResult, { workflow: null }>;
  expectation: null;
  verification: null;
}

export class PersistedGoldenPath {
  readonly #capture: CapturePort;
  readonly #attach: AttachPort;
  readonly #expectation: ExpectationPort;
  readonly #verification: VerificationPort;

  constructor(dependencies: {
    capture: CapturePort;
    attach: AttachPort;
    expectation: ExpectationPort;
    verification: VerificationPort;
  }) {
    this.#capture = dependencies.capture;
    this.#attach = dependencies.attach;
    this.#expectation = dependencies.expectation;
    this.#verification = dependencies.verification;
  }

  async recordTrigger(
    context: ActorContext,
    command: TriggerCommand,
  ): Promise<PersistedTriggerResult> {
    const captured = structuredClone({ context, command });
    validateTrigger(captured.context, captured.command);

    const capture = await this.#capture.saveCapture(
      captured.context,
      captured.command.artifact,
      captured.command.factCard,
    );
    const attachment = await this.#attach.attachCapture(
      captured.context,
      captured.command.artifact.id,
      captured.command.factCard.id,
      captured.command.attachedAt,
    );
    if (attachment.resolution.kind === "REVIEW_REQUIRED") {
      return structuredClone({
        status: "REVIEW_REQUIRED" as const,
        capture,
        attachment,
        expectation: null,
        verification: null,
      });
    }
    if (!attachment.workflow) {
      throw new DomainError("INVALID_ATTACH_RESULT", "Authoritative attach returned no Workflow.");
    }

    const expectation = await this.#expectation.initializeExpectation(
      captured.context,
      attachment.workflow.id,
      captured.command.expectation,
      captured.command.evaluatedAt,
    );
    const verification = await this.#verification.verifyCurrentExpectation(
      captured.context,
      captured.command.expectation.id,
    );
    return structuredClone({
      status: "COMPLETED" as const,
      capture,
      attachment,
      expectation,
      verification,
    });
  }

  async recordConsequence(
    context: ActorContext,
    command: ConsequenceCommand,
  ): Promise<PersistedConsequenceResult> {
    const captured = structuredClone({ context, command });
    validateConsequence(captured.context, captured.command);

    const capture = await this.#capture.saveCapture(
      captured.context,
      captured.command.artifact,
      captured.command.factCard,
    );
    const attachment = await this.#attach.attachCapture(
      captured.context,
      captured.command.artifact.id,
      captured.command.factCard.id,
      captured.command.attachedAt,
    );
    if (attachment.resolution.kind === "REVIEW_REQUIRED") {
      return structuredClone({
        status: "REVIEW_REQUIRED" as const,
        capture,
        attachment,
        expectation: null,
        verification: null,
      });
    }
    if (!attachment.workflow) {
      throw new DomainError("INVALID_ATTACH_RESULT", "Authoritative attach returned no Workflow.");
    }

    const current = await this.#expectation.getExpectation(
      captured.context,
      captured.command.expectationId,
    );
    if (!current) {
      throw new DomainError("EXPECTATION_NOT_FOUND", "Expectation is not readable in this clinic.");
    }
    if (current.workflowId !== attachment.workflow.id) {
      throw new DomainError(
        "EXPECTATION_WORKFLOW_MISMATCH",
        "Consequence and Expectation belong to different Workflows.",
      );
    }

    const expectation = await this.#expectation.reevaluateExpectation(
      captured.context,
      captured.command.expectationId,
      captured.command.evaluatedAt,
    );
    const verification = await this.#verification.verifyCurrentExpectation(
      captured.context,
      captured.command.expectationId,
    );
    return structuredClone({
      status: "COMPLETED" as const,
      capture,
      attachment,
      expectation,
      verification,
    });
  }
}

function validateTrigger(context: ActorContext, command: TriggerCommand): void {
  requireExactKeys(
    command as unknown as Record<string, unknown>,
    ["artifact", "attachedAt", "evaluatedAt", "expectation", "factCard"],
    "INVALID_TRIGGER_COMMAND",
  );
  validateCommon(context, command);
  requireExactKeys(
    command.expectation as unknown as Record<string, unknown>,
    ["consequenceKind", "dueAt", "id", "triggerKind", "triggeredAt"],
    "INVALID_EXPECTATION_SPEC",
  );
  const triggeredAt = requireTime(command.expectation.triggeredAt, "INVALID_EXPECTATION_TIME");
  const dueAt = requireTime(command.expectation.dueAt, "INVALID_EXPECTATION_TIME");
  if (triggeredAt > dueAt || triggeredAt > requireTime(command.evaluatedAt, "INVALID_EVALUATED_AT")) {
    throw new DomainError("INVALID_EXPECTATION_TIME", "Expectation time bounds are inconsistent.");
  }
  if (
    command.artifact.kind !== command.expectation.triggerKind ||
    command.artifact.occurredAt === null ||
    requireTime(command.artifact.occurredAt, "INVALID_ARTIFACT_TIME") !== triggeredAt
  ) {
    throw new DomainError(
      "EXPECTATION_TRIGGER_MISMATCH",
      "Trigger policy kind and occurrence must match the supplied Artifact.",
    );
  }
}

function validateConsequence(context: ActorContext, command: ConsequenceCommand): void {
  requireExactKeys(
    command as unknown as Record<string, unknown>,
    ["artifact", "attachedAt", "evaluatedAt", "expectationId", "factCard"],
    "INVALID_CONSEQUENCE_COMMAND",
  );
  validateCommon(context, command);
  if (typeof command.expectationId !== "string" || command.expectationId.trim() === "") {
    throw new DomainError("EXPECTATION_ID_REQUIRED", "Expectation ID is required.");
  }
}

function validateCommon(
  context: ActorContext,
  command: Pick<TriggerCommand, "artifact" | "factCard" | "attachedAt" | "evaluatedAt">,
): void {
  assertActorContext(context);
  const { artifact, factCard } = command;
  if (!artifact || !factCard || artifact.clinicId !== context.clinicId || factCard.clinicId !== context.clinicId) {
    throw new DomainError("TENANT_SCOPE_VIOLATION", "Command is outside this clinic scope.");
  }
  if (factCard.artifactId !== artifact.id) {
    throw new DomainError("FACT_CARD_ARTIFACT_MISMATCH", "FactCard must reference its supplied Artifact.");
  }
  if (!Array.isArray(factCard.lineageArtifactIds) || !factCard.lineageArtifactIds.includes(artifact.id)) {
    throw new DomainError("FACT_CARD_LINEAGE_INVALID", "FactCard lineage must contain its supplied Artifact.");
  }
  assertFactCardIdentitySource(factCard, artifact);

  const attachedAt = requireTime(command.attachedAt, "INVALID_ATTACHED_AT");
  const evaluatedAt = requireTime(command.evaluatedAt, "INVALID_EVALUATED_AT");
  requireTime(artifact.createdAt, "INVALID_ARTIFACT_TIME");
  if (artifact.occurredAt !== null) requireTime(artifact.occurredAt, "INVALID_ARTIFACT_TIME");
  if (factCard.occurredAt !== null) requireTime(factCard.occurredAt, "INVALID_FACT_CARD_TIME");
  if (attachedAt > evaluatedAt) {
    throw new DomainError("INVALID_COMMAND_TIME_ORDER", "Attachment must not follow evaluation.");
  }
}

function requireExactKeys(value: Record<string, unknown>, keys: string[], code: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== keys.join("|")) {
    throw new DomainError(code, "Command contains missing or caller-controlled fields.");
  }
}

function requireTime(value: unknown, code: string): number {
  const instant = parseStrictIsoInstant(value);
  if (instant === null) throw new DomainError(code, "An explicit valid zoned timestamp is required.");
  return instant;
}

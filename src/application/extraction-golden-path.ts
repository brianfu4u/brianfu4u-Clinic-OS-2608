import { assertActorContext } from "../domain/access-context.ts";
import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { parseStrictIsoInstant } from "../persistence/strict-timestamp.ts";
import {
  EYE_EXAM_EXTRACTION_SPEC,
  snapshotInertExtractionInput,
  type StoredEvidenceExtractionCommand,
  type StoredEvidenceExtractionResult,
  type StoredEvidenceExtractionService,
} from "./evidence-extraction.ts";
import type { PersistedConsequenceResult, PersistedGoldenPath } from "./persisted-golden-path.ts";
import type { ExtractionPersistenceRepository } from "../persistence/extraction-persistence-repository.ts";
import type { StoredObjectRef } from "../storage/contracts.ts";

export interface ProcessGoldenPathCommand {
  extraction: StoredEvidenceExtractionCommand;
  operation: {
    kind: "CONSEQUENCE";
    expectationId: string;
    attachedAt: string;
    evaluatedAt: string;
  };
}

export type ProcessGoldenPathResult =
  | {
      status: "COMPLETED";
      reviewStage: null;
      extraction: Extract<StoredEvidenceExtractionResult, { status: "READY" }>;
      goldenPath: PersistedConsequenceResult & { status: "COMPLETED" };
    }
  | {
      status: "REVIEW_REQUIRED";
      reviewStage: "EXTRACTION" | "COMPOSITION";
      extraction: StoredEvidenceExtractionResult;
      goldenPath: PersistedConsequenceResult | null;
    };

const COMMAND_KEYS = ["extraction", "operation"] as const;
const EXTRACTION_KEYS = [
  "artifactId", "createdAt", "factCardId", "identityAnchor", "kind", "objectRef",
  "occurredAt", "occurredAtSource", "requestId",
] as const;
const OPERATION_KEYS = ["attachedAt", "evaluatedAt", "expectationId", "kind"] as const;
const REF_KEYS = ["clinicId", "contentSha256", "mediaType", "objectId", "sizeBytes"] as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type ExtractionPort = Pick<StoredEvidenceExtractionService, "extract">;
type PersistencePort = Pick<ExtractionPersistenceRepository, "getExtraction" | "saveExtraction">;
type GoldenPathPort = Pick<PersistedGoldenPath, "recordConsequence">;

export class ExtractionGoldenPath {
  readonly #extractor: ExtractionPort;
  readonly #persistence: PersistencePort;
  readonly #goldenPath: GoldenPathPort;

  constructor(dependencies: {
    extractor: ExtractionPort;
    persistence: PersistencePort;
    goldenPath: GoldenPathPort;
  }) {
    if (!dependencies || typeof dependencies.extractor?.extract !== "function" ||
        typeof dependencies.persistence?.getExtraction !== "function" ||
        typeof dependencies.persistence?.saveExtraction !== "function" ||
        typeof dependencies.goldenPath?.recordConsequence !== "function") {
      throw new DomainError("INVALID_EXTRACTION_GOLDEN_PATH_DEPENDENCY", "Extraction golden-path dependencies are invalid.");
    }
    this.#extractor = dependencies.extractor;
    this.#persistence = dependencies.persistence;
    this.#goldenPath = dependencies.goldenPath;
  }

  async processGoldenPath(
    context: ActorContext,
    command: ProcessGoldenPathCommand,
  ): Promise<ProcessGoldenPathResult> {
    const captured = snapshotInertExtractionInput({ context, command });
    validateCommand(captured.context, captured.command);

    // This is deliberately the first acquired application port. A durable match
    // means object bytes and inference are never touched during a replay.
    let saved = await this.#persistence.getExtraction(
      captured.context,
      captured.command.extraction.requestId,
    );
    if (saved) {
      assertReplayIdentity(captured.context, captured.command.extraction, saved);
    } else {
      let extracted: StoredEvidenceExtractionResult;
      try {
        extracted = await this.#extractor.extract(captured.context, captured.command.extraction);
        extracted = snapshotInertExtractionInput(extracted);
      } catch (error) {
        throw controlled(error, "EXTRACTION_FAILED", "Evidence extraction failed.");
      }
      try {
        saved = await this.#persistence.saveExtraction(
          captured.context,
          captured.command.extraction.objectRef,
          extracted,
        );
      } catch (error) {
        // A concurrent first caller may have won the immutable request identity.
        // Reload only for the explicit request conflict; all other failures remain visible.
        if (!(error instanceof DomainError) || error.code !== "EXTRACTION_REQUEST_CONFLICT") throw error;
        saved = await this.#persistence.getExtraction(
          captured.context,
          captured.command.extraction.requestId,
        );
        if (!saved) throw error;
        assertReplayIdentity(captured.context, captured.command.extraction, saved);
      }
    }

    saved = snapshotInertExtractionInput(saved);
    assertReplayIdentity(captured.context, captured.command.extraction, saved);
    if (saved.status === "REVIEW_REQUIRED") {
      return structuredClone({
        status: "REVIEW_REQUIRED" as const,
        reviewStage: "EXTRACTION" as const,
        extraction: saved,
        goldenPath: null,
      });
    }

    let goldenPath: PersistedConsequenceResult;
    try {
      goldenPath = await this.#goldenPath.recordConsequence(captured.context, {
        artifact: saved.artifact,
        factCard: saved.factCard,
        expectationId: captured.command.operation.expectationId,
        attachedAt: captured.command.operation.attachedAt,
        evaluatedAt: captured.command.operation.evaluatedAt,
      });
      goldenPath = snapshotInertExtractionInput(goldenPath);
    } catch (error) {
      throw controlled(error, "GOLDEN_PATH_FAILED", "Persisted golden-path processing failed.");
    }
    if (goldenPath.status === "REVIEW_REQUIRED") {
      return structuredClone({
        status: "REVIEW_REQUIRED" as const,
        reviewStage: "COMPOSITION" as const,
        extraction: saved,
        goldenPath,
      });
    }
    return structuredClone({
      status: "COMPLETED" as const,
      reviewStage: null,
      extraction: saved,
      goldenPath,
    });
  }
}

function validateCommand(context: ActorContext, command: ProcessGoldenPathCommand): void {
  exactObject(context, ["actorId", "clinicId", "role"], "INVALID_ACTOR_CONTEXT");
  assertActorContext(context);
  if (!boundedId(context.clinicId) || !boundedId(context.actorId)) {
    throw new DomainError("INVALID_ACTOR_CONTEXT", "ActorContext identifiers are invalid.");
  }
  exactObject(command, COMMAND_KEYS, "INVALID_EXTRACTION_GOLDEN_PATH_COMMAND");
  exactObject(command.extraction, EXTRACTION_KEYS, "INVALID_EXTRACTION_COMMAND");
  exactObject(command.extraction.objectRef, REF_KEYS, "INVALID_STORED_OBJECT_REF");
  exactObject(command.operation, OPERATION_KEYS, "INVALID_CONSEQUENCE_OPERATION");
  const extraction = command.extraction;
  const operation = command.operation;
  if (![extraction.requestId, extraction.artifactId, extraction.factCardId].every(isId) ||
      extraction.kind !== EYE_EXAM_EXTRACTION_SPEC.artifactKind ||
      !["source", "employee_confirmed", "unknown"].includes(extraction.occurredAtSource) ||
      typeof extraction.identityAnchor !== "string" || extraction.identityAnchor.trim() === "" ||
      parseStrictIsoInstant(extraction.createdAt) === null ||
      (extraction.occurredAt !== null && parseStrictIsoInstant(extraction.occurredAt) === null) ||
      (extraction.occurredAt === null) !== (extraction.occurredAtSource === "unknown")) {
    throw new DomainError("INVALID_EXTRACTION_COMMAND", "Extraction command is invalid.");
  }
  validateObjectRef(extraction.objectRef, context.clinicId);
  if (operation.kind !== "CONSEQUENCE" || !isId(operation.expectationId)) {
    throw new DomainError("INVALID_CONSEQUENCE_OPERATION", "Consequence operation is invalid.");
  }
  const attachedAt = parseStrictIsoInstant(operation.attachedAt);
  const evaluatedAt = parseStrictIsoInstant(operation.evaluatedAt);
  if (attachedAt === null || evaluatedAt === null || attachedAt > evaluatedAt) {
    throw new DomainError("INVALID_COMMAND_TIME_ORDER", "Consequence times must be explicit and ordered.");
  }
  if (extraction.occurredAt !== null && parseStrictIsoInstant(extraction.occurredAt)! > evaluatedAt) {
    throw new DomainError("INVALID_COMMAND_TIME_ORDER", "Evidence occurrence must not follow evaluation.");
  }
}

function assertReplayIdentity(
  context: ActorContext,
  command: StoredEvidenceExtractionCommand,
  stored: StoredEvidenceExtractionResult,
): void {
  const payload = stored.artifact.payload;
  const storedRef = payload && typeof payload === "object" && !Array.isArray(payload) &&
    Object.hasOwn(payload, "storedObjectRef") ? (payload as { storedObjectRef: unknown }).storedObjectRef : null;
  const artifact = stored.artifact;
  const lineage = stored.lineage;
  if (stored.artifact.clinicId !== context.clinicId || storedRef === null ||
      !sameRef(storedRef, command.objectRef) ||
      artifact.id !== command.artifactId || artifact.clinicId !== context.clinicId ||
      artifact.kind !== command.kind || !sameInstant(artifact.occurredAt, command.occurredAt) ||
      artifact.occurredAtSource !== command.occurredAtSource ||
      artifact.identityAnchor !== command.identityAnchor || artifact.sourceEmployeeId !== context.actorId ||
      !sameInstant(artifact.createdAt, command.createdAt) || lineage.requestId !== command.requestId ||
      lineage.objectContentSha256 !== command.objectRef.contentSha256 ||
      lineage.providerKind !== EYE_EXAM_EXTRACTION_SPEC.providerKind ||
      lineage.modelId !== EYE_EXAM_EXTRACTION_SPEC.modelId ||
      lineage.modelManifestSha256 !== EYE_EXAM_EXTRACTION_SPEC.modelManifestSha256 ||
      lineage.capability !== EYE_EXAM_EXTRACTION_SPEC.capability ||
      lineage.schemaVersion !== EYE_EXAM_EXTRACTION_SPEC.schemaVersion ||
      lineage.policyVersion !== EYE_EXAM_EXTRACTION_SPEC.policyVersion ||
      lineage.parserVersion !== EYE_EXAM_EXTRACTION_SPEC.parserVersion ||
      (stored.status === "READY" && stored.factCard.id !== command.factCardId)) {
    throw new DomainError("EXTRACTION_REQUEST_CONFLICT", "Extraction request identity conflicts with durable lineage.");
  }
}

function validateObjectRef(ref: StoredObjectRef, clinicId: string): void {
  if (ref.clinicId !== clinicId || !isId(ref.objectId) || !/^[a-f0-9]{64}$/.test(ref.contentSha256) ||
      !Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes <= 0 || ref.sizeBytes > 25 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "application/pdf"].includes(ref.mediaType)) {
    throw new DomainError("INVALID_STORED_OBJECT_REF", "Stored object reference is invalid.");
  }
}

function sameRef(value: unknown, expected: StoredObjectRef): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<StoredObjectRef>;
  return ref.clinicId === expected.clinicId && ref.objectId === expected.objectId &&
    ref.contentSha256 === expected.contentSha256 && ref.sizeBytes === expected.sizeBytes &&
    ref.mediaType === expected.mediaType;
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  const leftMs = parseStrictIsoInstant(left);
  const rightMs = parseStrictIsoInstant(right);
  return leftMs !== null && rightMs !== null && leftMs === rightMs;
}

function exactObject(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw new DomainError(code, "Value must have the exact declared shape.");
  }
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value) && value.trim() !== "";
}

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256;
}

function controlled(error: unknown, fallbackCode: string, fallbackMessage: string): DomainError {
  return error instanceof DomainError ? error : new DomainError(fallbackCode, fallbackMessage);
}

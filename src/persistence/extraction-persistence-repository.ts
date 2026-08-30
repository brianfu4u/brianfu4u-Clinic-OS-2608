import {
  EYE_EXAM_EXTRACTION_SPEC,
  validateExtractionCandidateBoundary,
  validateExtractionSpec,
  type ExtractionCandidate,
  type ExtractionLineage,
  type ExtractionSpec,
  type StoredEvidenceExtractionResult,
} from "../application/evidence-extraction.ts";
import { assertActorContext } from "../domain/access-context.ts";
import type { ActorContext, Artifact, EvidenceFactCard } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import type { StoredObjectRef } from "../storage/contracts.ts";
import {
  artifactEqual,
  factCardEqual,
  findArtifact,
  findFactCard,
  insertArtifact,
  insertFactCard,
  semanticEqual,
  validateCapture,
} from "./capture-repository.ts";
import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";
import { parseStrictIsoInstant } from "./strict-timestamp.ts";
import { withTenantTransaction } from "./tenant-transaction.ts";

type AttemptRow = {
  request_id: string;
  object_id: string;
  object_content_sha256: string;
  artifact_id: string;
  fact_card_id: string | null;
  status: StoredEvidenceExtractionResult["status"];
  candidate: unknown;
  reason_codes: string[];
  provider_kind: ExtractionLineage["providerKind"];
  model_id: string;
  model_manifest_sha256: string;
  capability: string;
  schema_version: string;
  policy_version: string;
  parser_version: string;
  completed_at: Date | string;
};

type ObjectRow = {
  clinic_id: string;
  object_id: string;
  content_sha256: string;
  size_bytes: number | string;
  media_type: string;
};

const ATTEMPT_COLUMNS = `
  request_id, object_id, object_content_sha256, artifact_id, fact_card_id, status,
  candidate, reason_codes, provider_kind, model_id, model_manifest_sha256, capability,
  schema_version, policy_version, parser_version, completed_at
`;
const RESULT_KEYS = ["artifact", "candidate", "factCard", "lineage", "reasonCodes", "status"];
const LINEAGE_KEYS = [
  "capability", "completedAt", "modelId", "modelManifestSha256", "objectContentSha256",
  "parserVersion", "policyVersion", "providerKind", "requestId", "schemaVersion",
];
const REF_KEYS = ["clinicId", "contentSha256", "mediaType", "objectId", "sizeBytes"];
const ARTIFACT_KEYS = [
  "clinicId", "createdAt", "id", "identityAnchor", "kind", "occurredAt", "occurredAtSource",
  "payload", "sourceEmployeeId",
];
const FACT_CARD_KEYS = [
  "artifactId", "clinicId", "confidence", "fields", "id", "identityAnchor",
  "lineageArtifactIds", "missingFields", "occurredAt", "parserVersion", "subjectType",
  "workflowFamily",
];
const REVIEW_REASONS = ["LOW_CONFIDENCE", "REQUIRED_FIELDS_MISSING"] as const;

export class ExtractionPersistenceRepository {
  readonly #pool: DatabasePool;
  readonly #spec: ExtractionSpec;

  constructor(pool: DatabasePool, spec: ExtractionSpec = EYE_EXAM_EXTRACTION_SPEC) {
    this.#pool = pool;
    try {
      this.#spec = validateExtractionSpec(structuredClone(spec));
    } catch {
      throw new DomainError("INVALID_EXTRACTION_SPEC", "Extraction specification is invalid.");
    }
  }

  async saveExtraction(
    context: ActorContext,
    objectRef: StoredObjectRef,
    result: StoredEvidenceExtractionResult,
  ): Promise<StoredEvidenceExtractionResult> {
    let captured: { context: ActorContext; objectRef: StoredObjectRef; result: StoredEvidenceExtractionResult };
    try {
      captured = structuredClone({ context, objectRef, result });
      validateExtraction(captured.context, captured.objectRef, captured.result, this.#spec);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("INVALID_EXTRACTION_PERSISTENCE_INPUT", "Extraction persistence input is invalid.");
    }

    try {
      return await withTenantTransaction(this.#pool, captured.context.clinicId, async (client) => {
        await insertObjectRef(client, captured.context.clinicId, captured.objectRef);
        const storedRef = await findObjectRef(client, captured.context.clinicId, captured.objectRef.objectId);
        if (!storedRef || !semanticEqual(storedRef, captured.objectRef)) {
          throw new DomainError("STORED_OBJECT_REF_CONFLICT", "Stored object ID is already used by different content.");
        }

        await insertArtifact(client, captured.context.clinicId, captured.result.artifact);
        const artifact = await findArtifact(client, captured.context.clinicId, captured.result.artifact.id);
        if (!artifact || !artifactEqual(artifact, captured.result.artifact)) {
          throw new DomainError("ARTIFACT_ID_CONFLICT", "Artifact ID is already used by different content.");
        }

        let factCard: EvidenceFactCard | null = null;
        if (captured.result.status === "READY") {
          await insertFactCard(client, captured.context.clinicId, captured.result.factCard);
          factCard = await findFactCard(client, captured.context.clinicId, captured.result.factCard.id);
          if (!factCard || !factCardEqual(factCard, captured.result.factCard)) {
            throw new DomainError("FACT_CARD_ID_CONFLICT", "FactCard ID is already used by different content.");
          }
        }

        await insertAttempt(client, captured.context.clinicId, captured.result);
        const attempt = await findAttempt(client, captured.context.clinicId, captured.result.lineage.requestId);
        if (!attempt || !attemptEqual(attempt, captured.result, captured.objectRef)) {
          throw new DomainError("EXTRACTION_REQUEST_CONFLICT", "Extraction request ID is already used by different content.");
        }
        return resultFromRows(artifact, factCard, attempt);
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("EXTRACTION_PERSISTENCE_FAILED", "Extraction persistence failed.");
    }
  }
}

function validateExtraction(
  context: ActorContext,
  objectRef: StoredObjectRef,
  result: StoredEvidenceExtractionResult,
  spec: ExtractionSpec,
): void {
  exactObject(context, ["actorId", "clinicId", "role"], "INVALID_ACTOR_CONTEXT");
  assertActorContext(context);
  exactObject(objectRef, REF_KEYS, "INVALID_STORED_OBJECT_REF");
  validateObjectRef(objectRef);
  exactObject(result, RESULT_KEYS, "INVALID_EXTRACTION_PERSISTENCE_INPUT");
  exactObject(result.artifact, ARTIFACT_KEYS, "INVALID_EXTRACTION_PERSISTENCE_INPUT");
  exactObject(result.lineage, LINEAGE_KEYS, "INVALID_EXTRACTION_LINEAGE");
  if (objectRef.clinicId !== context.clinicId || result.artifact.clinicId !== context.clinicId) {
    throw new DomainError("TENANT_SCOPE_VIOLATION", "Extraction is outside this clinic scope.");
  }
  const payload = result.artifact.payload;
  if (![result.artifact.id, result.artifact.kind, result.artifact.sourceEmployeeId].every(nonblank) ||
    result.artifact.sourceEmployeeId !== context.actorId || result.artifact.kind !== "EXAM_REPORT" ||
    parseStrictIsoInstant(result.artifact.createdAt) === null ||
    (result.artifact.occurredAt !== null && parseStrictIsoInstant(result.artifact.occurredAt) === null) ||
    (result.artifact.occurredAt === null) !== (result.artifact.occurredAtSource === "unknown") ||
    !["source", "employee_confirmed", "unknown"].includes(result.artifact.occurredAtSource) ||
    !nonblank(result.artifact.identityAnchor)) {
    throw new DomainError("INVALID_EXTRACTION_PERSISTENCE_INPUT", "Extraction Artifact is invalid.");
  }
  if (!plainObject(payload) || Object.keys(payload).length !== 1 || !("storedObjectRef" in payload) ||
    !semanticEqual(payload.storedObjectRef, objectRef)) {
    throw new DomainError("STORED_OBJECT_REF_MISMATCH", "Artifact must contain the exact stored object reference.");
  }
  const candidate = validateExtractionCandidateBoundary(result.candidate, spec);
  validateLineage(result.lineage, objectRef, spec);
  const expectedReasons = [
    ...(candidate.confidence < spec.minimumConfidence ? ["LOW_CONFIDENCE"] : []),
    ...(candidate.missingFields.length > 0 ? ["REQUIRED_FIELDS_MISSING"] : []),
  ];
  if (!semanticEqual(result.reasonCodes, expectedReasons)) {
    throw new DomainError("INVALID_EXTRACTION_OUTCOME", "Extraction reasons contradict the validated candidate.");
  }
  if (result.status === "READY") {
    if (result.factCard === null || expectedReasons.length !== 0) {
      throw new DomainError("INVALID_EXTRACTION_OUTCOME", "READY extraction requires an accepted FactCard.");
    }
    exactObject(result.factCard, FACT_CARD_KEYS, "INVALID_EXTRACTION_PERSISTENCE_INPUT");
    if (![result.factCard.id, result.factCard.artifactId, result.factCard.subjectType,
      result.factCard.workflowFamily, result.factCard.parserVersion].every(nonblank) ||
      !plainObject(result.factCard.fields) || !Array.isArray(result.factCard.missingFields) ||
      !Array.isArray(result.factCard.lineageArtifactIds) || !Number.isFinite(result.factCard.confidence) ||
      result.factCard.confidence < 0 || result.factCard.confidence > 1 ||
      (result.factCard.occurredAt !== null && parseStrictIsoInstant(result.factCard.occurredAt) === null)) {
      throw new DomainError("INVALID_EXTRACTION_PERSISTENCE_INPUT", "Extraction FactCard is invalid.");
    }
    validateCapture(context, result.artifact, result.factCard);
    if (result.factCard.subjectType !== candidate.subjectTypeCandidate ||
      result.factCard.workflowFamily !== candidate.workflowFamilyCandidate ||
      instantOrNull(result.factCard.occurredAt) !== instantOrNull(result.artifact.occurredAt) ||
      !semanticEqual(result.factCard.fields, candidate.fields) ||
      !semanticEqual(result.factCard.missingFields, candidate.missingFields) ||
      result.factCard.confidence !== candidate.confidence ||
      result.factCard.parserVersion !== result.lineage.parserVersion) {
      throw new DomainError("INVALID_EXTRACTION_OUTCOME", "FactCard contradicts the validated candidate or lineage.");
    }
  } else if (result.status === "REVIEW_REQUIRED") {
    if (result.factCard !== null || expectedReasons.length === 0) {
      throw new DomainError("INVALID_EXTRACTION_OUTCOME", "Review extraction must have reasons and no FactCard.");
    }
  } else {
    throw new DomainError("INVALID_EXTRACTION_OUTCOME", "Extraction status is invalid.");
  }
}

function validateLineage(lineage: ExtractionLineage, objectRef: StoredObjectRef, spec: ExtractionSpec): void {
  if (![lineage.requestId, lineage.modelId, lineage.capability, lineage.schemaVersion,
    lineage.policyVersion, lineage.parserVersion].every(nonblank) ||
    !["LOCAL_MODEL", "PRIVATE_CLOUD_MODEL"].includes(lineage.providerKind) ||
    !/^[a-f0-9]{64}$/.test(lineage.modelManifestSha256) ||
    lineage.providerKind !== spec.providerKind || lineage.modelId !== spec.modelId ||
    lineage.modelManifestSha256 !== spec.modelManifestSha256 ||
    lineage.capability !== spec.capability || lineage.schemaVersion !== spec.schemaVersion ||
    lineage.policyVersion !== spec.policyVersion || lineage.parserVersion !== spec.parserVersion ||
    lineage.objectContentSha256 !== objectRef.contentSha256 ||
    parseStrictIsoInstant(lineage.completedAt) === null) {
    throw new DomainError("INVALID_EXTRACTION_LINEAGE", "Extraction lineage is invalid.");
  }
}

function validateObjectRef(ref: StoredObjectRef): void {
  if (!nonblank(ref.clinicId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref.objectId) ||
    !/^[a-f0-9]{64}$/.test(ref.contentSha256) || !Number.isSafeInteger(ref.sizeBytes) ||
    ref.sizeBytes <= 0 || ref.sizeBytes > 25 * 1024 * 1024 ||
    !["image/png", "image/jpeg", "application/pdf"].includes(ref.mediaType)) {
    throw new DomainError("INVALID_STORED_OBJECT_REF", "Stored object reference is invalid.");
  }
}

async function insertObjectRef(client: TenantQueryClient, clinicId: string, ref: StoredObjectRef) {
  await client.query(
    `INSERT INTO stored_object_ref (clinic_id,object_id,content_sha256,size_bytes,media_type)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (clinic_id,object_id) DO NOTHING`,
    [clinicId, ref.objectId, ref.contentSha256, ref.sizeBytes, ref.mediaType],
  );
}

async function findObjectRef(client: TenantQueryClient, clinicId: string, objectId: string) {
  const result = await client.query<ObjectRow>(
    `SELECT clinic_id,object_id,content_sha256,size_bytes,media_type
       FROM stored_object_ref WHERE clinic_id=$1 AND object_id=$2`,
    [clinicId, objectId],
  );
  const row = result.rows[0];
  return row ? {
    clinicId: row.clinic_id,
    objectId: row.object_id,
    contentSha256: row.content_sha256,
    sizeBytes: Number(row.size_bytes),
    mediaType: row.media_type,
  } : null;
}

async function insertAttempt(
  client: TenantQueryClient,
  clinicId: string,
  result: StoredEvidenceExtractionResult,
) {
  await client.query(
    `INSERT INTO evidence_extraction_attempt (${ATTEMPT_COLUMNS},clinic_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (clinic_id,request_id) DO NOTHING`,
    [
      result.lineage.requestId, (result.artifact.payload as { storedObjectRef: StoredObjectRef }).storedObjectRef.objectId,
      result.lineage.objectContentSha256, result.artifact.id,
      result.status === "READY" ? result.factCard.id : null, result.status, result.candidate,
      result.reasonCodes, result.lineage.providerKind, result.lineage.modelId,
      result.lineage.modelManifestSha256, result.lineage.capability, result.lineage.schemaVersion,
      result.lineage.policyVersion, result.lineage.parserVersion, result.lineage.completedAt, clinicId,
    ],
  );
}

async function findAttempt(client: TenantQueryClient, clinicId: string, requestId: string) {
  const result = await client.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM evidence_extraction_attempt WHERE clinic_id=$1 AND request_id=$2`,
    [clinicId, requestId],
  );
  return result.rows[0] ?? null;
}

function attemptEqual(row: AttemptRow, result: StoredEvidenceExtractionResult, ref: StoredObjectRef): boolean {
  return semanticEqual(attemptProjection(row), {
    requestId: result.lineage.requestId,
    objectId: ref.objectId,
    objectContentSha256: ref.contentSha256,
    artifactId: result.artifact.id,
    factCardId: result.status === "READY" ? result.factCard.id : null,
    status: result.status,
    candidate: result.candidate,
    reasonCodes: result.reasonCodes,
    providerKind: result.lineage.providerKind,
    modelId: result.lineage.modelId,
    modelManifestSha256: result.lineage.modelManifestSha256,
    capability: result.lineage.capability,
    schemaVersion: result.lineage.schemaVersion,
    policyVersion: result.lineage.policyVersion,
    parserVersion: result.lineage.parserVersion,
    completedAt: instant(result.lineage.completedAt),
  });
}

function attemptProjection(row: AttemptRow) {
  return {
    requestId: row.request_id, objectId: row.object_id,
    objectContentSha256: row.object_content_sha256, artifactId: row.artifact_id,
    factCardId: row.fact_card_id, status: row.status, candidate: structuredClone(row.candidate),
    reasonCodes: [...row.reason_codes], providerKind: row.provider_kind, modelId: row.model_id,
    modelManifestSha256: row.model_manifest_sha256, capability: row.capability,
    schemaVersion: row.schema_version, policyVersion: row.policy_version,
    parserVersion: row.parser_version, completedAt: instant(timestamp(row.completed_at)),
  };
}

function resultFromRows(
  artifact: Artifact,
  factCard: EvidenceFactCard | null,
  attempt: AttemptRow,
): StoredEvidenceExtractionResult {
  const candidate = structuredClone(attempt.candidate) as ExtractionCandidate;
  const lineage: ExtractionLineage = {
    requestId: attempt.request_id, providerKind: attempt.provider_kind, modelId: attempt.model_id,
    modelManifestSha256: attempt.model_manifest_sha256, capability: attempt.capability,
    schemaVersion: attempt.schema_version, policyVersion: attempt.policy_version,
    parserVersion: attempt.parser_version, completedAt: timestamp(attempt.completed_at),
    objectContentSha256: attempt.object_content_sha256,
  };
  if (attempt.status === "READY" && factCard) {
    return structuredClone({ status: "READY", artifact, factCard, candidate, reasonCodes: [], lineage });
  }
  return structuredClone({
    status: "REVIEW_REQUIRED", artifact, factCard: null, candidate,
    reasonCodes: [...attempt.reason_codes] as Array<(typeof REVIEW_REASONS)[number]>, lineage,
  });
}

function exactObject(value: unknown, keys: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!plainObject(value) || Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))) {
    throw new DomainError(code, "Value must have the exact declared shape.");
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function instant(value: string): number | string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : parsed;
}

function instantOrNull(value: string | null): number | string | null {
  return value === null ? null : instant(value);
}

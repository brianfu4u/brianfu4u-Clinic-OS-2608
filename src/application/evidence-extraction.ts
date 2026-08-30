import { createHash } from "node:crypto";
import { types } from "node:util";

import { assertActorContext } from "../domain/access-context.ts";
import type { ActorContext, Artifact, EvidenceFactCard } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { assertFactCardIdentitySource, requireClinicalIdentity } from "../domain/identity-gate.ts";
import { parseStrictIsoInstant } from "../persistence/strict-timestamp.ts";
import type { InferenceRequest, InferenceResponse } from "../runtime/contracts.ts";
import { InferenceGateway } from "../runtime/inference-gateway.ts";
import type { ProviderGetResponse, StoredObjectRef } from "../storage/contracts.ts";
import { ObjectStoreGateway } from "../storage/object-store-gateway.ts";

const COMMAND_KEYS = [
  "artifactId", "createdAt", "factCardId", "identityAnchor", "kind", "objectRef",
  "occurredAt", "occurredAtSource", "requestId",
];
const CANDIDATE_KEYS = [
  "confidence", "fields", "missingFields", "subjectTypeCandidate", "workflowFamilyCandidate",
];
const REF_KEYS = ["clinicId", "contentSha256", "mediaType", "objectId", "sizeBytes"];
const SPEC_KEYS = [
  "allowedMediaTypes", "artifactKind", "capability", "minimumConfidence", "parserVersion",
  "policyVersion", "providerKind", "modelId", "modelManifestSha256", "requiredFields", "schemaVersion", "subjectType",
  "workflowFamily",
];
const RESPONSE_KEYS = [
  "completedAt", "modelId", "output", "providerKind", "requestId", "schemaVersion",
];
const ALLOWED_MEDIA = ["application/pdf", "image/jpeg", "image/png"] as const;
const FORBIDDEN_KEYS = new Set([
  "action", "actorId", "artifactId", "attachedAt", "clinicId", "createdAt", "decidedAt",
  "decisionId", "decisionSource", "evaluatedAt", "expectationId", "factCardId", "identityAnchor",
  "lineage", "lineageArtifactIds", "linkId", "occurredAt", "receivedAt", "reasoningChain", "role",
  "satisfiedByArtifactId", "sourceEmployeeId", "state", "status", "triggerArtifactId", "triggeredAt",
  "consequenceArtifactId", "dueAt", "evidenceArtifactIds", "updatedAt", "verificationId", "voided",
  "workflowId", "artifact", "factCard", "workflow", "link", "expectation", "verification",
  "decision", "verdict",
]);
const MAX_FIELD_COUNT = 64;
const MAX_FIELDS_JSON_BYTES = 64 * 1024;
const MAX_CANDIDATE_ARRAY_LENGTH = 256;
const MAX_CANDIDATE_NODES = 4096;
const MAX_CANDIDATE_STRING_BYTES = 64 * 1024;
const MAX_PERSISTENCE_INPUT_NODES = 16_384;
const MAX_PERSISTENCE_INPUT_STRING_BYTES = 256 * 1024;

export interface ExtractionSpec {
  capability: string;
  schemaVersion: string;
  policyVersion: string;
  parserVersion: string;
  allowedMediaTypes: readonly string[];
  artifactKind: string;
  subjectType: string;
  workflowFamily: string;
  requiredFields: readonly string[];
  minimumConfidence: number;
  providerKind: InferenceResponse["providerKind"];
  modelId: string;
  modelManifestSha256: string;
}

export const EYE_EXAM_EXTRACTION_SPEC: Readonly<ExtractionSpec> = Object.freeze({
  capability: "EXTRACT_EYE_EXAM_REPORT",
  schemaVersion: "eye-exam-candidate-v1",
  policyVersion: "stored-evidence-policy-v1",
  parserVersion: "stored-evidence-parser-v1",
  allowedMediaTypes: Object.freeze([...ALLOWED_MEDIA]),
  artifactKind: "EXAM_REPORT",
  subjectType: "PATIENT",
  workflowFamily: "EYE_EXAM",
  requiredFields: Object.freeze(["reportType"]),
  minimumConfidence: 0.8,
  providerKind: "LOCAL_MODEL",
  modelId: "deterministic-local-fixture",
  modelManifestSha256: "a80e69f3d4cf77067b0867b75d16ab6fc9b9f68c0caa65f6883923c70ca9cc16",
});

export interface StoredEvidenceExtractionCommand {
  requestId: string;
  artifactId: string;
  factCardId: string;
  objectRef: StoredObjectRef;
  kind: string;
  occurredAt: string | null;
  occurredAtSource: Artifact["occurredAtSource"];
  identityAnchor: string | null;
  createdAt: string;
}

export interface ExtractionCandidate {
  subjectTypeCandidate: string;
  workflowFamilyCandidate: string;
  fields: Record<string, unknown>;
  missingFields: string[];
  confidence: number;
}

export interface ExtractionLineage {
  requestId: string;
  providerKind: InferenceResponse["providerKind"];
  modelId: string;
  modelManifestSha256: string;
  capability: string;
  schemaVersion: string;
  policyVersion: string;
  parserVersion: string;
  completedAt: string;
  objectContentSha256: string;
}

export type StoredEvidenceExtractionResult =
  | {
      status: "READY";
      artifact: Artifact;
      factCard: EvidenceFactCard;
      candidate: ExtractionCandidate;
      reasonCodes: [];
      lineage: ExtractionLineage;
    }
  | {
      status: "REVIEW_REQUIRED";
      artifact: Artifact;
      factCard: null;
      candidate: ExtractionCandidate;
      reasonCodes: Array<"LOW_CONFIDENCE" | "REQUIRED_FIELDS_MISSING">;
      lineage: ExtractionLineage;
    };

export class StoredEvidenceExtractionService {
  readonly #objects: ObjectStoreGateway;
  readonly #inference: InferenceGateway;
  readonly #spec: ExtractionSpec;

  constructor(dependencies: {
    objects: ObjectStoreGateway;
    inference: InferenceGateway;
    spec?: ExtractionSpec;
  }) {
    if (!dependencies || !(dependencies.objects instanceof ObjectStoreGateway) ||
      !(dependencies.inference instanceof InferenceGateway)) {
      throw new DomainError("INVALID_EXTRACTION_DEPENDENCY", "Extraction dependencies are invalid.");
    }
    this.#objects = dependencies.objects;
    this.#inference = dependencies.inference;
    this.#spec = validateExtractionSpec(structuredClone(dependencies.spec ?? EYE_EXAM_EXTRACTION_SPEC));
  }

  async extract(
    context: ActorContext,
    command: StoredEvidenceExtractionCommand,
  ): Promise<StoredEvidenceExtractionResult> {
    exactObject(context, ["actorId", "clinicId", "role"], "INVALID_ACTOR_CONTEXT");
    const captured = structuredClone({ context, command });
    assertActorContext(captured.context);
    validateCommand(captured.context, captured.command, this.#spec);

    const storedResponse = await this.#objects.get(captured.context, {
      objectId: captured.command.objectRef.objectId,
    });
    const stored = validateStoredObject(storedResponse, captured.command.objectRef);

    const inferenceRequest: InferenceRequest = {
      requestId: captured.command.requestId,
      clinicId: captured.context.clinicId,
      capability: this.#spec.capability,
      schemaVersion: this.#spec.schemaVersion,
      input: {
        bytes: new Uint8Array(stored.bytes),
        mediaType: stored.ref.mediaType,
        contentSha256: stored.ref.contentSha256,
        kind: captured.command.kind,
      },
    };
    const response = validateInferenceResponse(
      await this.#inference.infer(captured.context, inferenceRequest),
      inferenceRequest,
      this.#spec,
    );
    const candidate = validateCandidate(response.output, this.#spec);
    const artifact: Artifact = {
      id: captured.command.artifactId,
      clinicId: captured.context.clinicId,
      kind: captured.command.kind,
      occurredAt: captured.command.occurredAt,
      occurredAtSource: captured.command.occurredAtSource,
      sourceEmployeeId: captured.context.actorId,
      identityAnchor: captured.command.identityAnchor,
      payload: { storedObjectRef: structuredClone(captured.command.objectRef) },
      createdAt: captured.command.createdAt,
    };
    const lineage: ExtractionLineage = {
      requestId: response.requestId,
      providerKind: response.providerKind,
      modelId: response.modelId,
      modelManifestSha256: this.#spec.modelManifestSha256,
      capability: this.#spec.capability,
      schemaVersion: response.schemaVersion,
      policyVersion: this.#spec.policyVersion,
      parserVersion: this.#spec.parserVersion,
      completedAt: response.completedAt,
      objectContentSha256: stored.ref.contentSha256,
    };
    const reasonCodes: Array<"LOW_CONFIDENCE" | "REQUIRED_FIELDS_MISSING"> = [];
    if (candidate.confidence < this.#spec.minimumConfidence) reasonCodes.push("LOW_CONFIDENCE");
    if (candidate.missingFields.length > 0) reasonCodes.push("REQUIRED_FIELDS_MISSING");
    if (reasonCodes.length > 0) {
      return structuredClone({
        status: "REVIEW_REQUIRED" as const,
        artifact,
        factCard: null,
        candidate,
        reasonCodes,
        lineage,
      });
    }

    const factCard: EvidenceFactCard = {
      id: captured.command.factCardId,
      clinicId: artifact.clinicId,
      artifactId: artifact.id,
      subjectType: candidate.subjectTypeCandidate,
      identityAnchor: artifact.identityAnchor,
      workflowFamily: candidate.workflowFamilyCandidate,
      occurredAt: artifact.occurredAt,
      fields: structuredClone(candidate.fields),
      missingFields: [...candidate.missingFields],
      confidence: candidate.confidence,
      parserVersion: this.#spec.parserVersion,
      lineageArtifactIds: [artifact.id],
    };
    requireClinicalIdentity(factCard);
    assertFactCardIdentitySource(factCard, artifact);
    return structuredClone({
      status: "READY" as const,
      artifact,
      factCard,
      candidate,
      reasonCodes: [] as [],
      lineage,
    });
  }
}

export function validateExtractionSpec(spec: ExtractionSpec): ExtractionSpec {
  exactObject(spec, SPEC_KEYS, "INVALID_EXTRACTION_SPEC");
  if (!nonblank(spec.capability) || !nonblank(spec.schemaVersion) ||
    !nonblank(spec.policyVersion) || !nonblank(spec.parserVersion) ||
    spec.artifactKind !== "EXAM_REPORT" || spec.subjectType !== "PATIENT" ||
    spec.workflowFamily !== "EYE_EXAM" || !Array.isArray(spec.allowedMediaTypes) ||
    spec.allowedMediaTypes.length !== ALLOWED_MEDIA.length ||
    !ALLOWED_MEDIA.every((value) => spec.allowedMediaTypes.includes(value)) ||
    !Array.isArray(spec.requiredFields) || spec.requiredFields.length === 0 ||
    spec.requiredFields.some((field) => !nonblank(field)) ||
    new Set(spec.requiredFields).size !== spec.requiredFields.length ||
    !Number.isFinite(spec.minimumConfidence) || spec.minimumConfidence < 0 ||
    spec.minimumConfidence > 1 || spec.providerKind !== "LOCAL_MODEL" || !nonblank(spec.modelId) ||
    !/^[a-f0-9]{64}$/.test(spec.modelManifestSha256)) {
    throw new DomainError("INVALID_EXTRACTION_SPEC", "Extraction specification is invalid.");
  }
  return Object.freeze({
    ...spec,
    allowedMediaTypes: Object.freeze([...spec.allowedMediaTypes]),
    requiredFields: Object.freeze([...spec.requiredFields]),
  });
}

function validateCommand(
  context: ActorContext,
  command: StoredEvidenceExtractionCommand,
  spec: ExtractionSpec,
): void {
  exactObject(command, COMMAND_KEYS, "INVALID_EXTRACTION_COMMAND");
  if (![command.requestId, command.artifactId, command.factCardId].every(nonblank) ||
    command.kind !== spec.artifactKind ||
    !["source", "employee_confirmed", "unknown"].includes(command.occurredAtSource) ||
    parseStrictIsoInstant(command.createdAt) === null ||
    (command.occurredAt !== null && parseStrictIsoInstant(command.occurredAt) === null) ||
    (command.occurredAt === null) !== (command.occurredAtSource === "unknown")) {
    throw new DomainError("INVALID_EXTRACTION_COMMAND", "Extraction command is invalid.");
  }
  validateObjectRef(command.objectRef);
  if (command.objectRef.clinicId !== context.clinicId) {
    throw new DomainError("TENANT_SCOPE_VIOLATION", "Stored object is outside this clinic scope.");
  }
  if (!spec.allowedMediaTypes.includes(command.objectRef.mediaType)) {
    throw new DomainError("UNSUPPORTED_EVIDENCE_MEDIA_TYPE", "Stored object media type is unsupported.");
  }
  if (!nonblank(command.identityAnchor)) {
    throw new DomainError("IDENTITY_ANCHOR_REQUIRED", "Patient evidence requires an exact identity anchor.");
  }
}

function validateStoredObject(response: ProviderGetResponse, expected: StoredObjectRef): ProviderGetResponse {
  let snapshot: ProviderGetResponse;
  try {
    snapshot = structuredClone(response);
  } catch {
    throw new DomainError("STORED_OBJECT_MISMATCH", "Stored object response is invalid.");
  }
  validateObjectRef(snapshot.ref);
  if (!(snapshot.bytes instanceof Uint8Array) || snapshot.bytes.byteLength !== expected.sizeBytes ||
    createHash("sha256").update(snapshot.bytes).digest("hex") !== expected.contentSha256 ||
    !sameRef(snapshot.ref, expected)) {
    throw new DomainError("STORED_OBJECT_MISMATCH", "Stored object does not match its trusted reference.");
  }
  return snapshot;
}

function validateObjectRef(ref: StoredObjectRef): void {
  exactObject(ref, REF_KEYS, "INVALID_STORED_OBJECT_REF");
  if (!nonblank(ref.clinicId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref.objectId) ||
    !/^[a-f0-9]{64}$/.test(ref.contentSha256) || !Number.isSafeInteger(ref.sizeBytes) ||
    ref.sizeBytes <= 0 || !nonblank(ref.mediaType)) {
    throw new DomainError("INVALID_STORED_OBJECT_REF", "Stored object reference is invalid.");
  }
}

function validateCandidate(output: unknown, spec: ExtractionSpec): ExtractionCandidate {
  let candidate: ExtractionCandidate;
  try {
    assertSafeCandidateData(output, 0, { nodes: 0, stringBytes: 0 });
    candidate = structuredClone(output) as ExtractionCandidate;
  } catch {
    throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction candidate is not cloneable.");
  }
  exactObject(candidate, CANDIDATE_KEYS, "INVALID_EXTRACTION_CANDIDATE");
  if (candidate.subjectTypeCandidate !== spec.subjectType ||
    candidate.workflowFamilyCandidate !== spec.workflowFamily ||
    !plainObject(candidate.fields) || Object.keys(candidate.fields).length > MAX_FIELD_COUNT ||
    !Array.isArray(candidate.missingFields) || !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 || candidate.confidence > 1) {
    throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction candidate violates the frozen schema.");
  }
  validateJson(candidate.fields, 0);
  if (Buffer.byteLength(JSON.stringify(candidate.fields)) > MAX_FIELDS_JSON_BYTES) {
    throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction candidate fields are too large.");
  }
  if (candidate.missingFields.some((field) => !spec.requiredFields.includes(field)) ||
    new Set(candidate.missingFields).size !== candidate.missingFields.length ||
    candidate.missingFields.some((field) => !missingValue(candidate.fields[field]))) {
    throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction missing fields are inconsistent.");
  }
  const derivedMissing = spec.requiredFields.filter((field) => missingValue(candidate.fields[field]));
  return Object.freeze({
    ...candidate,
    fields: structuredClone(candidate.fields),
    missingFields: Object.freeze([...derivedMissing]) as unknown as string[],
  });
}

export function validateExtractionCandidateBoundary(
  value: unknown,
  spec: ExtractionSpec = EYE_EXAM_EXTRACTION_SPEC,
): ExtractionCandidate {
  return structuredClone(validateCandidate(value, spec));
}

function validateInferenceResponse(
  value: unknown,
  request: InferenceRequest,
  spec: ExtractionSpec,
): InferenceResponse {
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (!plainObject(value) || Reflect.ownKeys(value).some((key) => typeof key === "symbol")) throw new Error();
    descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value"))) throw new Error();
  } catch {
    throw new DomainError("INVALID_INFERENCE_RESPONSE", "Inference response envelope is invalid.");
  }
  const response = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  ) as unknown as InferenceResponse;
  exactObject(response, RESPONSE_KEYS, "INVALID_INFERENCE_RESPONSE");
  if (response.requestId !== request.requestId || response.schemaVersion !== request.schemaVersion ||
    response.providerKind !== spec.providerKind || response.modelId !== spec.modelId ||
    parseStrictIsoInstant(response.completedAt) === null) {
    throw new DomainError("INVALID_INFERENCE_RESPONSE", "Inference response does not match the frozen request.");
  }
  return response;
}

function assertSafeCandidateData(
  value: unknown,
  depth: number,
  budget: { nodes: number; stringBytes: number },
): void {
  try {
    assertInertData(value, depth, budget, {
      maxNodes: MAX_CANDIDATE_NODES,
      maxStringBytes: MAX_CANDIDATE_STRING_BYTES,
      maxArrayLength: MAX_CANDIDATE_ARRAY_LENGTH,
      rejectAuthority: true,
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction candidate must be inert JSON data.");
  }
}

export function snapshotInertExtractionInput<T>(value: T): T {
  try {
    assertInertData(value, 0, { nodes: 0, stringBytes: 0 }, {
      maxNodes: MAX_PERSISTENCE_INPUT_NODES,
      maxStringBytes: MAX_PERSISTENCE_INPUT_STRING_BYTES,
      maxArrayLength: 1024,
      rejectAuthority: false,
    });
    return structuredClone(value);
  } catch {
    throw new DomainError(
      "INVALID_EXTRACTION_PERSISTENCE_INPUT",
      "Extraction persistence input must be bounded inert JSON data.",
    );
  }
}

function assertInertData(
  value: unknown,
  depth: number,
  budget: { nodes: number; stringBytes: number },
  limits: { maxNodes: number; maxStringBytes: number; maxArrayLength: number; rejectAuthority: boolean },
): void {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > limits.maxNodes) throw new Error();
  if (typeof value === "string") {
    budget.stringBytes += Buffer.byteLength(value);
    if (budget.stringBytes > limits.maxStringBytes) throw new Error();
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error();
    return;
  }
  if (typeof value !== "object" || types.isProxy(value)) throw new Error();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error();
  if (array && value.length > limits.maxArrayLength) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array) {
    if (Object.keys(descriptors).some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) throw new Error();
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) throw new Error();
    }
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" && array) continue;
    if (!Object.hasOwn(descriptor, "value")) throw new Error();
    budget.stringBytes += Buffer.byteLength(key);
    if (budget.stringBytes > limits.maxStringBytes) throw new Error();
    if (limits.rejectAuthority && FORBIDDEN_KEYS.has(key)) {
      throw new DomainError("EXTRACTION_AUTHORITY_INJECTION", "Model output contains a forbidden authority field.");
    }
    assertInertData(descriptor.value, depth + 1, budget, limits);
  }
}

function validateJson(value: unknown, depth: number): void {
  if (depth > 16) throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction candidate is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction candidate contains a non-finite number.");
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (!plainObject(value)) {
    throw new DomainError("INVALID_EXTRACTION_CANDIDATE", "Extraction candidate must contain JSON values only.");
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new DomainError("EXTRACTION_AUTHORITY_INJECTION", "Model output contains a forbidden authority field.");
    }
    validateJson(item, depth + 1);
  }
}

function exactObject(value: unknown, keys: string[], code: string): asserts value is Record<string, unknown> {
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

function missingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function sameRef(left: StoredObjectRef, right: StoredObjectRef): boolean {
  return left.clinicId === right.clinicId && left.objectId === right.objectId &&
    left.contentSha256 === right.contentSha256 && left.sizeBytes === right.sizeBytes &&
    left.mediaType === right.mediaType;
}

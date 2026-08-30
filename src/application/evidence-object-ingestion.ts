import { createHash } from "node:crypto";

import { assertActorAccess, assertActorContext } from "../domain/access-context.ts";
import type { ActorContext } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { MAX_OBJECT_SIZE_BYTES, type StoredObjectRef } from "../storage/contracts.ts";

const MEDIA_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
const KEY = /^[A-Za-z0-9._:+-]{8,128}$/;
const REF_KEYS = ["clinicId", "objectId", "contentSha256", "sizeBytes", "mediaType"] as const;

export interface EvidenceObjectIngestionInput {
  idempotencyKey: string;
  mediaType: string;
  bytes: Uint8Array;
}

type ObjectStorePutPort = {
  put(context: ActorContext, command: { objectId: string; mediaType: string; bytes: Uint8Array }): Promise<StoredObjectRef>;
};

export class EvidenceObjectIngestionService {
  readonly #objects: ObjectStorePutPort;

  constructor(objects: ObjectStorePutPort) {
    if (!objects || typeof objects.put !== "function") {
      throw new DomainError("INVALID_OBJECT_INGESTION_DEPENDENCY", "Evidence object storage is unavailable.");
    }
    this.#objects = objects;
  }

  async ingest(context: ActorContext, input: EvidenceObjectIngestionInput): Promise<StoredObjectRef> {
    // All caller-controlled values are copied and checked before the storage await.
    let capturedContext: ActorContext;
    try {
      capturedContext = structuredClone(context);
      if (!capturedContext || typeof capturedContext !== "object" || Array.isArray(capturedContext) ||
          Object.getPrototypeOf(capturedContext) !== Object.prototype || Object.keys(capturedContext).length !== 3 ||
          !["actorId", "clinicId", "role"].every((key) => Object.hasOwn(capturedContext, key))) throw new Error();
    } catch {
      throw new DomainError("INVALID_ACTOR_CONTEXT", "ActorContext must contain exact clinic, actor and role values.");
    }
    const capturedInput = snapshotInput(input);
    assertActorContext(capturedContext);
    assertActorAccess(capturedContext, capturedContext.clinicId, "EMPLOYEE");
    if (!KEY.test(capturedInput.idempotencyKey)) {
      throw new DomainError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 8-128 bounded characters.");
    }
    if (!(MEDIA_TYPES as readonly string[]).includes(capturedInput.mediaType)) {
      throw new DomainError("UNSUPPORTED_CONTENT_TYPE", "Evidence media type is not supported.");
    }
    if (capturedInput.bytes.byteLength === 0) {
      throw new DomainError("INVALID_OBJECT_BYTES", "Evidence bytes must not be empty.");
    }
    if (capturedInput.bytes.byteLength > MAX_OBJECT_SIZE_BYTES) {
      throw new DomainError("OBJECT_TOO_LARGE", "Evidence object is too large.");
    }
    const objectId = deriveObjectId(capturedContext, capturedInput.idempotencyKey);
    const ref = await this.#objects.put(capturedContext, {
      objectId,
      mediaType: capturedInput.mediaType,
      bytes: capturedInput.bytes,
    });
    return validateDetachedRef(ref, capturedContext.clinicId, objectId, capturedInput.mediaType, capturedInput.bytes.byteLength);
  }
}

function snapshotInput(value: unknown): EvidenceObjectIngestionInput {
  let input: EvidenceObjectIngestionInput;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).length !== 3 || !Object.keys(value).every((key) => ["bytes", "idempotencyKey", "mediaType"].includes(key))) throw new Error();
    input = value as EvidenceObjectIngestionInput;
    if (typeof input.idempotencyKey !== "string" || typeof input.mediaType !== "string" || !(input.bytes instanceof Uint8Array)) throw new Error();
  } catch {
    throw new DomainError("INVALID_OBJECT_INGESTION_INPUT", "Evidence upload input is invalid.");
  }
  return {
    idempotencyKey: input.idempotencyKey,
    mediaType: input.mediaType,
    bytes: new Uint8Array(input.bytes),
  };
}

export function deriveEvidenceObjectId(context: ActorContext, idempotencyKey: string): string {
  return deriveObjectId(context, idempotencyKey);
}

function deriveObjectId(context: ActorContext, key: string): string {
  const digest = createHash("sha256")
    .update("clinic-os:upload:v1\0", "utf8")
    .update(lengthPrefix(context.clinicId)).update(context.clinicId, "utf8")
    .update(lengthPrefix(context.actorId)).update(context.actorId, "utf8")
    .update(lengthPrefix(key)).update(key, "utf8")
    .digest("hex");
  return `upload-${digest}`;
}

function lengthPrefix(value: string): Buffer {
  const bytes = Buffer.byteLength(value, "utf8");
  return Buffer.from(`${bytes}:`, "ascii");
}

function validateDetachedRef(
  value: unknown,
  clinicId: string,
  objectId: string,
  mediaType: string,
  sizeBytes: number,
): StoredObjectRef {
  let ref: StoredObjectRef;
  try { ref = structuredClone(value) as StoredObjectRef; } catch { throw invalidRef(); }
  if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).length !== REF_KEYS.length ||
      !REF_KEYS.every((key) => Object.hasOwn(ref, key)) || ref.clinicId !== clinicId || ref.objectId !== objectId ||
      ref.mediaType !== mediaType || ref.sizeBytes !== sizeBytes || !/^[a-f0-9]{64}$/.test(ref.contentSha256)) {
    throw invalidRef();
  }
  return structuredClone(ref);
}

function invalidRef(): DomainError {
  return new DomainError("INVALID_OBJECT_STORE_RESPONSE", "Evidence object storage returned an invalid reference.");
}
